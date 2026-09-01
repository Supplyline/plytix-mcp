/**
 * Plytix rate-limit handling shared by the stdio and Worker clients.
 *
 * Plytix enforces two account-level windows (50 req / 10 s and 5 000 req / h on the
 * accounts we have seen) and advertises them only in the auth JWT
 * (`user_claims.account.rate_limit`) and in the JSON body of a 429 — never in
 * `x-ratelimit-*` response headers. So pacing has to be proactive (token bucket) and
 * backoff has to be schedule-driven, with the body's `ttl` / a `Retry-After` header as
 * a floor when present.
 *
 * This module must stay free of Node-only imports: it is compiled under both the stdio
 * (`lib: DOM`) and Worker (`lib: WebWorker`) tsconfigs.
 */

import {
  PlytixError,
  type RateLimitConfig,
  type RateLimitHit,
  type RateLimitWindow,
} from './types.js';

export type { RateLimitConfig, RateLimitHit, RateLimitWindow };

/** 80% of the 50 req / 10 s cap — the rest is headroom for other consumers of the account. */
export const DEFAULT_RATE_LIMIT: RateLimitConfig = { limit: 40, windowMs: 10_000 };
/** Share of a JWT-advertised window we allow ourselves. */
export const RATE_LIMIT_SHARE = 0.8;
/** Longest single backoff we will sleep inside a tool call; beyond this we fail fast. */
export const MAX_BACKOFF_MS = 15_000;
/** Retries on 429 / retryable 5xx, per request. */
export const MAX_RATE_RETRIES = 3;
/**
 * Longest we will sit in the bucket queue for one request. The hourly window can demand
 * waits of many minutes; inside a tool call that reads as a hang and outlives the token,
 * so past this we fail fast with the time-to-next-slot instead (see plan 008 STOP rules).
 */
export const MAX_ADMISSION_WAIT_MS = 30_000;

export type RetryLogger = (event: string, context: Record<string, unknown>) => void;

// ─────────────────────────────────────────────────────────────
// Parsing
// ─────────────────────────────────────────────────────────────

/** `Retry-After` as delta-seconds or an HTTP-date. Returns milliseconds to wait. */
export function parseRetryAfterHeader(
  value: string | null | undefined,
  nowMs: number = Date.now()
): number | undefined {
  if (!value) return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  if (/^\d+(\.\d+)?$/.test(trimmed)) return Math.max(0, Number(trimmed) * 1000);
  const at = Date.parse(trimmed);
  if (Number.isNaN(at)) return undefined;
  return Math.max(0, at - nowMs);
}

/**
 * Plytix 429 body: `{"message":"API rate limit exceeded","limit":50,"window_size":10}`,
 * sometimes with `ttl` (ms until the next slot). Also accepts free-text
 * `retry after N milliseconds|seconds`.
 */
export function parseRateLimitBody(body: string | null | undefined): RateLimitHit | undefined {
  if (!body) return undefined;
  const hit: RateLimitHit = {};

  try {
    const parsed: unknown = JSON.parse(body);
    if (parsed && typeof parsed === 'object') {
      const record = parsed as Record<string, unknown>;
      if (typeof record.limit === 'number') hit.limit = record.limit;
      if (typeof record.window_size === 'number') hit.windowSeconds = record.window_size;
      if (typeof record.ttl === 'number') hit.retryAfterMs = Math.max(0, record.ttl);
    }
  } catch {
    // not JSON — fall through to the text patterns
  }

  if (hit.retryAfterMs === undefined) {
    const ms = /retry after\s+(\d+)\s+milliseconds?/i.exec(body);
    const seconds = /retry after\s+(\d+(?:\.\d+)?)\s+seconds?/i.exec(body);
    if (ms) hit.retryAfterMs = Number(ms[1]);
    else if (seconds) hit.retryAfterMs = Number(seconds[1]) * 1000;
  }

  return Object.keys(hit).length > 0 ? hit : undefined;
}

/**
 * Delay before retry `attempt` (0-based): the larger of the server's hint and
 * 1 s · 2^attempt, plus up to 1 s of jitter. Returns `null` when that exceeds
 * MAX_BACKOFF_MS — the caller should fail fast rather than sleep the cap and fail anyway.
 */
