import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  TokenBucket,
  backoffDelayMs,
  decodeJwtRateLimits,
  fetchWithRetry,
  isMutation,
  parseRateLimitBody,
  parseRetryAfterHeader,
  rateLimitConfigFromWindows,
  MAX_BACKOFF_MS,
} from '../rate-limit.js';
import { PlytixError } from '../types.js';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

// ─────────────────────────────────────────────────────────────
// Parsing
// ─────────────────────────────────────────────────────────────

describe('parseRateLimitBody', () => {
  it('reads the Plytix JSON shape with and without ttl', () => {
    expect(
      parseRateLimitBody('{"message":"API rate limit exceeded","limit":50,"window_size":10}')
    ).toEqual({ limit: 50, windowSeconds: 10 });
    expect(parseRateLimitBody('{"limit":50,"requests":51,"ttl":1083}')).toEqual({
      limit: 50,
      retryAfterMs: 1083,
    });
  });

  it('reads free-text retry hints', () => {
    expect(parseRateLimitBody('Too many requests, retry after 1500 milliseconds')).toEqual({
      retryAfterMs: 1500,
    });
    expect(parseRateLimitBody('retry after 2 seconds')).toEqual({ retryAfterMs: 2000 });
  });

  it('returns undefined for empty or unrelated bodies', () => {
    expect(parseRateLimitBody('')).toBeUndefined();
    expect(parseRateLimitBody('<html>gateway</html>')).toBeUndefined();
    expect(parseRateLimitBody('{"error":"nope"}')).toBeUndefined();
  });
});

describe('parseRetryAfterHeader', () => {
  it('handles delta-seconds, HTTP-dates, and junk', () => {
    const now = Date.UTC(2026, 8, 1, 12, 0, 0);
    expect(parseRetryAfterHeader('3', now)).toBe(3000);
    expect(parseRetryAfterHeader(new Date(now + 5000).toUTCString(), now)).toBe(5000);
    expect(parseRetryAfterHeader('soon', now)).toBeUndefined();
    expect(parseRetryAfterHeader(null, now)).toBeUndefined();
  });
});

describe('backoffDelayMs', () => {
  const noJitter = () => 0;

  it('doubles per attempt and caps at MAX_BACKOFF_MS', () => {
    expect(backoffDelayMs(0, undefined, noJitter)).toBe(1000);
    expect(backoffDelayMs(1, undefined, noJitter)).toBe(2000);
    expect(backoffDelayMs(2, undefined, noJitter)).toBe(4000);
    expect(backoffDelayMs(3, undefined, noJitter)).toBe(8000);
    expect(backoffDelayMs(4, undefined, noJitter)).toBeNull(); // 16 s > cap
  });

  it('uses the server hint as a floor and refuses hints past the cap', () => {
    expect(backoffDelayMs(0, { retryAfterMs: 3000 }, noJitter)).toBe(3000);
    expect(backoffDelayMs(2, { retryAfterMs: 3000 }, noJitter)).toBe(4000);
    expect(backoffDelayMs(0, { retryAfterMs: MAX_BACKOFF_MS + 1 }, noJitter)).toBeNull();
  });

  it('adds at most one second of jitter', () => {
    expect(backoffDelayMs(0, undefined, () => 0.999)).toBe(1999);
  });
});

describe('decodeJwtRateLimits', () => {
  const encode = (payload: unknown) =>
    Buffer.from(JSON.stringify(payload)).toString('base64url');
  const jwt = (payload: unknown) => `hdr.${encode(payload)}.sig`;

  it('reads both windows from a real-shaped payload', () => {
    // Find a filler that makes the base64url payload contain '-' or '_' so the
    // url→standard alphabet translation is actually exercised.
    let token = '';
    for (let n = 0; n < 128 && !/[-_]/.test(token); n++) {
      token = jwt({
        sub: 'u',
        user_claims: {
          user: { name: 'Claude', filler: '~?>'.repeat(n) },
          account: {
            name: 'Supplyline ~ test',
            rate_limit: [
              { limit: 50, window_size: 10 },
              { limit: 5000, window_size: 3600 },
            ],
          },
        },
      });
    }
    expect(token).toMatch(/[-_]/);
    expect(decodeJwtRateLimits(token)).toEqual([
      { limit: 50, windowSeconds: 10 },
      { limit: 5000, windowSeconds: 3600 },
    ]);
  });

  it('returns undefined when the claim is absent, malformed, or not a JWT', () => {
    expect(decodeJwtRateLimits(jwt({ user_claims: { account: {} } }))).toBeUndefined();
    expect(decodeJwtRateLimits(jwt({ user_claims: { account: { rate_limit: 'x' } } }))).toBeUndefined();
    expect(decodeJwtRateLimits('not-a-jwt')).toBeUndefined();
    expect(decodeJwtRateLimits('a.!!!.c')).toBeUndefined();
  });
});

