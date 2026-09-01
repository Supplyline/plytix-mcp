/**
 * Safety Gate for Destructive Operations
 *
 * Two-call protection for delete-style tools:
 *
 *   1. The caller invokes the tool with `dry_run: true` and a target
 *      identifier. The gate stores a single-use, tool- and target-scoped
 *      token with a 5-minute TTL and returns it alongside a preview of
 *      what would be deleted.
 *
 *   2. To execute, the caller invokes the same tool again with
 *      `confirm_token` set to that token. `authorizeDelete` validates the
 *      session cap first, then the token (tool match, target match, not
 *      expired, not already used) and consumes it.
 *
 * A session-level cap (`PLYTIX_MCP_MAX_DELETES`, default 3) limits how
 * many deletes one process will perform.
 *
 * WHAT THIS IS AND IS NOT
 * -----------------------
 * The confirm token is returned to the *calling agent*, not to a human.
 * An autonomous agent can read the token from the dry-run response and
 * immediately call again with it. So this is a forced pause with a
 * visible preview and a hard per-process ceiling — NOT a human
 * confirmation gate. It defends against a runaway loop mass-deleting a
 * catalog; it does not defend against an agent that has decided to
 * delete something.
 *
 * Real human confirmation needs the MCP `elicitInput` capability, where
 * the server asks the client to prompt the user. A future revision can
 * elicit when the client advertises that capability and fall back to
 * this token flow when it does not.
 */

const TOKEN_TTL_MS = 5 * 60 * 1000;
const TOKEN_TTL_MINUTES = TOKEN_TTL_MS / 1000 / 60;

/** Session delete cap applied when PLYTIX_MCP_MAX_DELETES is unset or unparseable. */
export const DEFAULT_MAX_DELETES_PER_SESSION = 3;

interface PendingDelete {
  tool: string;
  target: string;
  preview: Record<string, unknown>;
  expires: number;
}

const pending = new Map<string, PendingDelete>();
let sessionDeleteCount = 0;

/**
 * Effective session delete cap.
 *
 * Read from the environment on each call so tests and long-lived
 * processes see changes. A value of 0 disables deletes entirely.
 * Anything unparseable (non-integer, negative) falls back to the default
 * rather than failing, matching how other env options in this server
 * behave.
 */
export function maxDeletesPerSession(): number {
  const raw = process.env.PLYTIX_MCP_MAX_DELETES;
  if (raw === undefined || raw.trim() === '') return DEFAULT_MAX_DELETES_PER_SESSION;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 0) return DEFAULT_MAX_DELETES_PER_SESSION;
  return parsed;
}

/**
 * 128 bits of randomness, hex-encoded.
 *
 * Uses the Web Crypto API rather than `node:crypto` so this module runs
 * unchanged on Node and on Cloudflare Workers.
 */
function generateToken(): string {
  const bytes = new Uint8Array(16);
  globalThis.crypto.getRandomValues(bytes);
  let hex = '';
  for (const byte of bytes) hex += byte.toString(16).padStart(2, '0');
  return hex;
}

function gc(now: number): void {
  for (const [token, entry] of pending.entries()) {
    if (entry.expires <= now) pending.delete(token);
  }
}

/**
 * Whether another delete is permitted in this process.
 */
export function sessionCapAvailable():
  | { ok: true; remaining: number }
  | { ok: false; reason: string } {
  const max = maxDeletesPerSession();
  if (sessionDeleteCount >= max) {
    return {
      ok: false,
      reason:
        max === 0
          ? 'Deletes are disabled (PLYTIX_MCP_MAX_DELETES=0). Raise the limit or use the Plytix UI.'
          : `Session delete cap reached (${sessionDeleteCount}/${max} deletes performed by this MCP process). Restart the server, raise PLYTIX_MCP_MAX_DELETES, or use the Plytix UI for further cleanup.`,
    };
  }
  return { ok: true, remaining: max - sessionDeleteCount };
}