export function backoffDelayMs(
  attempt: number,
  hit?: RateLimitHit,
  rand: () => number = Math.random
): number | null {
  const scheduled = 1000 * 2 ** attempt;
  const delay = Math.max(hit?.retryAfterMs ?? 0, scheduled) + rand() * 1000;
  return delay > MAX_BACKOFF_MS ? null : Math.round(delay);
}

/** Reads `user_claims.account.rate_limit` from a Plytix access token. Never throws. */
export function decodeJwtRateLimits(jwt: string): RateLimitWindow[] | undefined {
  try {
    const parts = jwt.split('.');
    if (parts.length !== 3) return undefined; // header.payload.signature or nothing
    const claims: unknown = JSON.parse(decodeBase64Url(parts[1]));
    const raw = (claims as { user_claims?: { account?: { rate_limit?: unknown } } })
      ?.user_claims?.account?.rate_limit;
    if (!Array.isArray(raw)) return undefined;
    const windows: RateLimitWindow[] = [];
    for (const entry of raw) {
      const limit = (entry as { limit?: unknown })?.limit;
      const windowSize = (entry as { window_size?: unknown })?.window_size;
      if (isPositiveInteger(limit) && isPositiveInteger(windowSize)) {
        windows.push({ limit, windowSeconds: windowSize });
      }
    }
    return windows.length > 0 ? windows : undefined;
  } catch {
    return undefined;
  }
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 1;
}

/** A usable bucket window: positive finite limit, positive finite duration. */
export function isValidRateLimitConfig(config: RateLimitConfig | undefined): config is RateLimitConfig {
  return (
    !!config &&
    isPositiveInteger(config.limit) &&
    Number.isFinite(config.windowMs) &&
    config.windowMs > 0
  );
}

