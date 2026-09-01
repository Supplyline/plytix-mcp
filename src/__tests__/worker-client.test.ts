import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { WorkerPlytixClient } from '../worker-client.js';
import { PlytixError } from '../types.js';

// ─────────────────────────────────────────────────────────────
// The Worker client shares its request loop with the stdio client via
// src/rate-limit.ts; these tests pin the Worker-specific wiring (module token cache,
// per-instance bucket, console.warn logging).
// ─────────────────────────────────────────────────────────────

const AUTH_URL = 'https://auth.example.com/get-token';
const BASE_URL = 'https://pim.example.com';
const RATE_LIMITED = { message: 'API rate limit exceeded', limit: 50, window_size: 10 };

// Fake timers, but leave setImmediate real so crypto.subtle (credential digest, row hashes)
// can complete between steps — otherwise real I/O and fake sleeps deadlock each other.
const FAKE = { toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] as const };
async function advance(ms: number, step = 250): Promise<void> {
  let elapsed = 0;
  do {
    const chunk = Math.min(step, ms - elapsed);
    await vi.advanceTimersByTimeAsync(chunk);
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));
    elapsed += chunk;
  } while (elapsed < ms);
}

// The Worker client caches tokens at module level per credential pair, so every test
// gets its own credentials to stay independent.
let credentialSeq = 0;
function makeClient(overrides: Partial<ConstructorParameters<typeof WorkerPlytixClient>[0]> = {}) {
  credentialSeq++;
  return new WorkerPlytixClient({
    apiKey: `unit-test-key-${credentialSeq}`,
    apiPassword: `unit-test-password-${credentialSeq}`,
    baseUrl: BASE_URL,
    authUrl: AUTH_URL,
    ...overrides,
  });
}

function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...headers },
  });
}

function jwtWith(rateLimit: Array<{ limit: number; window_size: number }> | undefined) {
  const payload = { user_claims: { account: rateLimit ? { rate_limit: rateLimit } : {} } };
  return `hdr.${Buffer.from(JSON.stringify(payload)).toString('base64url')}.sig`;
}

type Route = (url: string, init?: RequestInit) => Response | undefined;

function stubFetch(...routes: Route[]) {
  const calls: string[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      calls.push(url);
      for (const route of routes) {
        const res = route(url, init);
        if (res) return res;
      }
      throw new Error(`Unmatched fetch in test: ${url}`);
    })
  );
  return { calls };
}

const authRoute =
  (jwt = jwtWith(undefined)): Route =>
  (url) =>
    url === AUTH_URL ? json({ data: [{ access_token: jwt, expires_in: 900 }] }) : undefined;
const productUrl = (u: string) => u.includes('/api/v2/products/search');

let warn: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('WorkerPlytixClient rate limiting', () => {
  it('waits before retrying a header-less 429 (regression: worker never backed off)', async () => {
    vi.useFakeTimers(FAKE);
    let productCalls = 0;
    stubFetch(authRoute(), (url) => {
      if (!productUrl(url)) return undefined;
      productCalls++;
      return productCalls === 1 ? json(RATE_LIMITED, 429) : json({ data: [{ id: 'p1' }] });
    });

    const client = makeClient();
    const pending = client.searchProducts({});
    await advance(900);
    expect(productCalls).toBe(1);
    await advance(2000);
    expect((await pending).data?.[0]?.id).toBe('p1');
    expect(productCalls).toBe(2);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('"event":"plytix.retry"'));
  });

  it('gives up after four attempts with the parsed limit attached', async () => {
    vi.useFakeTimers(FAKE);
    let productCalls = 0;
    stubFetch(authRoute(), (url) => {
      if (!productUrl(url)) return undefined;
      productCalls++;
      return json(RATE_LIMITED, 429);
    });

    const client = makeClient();
    const pending = client.searchProducts({}).catch((e: unknown) => e);
    await advance(30_000);
    const error = (await pending) as PlytixError;
    expect(error).toBeInstanceOf(PlytixError);
    expect(error.status).toBe(429);
    expect(error.rateLimit).toEqual({ limit: 50, windowSeconds: 10 });
    expect(productCalls).toBe(4);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('"event":"plytix.retry_aborted"'));
  });

  it('clears the module token cache on 401 and re-mints exactly once', async () => {
    let productCalls = 0;
    const { calls } = stubFetch(authRoute(), (url) => {
      if (!productUrl(url)) return undefined;
      productCalls++;
      return productCalls === 1 ? json({ error: 'expired' }, 401) : json({ data: [{ id: 'p1' }] });
    });

    const client = makeClient();
    expect((await client.searchProducts({})).data?.[0]?.id).toBe('p1');
    expect(productCalls).toBe(2);
    expect(calls.filter((u) => u === AUTH_URL)).toHaveLength(2);
  });

  it('retries 5xx on reads but not on mutations', async () => {
    vi.useFakeTimers(FAKE);
    let searchCalls = 0;
    let patchCalls = 0;
    stubFetch(authRoute(), (url, init) => {
      if (productUrl(url)) {
        searchCalls++;
        return searchCalls === 1 ? json({ error: 'bad gateway' }, 502) : json({ data: [] });
      }
      if (url.includes('/api/v2/products/p1') && init?.method === 'PATCH') {
        patchCalls++;
        return json({ error: 'bad gateway' }, 502);
      }
      return undefined;
    });

    const client = makeClient();
    const search = client.searchProducts({});
    await advance(5000);
    await search;
    expect(searchCalls).toBe(2);

    const patch = client.updateProduct('p1', { label: 'x' }).catch((e: unknown) => e);
    await advance(30_000);
    expect(await patch).toMatchObject({ status: 502 });
    expect(patchCalls).toBe(1);
  });

  it('learns the account windows from the JWT, also when the token came from the module cache', async () => {
    vi.useFakeTimers(FAKE);
    const jwt = jwtWith([{ limit: 2, window_size: 10 }]);
    let productCalls = 0;
    stubFetch(authRoute(jwt), (url) => (productUrl(url) ? (productCalls++, json({ data: [] })) : undefined));

    const first = makeClient();
    await first.searchProducts({});
    expect(first.getRateLimits()).toEqual([{ limit: 2, windowSeconds: 10 }]);

    // Same credentials → token served from the module cache, limits still learned.
    const second = new WorkerPlytixClient({
      apiKey: `unit-test-key-${credentialSeq}`,
      apiPassword: `unit-test-password-${credentialSeq}`,
      baseUrl: BASE_URL,
      authUrl: AUTH_URL,
    });
    const pending = second.searchProducts({});
    await advance(0);
    expect(second.getRateLimits()).toEqual([{ limit: 2, windowSeconds: 10 }]);
    await pending;

    // floor(2 · 0.8) = 1 per 10 s on `second`'s own bucket → its next call waits
    const third = second.searchProducts({});
    const before = productCalls;
    await advance(9000);
    expect(productCalls).toBe(before);
    await advance(1500);
    await third;
    expect(productCalls).toBe(before + 1);
  });

  it('explicit rateLimit config wins over the JWT', async () => {
    vi.useFakeTimers(FAKE);
    let productCalls = 0;
    stubFetch(authRoute(jwtWith([{ limit: 2, window_size: 10 }])), (url) =>
      productUrl(url) ? (productCalls++, json({ data: [] })) : undefined
    );
    const client = makeClient({ rateLimit: { limit: 40, windowMs: 10_000 } });
    await client.searchProducts({});
    await client.searchProducts({});
    expect(productCalls).toBe(2);
  });
});