export interface DryRunResult {
  dry_run: true;
  would_delete: Record<string, unknown>;
  confirm_token: string;
  token_expires_in_minutes: number;
  next_step: string;
  session_deletes_remaining: number;
}

/**
 * Issue a dry-run preview plus a confirm token.
 *
 * Returns an error instead when the session cap is already exhausted, so
 * the gate never hands out a token that could not be redeemed.
 */
export function makeDryRunResult(
  tool: string,
  target: string,
  preview: Record<string, unknown>
): { ok: true; result: DryRunResult } | { ok: false; reason: string } {
  const cap = sessionCapAvailable();
  if (!cap.ok) return cap;

  const now = Date.now();
  gc(now);
  const token = generateToken();
  pending.set(token, { tool, target, preview, expires: now + TOKEN_TTL_MS });

  return {
    ok: true,
    result: {
      dry_run: true,
      would_delete: preview,
      confirm_token: token,
      token_expires_in_minutes: TOKEN_TTL_MINUTES,
      next_step: `To execute, call ${tool} again with the same identifier and confirm_token="${token}". Surface this preview to the user and get explicit confirmation before doing so.`,
      session_deletes_remaining: cap.remaining,
    },
  };
}

/**
 * Validate a confirm token and consume it.
 *
 * Only reachable via `authorizeDelete`, which checks the session cap
 * first — consuming a token that the cap would then reject would strand
 * the caller, forcing a fresh dry-run for a delete that still cannot
 * proceed.
 */
function consumeToken(
  tool: string,
  target: string,
  token: string | undefined
): { ok: true; preview: Record<string, unknown> } | { ok: false; reason: string } {
  if (!token) {
    return {
      ok: false,
      reason: `confirm_token required. Call ${tool} with dry_run:true first to get a token, then call again with it. This two-step pattern prevents accidental deletion.`,
    };
  }

  const now = Date.now();
  // Look this token up before sweeping, so an expired token gets the
  // specific "expired" message instead of being collected first and
  // reported as unknown.
  const entry = pending.get(token);
  gc(now);

  if (!entry) {
    return {
      ok: false,
      reason: `Invalid or already-used confirm_token. Tokens are single-use and expire after ${TOKEN_TTL_MINUTES} minutes. Call with dry_run:true for a fresh one.`,
    };
  }
  if (entry.tool !== tool) {
    return {
      ok: false,
      reason: `Token was issued for ${entry.tool}, not ${tool}. Tokens are tool-specific.`,
    };
  }
  if (entry.target !== target) {
    return {
      ok: false,
      reason: `Token was issued for target "${entry.target}" but execution requested "${target}". Tokens are target-specific to prevent replay against a different item.`,
    };
  }
  if (entry.expires <= now) {
    pending.delete(token);
    return {
      ok: false,
      reason: `Token expired. Tokens are valid for ${TOKEN_TTL_MINUTES} minutes. Re-run with dry_run:true.`,
    };
  }

  pending.delete(token);
  return { ok: true, preview: entry.preview };
}

/**
 * Authorize an execute-step delete: session cap first, then the token.
 *
 * Returns the preview captured at dry-run time so callers can log or
 * echo exactly what was approved. On failure nothing is consumed.
 */
export function authorizeDelete(
  tool: string,
  target: string,
  token: string | undefined
): { ok: true; preview: Record<string, unknown> } | { ok: false; reason: string } {
  const cap = sessionCapAvailable();
  if (!cap.ok) return cap;
  return consumeToken(tool, target, token);
}

/**
 * Record a delete that actually removed something.
 *
 * Call only when the API confirmed a deletion — counting no-ops (a 404
 * against an already-gone target) would exhaust the cap without any
 * data having been destroyed.
 */
export function recordDelete(): number {
  sessionDeleteCount += 1;
  return sessionDeleteCount;
}

/** Deletes performed by this process, for inclusion in success responses. */
export function getSessionDeleteCount(): number {
  return sessionDeleteCount;
}