function decodeBase64Url(segment: string): string {
  const base64 = segment.replace(/-/g, '+').replace(/_/g, '/');
  const padded = base64 + '='.repeat((4 - (base64.length % 4)) % 4);
  const binary = atob(padded);
  const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

/** `"40/10"` → 40 requests per 10 seconds. For the `PLYTIX_RATE_LIMIT` env override. */
export function parseRateLimitSpec(spec: string | undefined): RateLimitConfig | undefined {
  if (!spec) return undefined;
  const match = /^\s*(\d+)\s*\/\s*(\d+(?:\.\d+)?)\s*$/.exec(spec);
  if (!match) return undefined;
  const limit = Number(match[1]);
  const windowMs = Number(match[2]) * 1000;
  if (limit <= 0 || windowMs <= 0) return undefined;
  return { limit, windowMs };
}

/**
 * Bucket configs derived from JWT windows: every window at RATE_LIMIT_SHARE, tightest first.
 * Both windows matter — 40 / 10 s alone would allow 14 400 / h against a 5 000 / h cap.
 */
export function rateLimitConfigsFromWindows(windows: RateLimitWindow[]): RateLimitConfig[] {
  return windows
    .map((w) => ({
      limit: Math.max(1, Math.floor(w.limit * RATE_LIMIT_SHARE)),
      windowMs: w.windowSeconds * 1000,
    }))
    .filter(isValidRateLimitConfig)
    .sort((a, b) => a.windowMs - b.windowMs);
}

/**
 * A 502/503 on a PATCH can mean "applied, response lost" — replaying it re-applies a
 * stale delta. Only GETs and search POSTs are safe to retry on 5xx. 429 is always safe:
 * Plytix did not process the request.
 */
export function isMutation(method: string, path: string): boolean {
  const upper = method.toUpperCase();
  if (upper === 'GET' || upper === 'HEAD') return false;
  const pathname = path.split('?')[0].replace(/\/+$/, '');
  if (upper === 'POST' && pathname.endsWith('/search')) return false;
  return true;
}

// ─────────────────────────────────────────────────────────────
// Token bucket
// ─────────────────────────────────────────────────────────────

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Sliding-window limiter shared by every request a client makes. FIFO: callers are
 * admitted in the order they asked. `penalize` parks *everyone* — one 429 means the
 * account window is blown for all in-flight workers, not just the one that saw it.
 */
export class TokenBucket {
  /** Every admission, newest last. One history serves all windows so reconfiguring never forgets a burst. */
  private stamps: number[] = [];
  private windows: RateLimitConfig[] = [];
  private penaltyUntil = 0;
  private queue: Promise<void> = Promise.resolve();

  constructor(
    config: RateLimitConfig | RateLimitConfig[],
    private readonly now: () => number = Date.now,
    private readonly sleep: (ms: number) => Promise<void> = defaultSleep
  ) {
    this.reconfigure(config);
  }

  /** The tightest window (for logs/tests); see `configs` for all of them. */
  get config(): RateLimitConfig {
    return { ...this.windows[0] };
  }

  get configs(): RateLimitConfig[] {
    return this.windows.map((w) => ({ ...w }));
  }

  /**
   * Resolves when every window has a free slot and no penalty is active. Rejects with a
   * 429-shaped PlytixError (carrying `retryAfterMs`) when the wait would exceed
   * MAX_ADMISSION_WAIT_MS — the caller should surface that, not sit on it.
   */
  take(): Promise<void> {
    const enqueuedAt = this.now(); // the cap covers time spent queued behind others, too
    const turn = this.queue.then(() => this.acquire(enqueuedAt));
    this.queue = turn.catch(() => undefined);
    return turn;
  }

  /** Hold every taker (and `waitForPenalty` callers) until `untilMs`. */
  penalize(untilMs: number): void {
    this.penaltyUntil = Math.max(this.penaltyUntil, untilMs);
  }

  /** For requests that don't count against the bucket (auth) but shouldn't fire into a blown window. */
  async waitForPenalty(): Promise<void> {
    for (;;) {
      const wait = this.penaltyUntil - this.now();
      if (wait <= 0) return;
      await this.sleep(wait); // re-check: the penalty may have been extended while we slept
    }
  }

  /**
   * Replace the windows. Invalid entries are dropped; if nothing valid remains the current
   * configuration (or the default, on construction) is kept — a bad JWT must never turn
   * pacing off or spin it forever. Admission history is kept regardless.
   */
  reconfigure(config: RateLimitConfig | RateLimitConfig[]): void {
    const valid = (Array.isArray(config) ? config : [config])
      .filter(isValidRateLimitConfig)
      .map((w) => ({ limit: w.limit, windowMs: w.windowMs }))
      .sort((a, b) => a.windowMs - b.windowMs);
    if (valid.length > 0) this.windows = valid;
    else if (this.windows.length === 0) this.windows = [{ ...DEFAULT_RATE_LIMIT }];
  }

  private async acquire(enqueuedAt: number): Promise<void> {
    for (;;) {
      const now = this.now();
      const horizon = this.windows[this.windows.length - 1].windowMs;
      this.stamps = this.stamps.filter((stamp) => stamp + horizon > now);

      let wait = this.penaltyUntil - now;
      for (const window of this.windows) {
        const inWindow = this.stamps.filter((stamp) => stamp + window.windowMs > now);
        if (inWindow.length >= window.limit) {
          wait = Math.max(wait, inWindow[0] + window.windowMs - now);
        }
      }
      if (wait <= 0) {
        this.stamps.push(now);
        return;
      }
      // Total residence (already queued + still to wait), not just this sleep: under
      // contention the FIFO turn itself can arrive long after the caller asked.
      if (now - enqueuedAt + wait > MAX_ADMISSION_WAIT_MS) {
        const seconds = Math.ceil(wait / 1000);
        throw new PlytixError(
          `429 rate limit window exhausted locally: next slot in ${seconds}s (cap ${MAX_ADMISSION_WAIT_MS / 1000}s); retry later`,
          429,
          undefined,
          { retryAfterMs: wait }
        );
      }
      await this.sleep(wait);
    }
  }
}

// ─────────────────────────────────────────────────────────────
// Retrying fetch
// ─────────────────────────────────────────────────────────────

export interface RetryingFetchOptions {
  url: string;
  init: RequestInit;
  /** Logged and used for the mutation check. */
  method: string;
  /** Endpoint path (no host), for logs and the mutation check. */
  path: string;
  bucket: TokenBucket;
  timeoutMs: number;
  log: RetryLogger;
  /** When set, a Bearer header is added and one 401 triggers `onUnauthorized` + retry. */
  getToken?: () => Promise<string>;
  onUnauthorized?: () => Promise<void> | void;
  /** Auth requests go to a different host with its own limiter: skip `take()`, still honor penalties. */
  countsAgainstBucket?: boolean;
  /** Override the method/path heuristic (e.g. the idempotent auth POST may retry 5xx). */
  retryServerErrors?: boolean;
  now?: () => number;
  rand?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

/**
 * fetch with Plytix retry policy. Returns the final Response for the caller to interpret
 * (2xx/204/non-retryable error). Throws PlytixError when the 429 budget is exhausted or the
 * server asks for a wait longer than we are willing to block a tool call.
 */
export async function fetchWithRetry(options: RetryingFetchOptions): Promise<Response> {
  const now = options.now ?? Date.now;
  const rand = options.rand ?? Math.random;
  const sleep = options.sleep ?? defaultSleep;
  const countsAgainstBucket = options.countsAgainstBucket ?? true;
  const retryServerErrors =
    options.retryServerErrors ?? !isMutation(options.method, options.path);

  let authRetries = 0;
  let rateRetries = 0;

  for (;;) {
    // Token first so the mint can reconfigure the bucket from the JWT — admission then
    // happens against the account's real windows, not the cold default. If we actually
    // queued, re-read the token afterwards in case it aged out while we waited.
    let token = options.getToken ? await options.getToken() : undefined;
    const queuedAt = now();

    if (countsAgainstBucket) await options.bucket.take();
    else await options.bucket.waitForPenalty();

    if (options.getToken && now() > queuedAt) token = await options.getToken();

    const headers = new Headers(options.init.headers);
    if (token !== undefined) headers.set('Authorization', `Bearer ${token}`);
    if (!headers.has('Content-Type')) headers.set('Content-Type', 'application/json');

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), options.timeoutMs);
    let response: Response;
    try {
      response = await fetch(options.url, { ...options.init, headers, signal: controller.signal });
    } catch (error) {
      clearTimeout(timeout);
      throw error;
    }

    if (response.status === 401 && options.getToken && authRetries < 1) {
      authRetries++;
      try {
        await response.arrayBuffer().catch(() => undefined); // release the connection
      } finally {
        clearTimeout(timeout);
      }
      await options.onUnauthorized?.();
      continue;
    }

    const retryableServerError = response.status >= 500 && retryServerErrors;
    if (response.status !== 429 && !retryableServerError) {
      // The caller reads this body; the per-attempt timeout ends here as it always has.
      clearTimeout(timeout);
      return response;
    }

    // Still under the attempt timeout: a stalled 429/5xx body must not hang the retry loop.
    let body: string;
    try {
      body = await response.text();
    } finally {
      clearTimeout(timeout);
    }
    const hit: RateLimitHit | undefined =
      response.status === 429 ? parseRateLimitBody(body) ?? {} : undefined;
    const headerWait = parseRetryAfterHeader(response.headers.get('Retry-After'), now());
    if (hit && headerWait !== undefined) {
      hit.retryAfterMs = Math.max(hit.retryAfterMs ?? 0, headerWait);
    }

    const context = {
      attempt: rateRetries + 1,
      status: response.status,
      method: options.method,
      endpoint: options.path,
    };

    if (rateRetries >= MAX_RATE_RETRIES) {
      options.log('plytix.retry_aborted', { ...context, reason: 'retries_exhausted' });
      throw rateLimitError(response.status, body, hit, `after ${rateRetries + 1} attempts`);
    }

    const delay = backoffDelayMs(rateRetries, hit ?? { retryAfterMs: headerWait }, rand);
    if (delay === null) {
      const suggestedWaitMs = hit?.retryAfterMs ?? headerWait;
      options.log('plytix.retry_aborted', {
        ...context,
        reason: 'delay_exceeds_cap',
        suggestedWaitMs,
      });
      throw rateLimitError(
        response.status,
        body,
        hit,
        suggestedWaitMs !== undefined
          ? `server asked for a ${Math.ceil(suggestedWaitMs / 1000)}s wait (cap ${MAX_BACKOFF_MS / 1000}s)`
          : `backoff exceeds ${MAX_BACKOFF_MS / 1000}s cap`
      );
    }

    if (response.status === 429) options.bucket.penalize(now() + delay);
    options.log('plytix.retry', { ...context, delayMs: delay });
    await sleep(delay);
    rateRetries++;
  }
}

function rateLimitError(
  status: number,
  body: string,
  hit: RateLimitHit | undefined,
  detail: string
): PlytixError {
  const label = status === 429 ? '429 rate limited' : `${status} upstream error`;
  return new PlytixError(`${label} ${detail}: ${body}`, status, body, hit);
}