describe('rateLimitConfigFromWindows', () => {
  it('takes 80% of the tightest window', () => {
    expect(
      rateLimitConfigFromWindows([
        { limit: 5000, windowSeconds: 3600 },
        { limit: 50, windowSeconds: 10 },
      ])
    ).toEqual({ limit: 40, windowMs: 10_000 });
    expect(rateLimitConfigFromWindows([])).toBeUndefined();
  });
});

describe('isMutation', () => {
  it('treats GET and search POSTs as reads, everything else as writes', () => {
    expect(isMutation('GET', '/api/v2/products/x')).toBe(false);
    expect(isMutation('POST', '/api/v2/products/search')).toBe(false);
    expect(isMutation('POST', '/api/v1/assets/search?x=1')).toBe(false);
    expect(isMutation('POST', '/api/v2/products')).toBe(true);
    expect(isMutation('PATCH', '/api/v2/products/x')).toBe(true);
    expect(isMutation('DELETE', '/api/v2/products/x')).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────
// TokenBucket
// ─────────────────────────────────────────────────────────────

describe('TokenBucket', () => {
  function makeBucket(limit: number, windowMs: number) {
    let now = 0;
    const sleeps: number[] = [];
    const bucket = new TokenBucket(
      limit,
      windowMs,
      () => now,
      async (ms) => {
        sleeps.push(ms);
        now += ms;
      }
    );
    return { bucket, sleeps, advance: (ms: number) => (now += ms), time: () => now };
  }

  it('admits `limit` callers immediately and holds the next until the window slides', async () => {
    const { bucket, sleeps } = makeBucket(40, 10_000);
    for (let i = 0; i < 40; i++) await bucket.take();
    expect(sleeps).toEqual([]);

    await bucket.take(); // 41st
    expect(sleeps).toEqual([10_000]);
  });

  it('slides rather than resets', async () => {
    const { bucket, sleeps, advance, time } = makeBucket(40, 10_000);
    for (let i = 0; i < 20; i++) await bucket.take(); // t = 0
    advance(5000);
    for (let i = 0; i < 20; i++) await bucket.take(); // t = 5000, bucket full

    await bucket.take(); // waits for the t=0 batch → t = 10 000
    expect(time()).toBe(10_000);
    for (let i = 0; i < 19; i++) await bucket.take(); // fill again
    await bucket.take(); // waits for the t=5000 batch, not a full window
    expect(time()).toBe(15_000);
    expect(sleeps).toEqual([5000, 5000]); // each wait is for the oldest batch to age out
  });

  it('penalize parks new takers and waitForPenalty callers', async () => {
    const { bucket, sleeps, time } = makeBucket(40, 10_000);
    bucket.penalize(5000);
    await bucket.take();
    expect(sleeps).toEqual([5000]);
    expect(time()).toBe(5000);
    bucket.penalize(7000);
    await bucket.waitForPenalty();
    expect(sleeps).toEqual([5000, 2000]);
  });

  it('is FIFO under contention', async () => {
    vi.useFakeTimers();
    const bucket = new TokenBucket(1, 1000);
    const order: string[] = [];
    const a = bucket.take().then(() => order.push('a'));
    const b = bucket.take().then(() => order.push('b'));
    const c = bucket.take().then(() => order.push('c'));
    await vi.advanceTimersByTimeAsync(3000);
    await Promise.all([a, b, c]);
    expect(order).toEqual(['a', 'b', 'c']);
  });

  it('reconfigure applies on the next take', async () => {
    const { bucket, sleeps } = makeBucket(40, 10_000);
    for (let i = 0; i < 5; i++) await bucket.take();
    bucket.reconfigure({ limit: 5, windowMs: 10_000 });
    expect(bucket.config).toEqual({ limit: 5, windowMs: 10_000 });
    await bucket.take();
    expect(sleeps).toEqual([10_000]);
  });
});

// ─────────────────────────────────────────────────────────────
// fetchWithRetry
// ─────────────────────────────────────────────────────────────

describe('fetchWithRetry', () => {
  const URL = 'https://pim.example.com/api/v2/products/search';

  function harness(responses: Array<() => Response>) {
    const fetchMock = vi.fn(async () => {
      const next = responses.shift();
      if (!next) throw new Error('fetch called more times than scripted');
      return next();
    });
    vi.stubGlobal('fetch', fetchMock);
    const logs: Array<[string, Record<string, unknown>]> = [];
    const sleeps: number[] = [];
    let now = 1_000_000;
    const bucket = new TokenBucket(40, 10_000, () => now, async (ms) => {
      sleeps.push(ms);
      now += ms;
    });
    const run = (overrides: Partial<Parameters<typeof fetchWithRetry>[0]> = {}) =>
      fetchWithRetry({
        url: URL,
        init: { method: 'POST', body: '{}' },
        method: 'POST',
        path: '/api/v2/products/search',
        bucket,
        timeoutMs: 1000,
        log: (event, context) => logs.push([event, context]),
        now: () => now,
        rand: () => 0,
        sleep: async (ms) => {
          sleeps.push(ms);
          now += ms;
        },
        ...overrides,
      });
    return { fetchMock, logs, sleeps, bucket, run, time: () => now };
  }

  const res = (status: number, body: unknown = {}, headers: Record<string, string> = {}) =>
    () => new Response(JSON.stringify(body), { status, headers });

  it('waits and retries a header-less 429, then succeeds', async () => {
    const { run, fetchMock, sleeps, logs } = harness([
      res(429, { message: 'API rate limit exceeded', limit: 50, window_size: 10 }),
      res(200, { data: [] }),
    ]);
    const response = await run();
    expect(response.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(sleeps).toEqual([1000]); // schedule, no jitter
    expect(logs).toEqual([
      [
        'plytix.retry',
        { attempt: 1, status: 429, method: 'POST', endpoint: '/api/v2/products/search', delayMs: 1000 },
      ],
    ]);
  });

  it('exhausts the budget after 4 attempts and attaches the hit', async () => {
    const body = { message: 'API rate limit exceeded', limit: 50, window_size: 10 };
    const { run, fetchMock, sleeps, logs } = harness([res(429, body), res(429, body), res(429, body), res(429, body)]);
    const error = await run().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(PlytixError);
    expect((error as PlytixError).status).toBe(429);
    expect((error as PlytixError).rateLimit).toEqual({ limit: 50, windowSeconds: 10 });
    expect((error as PlytixError).message).toMatch(/^429 rate limited after 4 attempts/);
    expect(fetchMock).toHaveBeenCalledTimes(4);
    expect(sleeps).toEqual([1000, 2000, 4000]);
    expect(logs.at(-1)?.[0]).toBe('plytix.retry_aborted');
    expect(logs.at(-1)?.[1]).toMatchObject({ reason: 'retries_exhausted', attempt: 4 });
  });

  it('honors a body ttl as a floor and a Retry-After header', async () => {
    const { run, sleeps } = harness([res(429, { limit: 50, ttl: 3000 }), res(200)]);
    await run();
    expect(sleeps).toEqual([3000]);

    const second = harness([res(429, { limit: 50 }, { 'Retry-After': '2' }), res(200)]);
    await second.run();
    expect(second.sleeps).toEqual([2000]);
  });

  it('fails fast when the server asks for a wait past the cap', async () => {
    const { run, fetchMock, sleeps, logs } = harness([res(429, { limit: 50 }, { 'Retry-After': '20' })]);
    const error = await run().catch((e: unknown) => e);
    expect((error as PlytixError).message).toMatch(/server asked for a 20s wait/);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(sleeps).toEqual([]);
    expect(logs[0]).toEqual([
      'plytix.retry_aborted',
      expect.objectContaining({ reason: 'delay_exceeds_cap', suggestedWaitMs: 20_000 }),
    ]);
  });

  it('a 429 penalizes the shared bucket for everyone', async () => {
    const { run, bucket, time } = harness([res(429, { limit: 50 }), res(200)]);
    await run();
    // penalty was set to now+1000 at the time of the 429; the sleep advanced the clock to it
    const before = time();
    await bucket.take();
    expect(time()).toBe(before); // penalty already elapsed exactly at retry time, no extra wait
    // A fresh 429 with a longer hint parks a concurrent taker
    const second = harness([res(429, { limit: 50, ttl: 4000 }), res(200)]);
    const inFlight = second.run();
    await inFlight;
    expect(second.sleeps).toEqual([4000]);
  });

  it('refreshes once on 401, then surfaces a second 401 unchanged', async () => {
    const onUnauthorized = vi.fn();
    const { run, fetchMock } = harness([res(401), res(401)]);
    const response = await run({ getToken: async () => 'tok', onUnauthorized });
    expect(response.status).toBe(401);
    expect(onUnauthorized).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('retries 5xx on reads but not on mutations', async () => {
    const reads = harness([res(502, 'bad gateway'), res(200)]);
    expect((await reads.run()).status).toBe(200);
    expect(reads.sleeps).toEqual([1000]);
    expect(reads.bucket.config).toBeDefined();

    const writes = harness([res(502, 'bad gateway')]);
    const response = await writes.run({ method: 'PATCH', path: '/api/v2/products/x' });
    expect(response.status).toBe(502);
    expect(writes.fetchMock).toHaveBeenCalledTimes(1);
    expect(writes.sleeps).toEqual([]);
  });

  it('auth-style calls skip the bucket but honor the penalty', async () => {
    const { run, bucket, sleeps } = harness([res(200)]);
    bucket.penalize(1_000_000 + 2500);
    await run({ countsAgainstBucket: false });
    expect(sleeps).toEqual([2500]);
  });
});
