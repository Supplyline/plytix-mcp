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
// Captured before any test fakes timers: the yield below must be *real* wall-clock time,
// because crypto.subtle completes on the libuv threadpool — event-loop ticks alone don't
// guarantee it has finished on a cold CI runner.
const realSetTimeout = globalThis.setTimeout;
const yieldRealTime = (ms = 1) => new Promise<void>((resolve) => realSetTimeout(resolve, ms));
async function advance(ms: number, step = 250): Promise<void> {
  let elapsed = 0;
  do {
    const chunk = Math.min(step, ms - elapsed);
    await vi.advanceTimersByTimeAsync(chunk);
    await yieldRealTime();
    elapsed += chunk;
  } while (elapsed < ms);
}
/**
 * Pump zero-time steps until `ready()` holds. The credential digest (`crypto.subtle`) resolves
 * on the real event loop, so how many pumps a request needs before its first fetch depends on
 * the Node version — never assert on fetch counts before settling on it.
 */
async function settle(ready: () => boolean, maxPumps = 2000): Promise<void> {
  for (let i = 0; i < maxPumps && !ready(); i++) await advance(0); // ≤ ~2 s real time
  expect(ready()).toBe(true);
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
    await settle(() => productCalls === 1);
    await advance(900); // first retry is ≥ 1 s out
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
    await settle(() => productCalls === 1);
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
    await settle(() => searchCalls === 1);
    await advance(5000);
    await search;
    expect(searchCalls).toBe(2);

    const patch = client.updateProduct('p1', { label: 'x' }).catch((e: unknown) => e);
    await settle(() => patchCalls === 1);
    expect(await patch).toMatchObject({ status: 502 });
    expect(patchCalls).toBe(1);
  });

  it('shares one bucket per credential pair across instances and learns limits from the cached token', async () => {
    vi.useFakeTimers(FAKE);
    const jwt = jwtWith([{ limit: 2, window_size: 10 }]);
    let productCalls = 0;
    stubFetch(authRoute(jwt), (url) => (productUrl(url) ? (productCalls++, json({ data: [] })) : undefined));

    const first = makeClient();
    await first.searchProducts({});
    expect(first.getRateLimits()).toEqual([{ limit: 2, windowSeconds: 10 }]);

    // Same credentials → token from the module cache, limits learned, and the *same* bucket:
    // floor(2 · 0.8) = 1 per 10 s, and `first` already used that slot.
    const second = new WorkerPlytixClient({
      apiKey: `unit-test-key-${credentialSeq}`,
      apiPassword: `unit-test-password-${credentialSeq}`,
      baseUrl: BASE_URL,
      authUrl: AUTH_URL,
    });
    const pending = second.searchProducts({});
    await settle(() => second.getRateLimits() !== undefined);
    expect(second.getRateLimits()).toEqual([{ limit: 2, windowSeconds: 10 }]);
    await advance(9000);
    expect(productCalls).toBe(1);
    await advance(1500);
    await pending;
    expect(productCalls).toBe(2);
  });

  it('a client that joins an in-flight mint adopts the token and the advertised limits', async () => {
    const jwt = jwtWith([{ limit: 30, window_size: 10 }]);
    let authCalls = 0;
    const { calls } = stubFetch(
      (url) => (url === AUTH_URL ? (authCalls++, json({ data: [{ access_token: jwt, expires_in: 900 }] })) : undefined),
      (url) => (productUrl(url) ? json({ data: [] }) : undefined)
    );

    const a = makeClient();
    const b = new WorkerPlytixClient({
      apiKey: `unit-test-key-${credentialSeq}`,
      apiPassword: `unit-test-password-${credentialSeq}`,
      baseUrl: BASE_URL,
      authUrl: AUTH_URL,
    });
    await Promise.all([a.searchProducts({}), b.searchProducts({})]);

    expect(authCalls).toBe(1);
    expect(a.getRateLimits()).toEqual([{ limit: 30, windowSeconds: 10 }]);
    expect(b.getRateLimits()).toEqual([{ limit: 30, windowSeconds: 10 }]);
    expect(calls.filter(productUrl)).toHaveLength(2);
  });

  it('never evicts a bucket that a live request is pacing against', async () => {
    vi.useFakeTimers(FAKE);
    let hotCalls = 0;
    const hotKey = `hot-key-${Date.now()}`;
    stubFetch(authRoute(), (url, init) => {
      if (!productUrl(url)) return undefined;
      const body = String(init?.body ?? '');
      if (body.includes('"hot"')) {
        hotCalls++;
        return hotCalls === 1 ? json({ limit: 50, window_size: 10, ttl: 5000 }, 429) : json({ data: [] });
      }
      return json({ data: [] });
    });
    const hot = (n: number) =>
      new WorkerPlytixClient({ apiKey: hotKey, apiPassword: `p${n}`, baseUrl: BASE_URL, authUrl: AUTH_URL });

    // The hot account's request is parked on a 5 s penalty…
    const parked = hot(1).searchProducts({ attributes: ['hot'] });
    await settle(() => hotCalls === 1);

    // …while 70 other credential pairs churn through the isolate (cache bound is 64).
    for (let i = 0; i < 70; i++) {
      await makeClient().searchProducts({});
    }

    // A second instance for the hot account must land on the SAME bucket and wait out the penalty.
    const sibling = hot(1).searchProducts({ attributes: ['hot'] });
    await advance(3000);
    expect(hotCalls).toBe(1); // still parked behind the shared 5 s penalty
    await advance(3000);
    await Promise.all([parked, sibling]);
    expect(hotCalls).toBe(3);
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

describe('WorkerPlytixClient attribute cache', () => {
  const UNPACED = { rateLimit: { limit: 10_000, windowMs: 1000 } };

  it('builds from search rows — no per-id GETs, options included', async () => {
    const rows = Array.from({ length: 150 }, (_, i) => ({
      id: `a${i}`,
      label: `label_a${i}`,
      name: `Name a${i}`,
      type_class: i === 0 ? 'DropdownAttribute' : 'TextAttribute',
      ...(i === 0 ? { options: ['Full', 'Standard'] } : {}),
    }));
    let searchCalls = 0;
    const { calls } = stubFetch(authRoute(), (url, init) => {
      if (!url.includes('/api/v1/attributes/product/search')) return undefined;
      searchCalls++;
      const body = JSON.parse(String(init?.body ?? '{}')) as {
        pagination?: { page?: number; page_size?: number };
      };
      const page = body.pagination?.page ?? 1;
      const size = body.pagination?.page_size ?? 100;
      return json({ data: rows.slice((page - 1) * size, page * size) });
    });

    const client = makeClient(UNPACED);
    expect(await client.getAttributeOptions('label_a0')).toEqual(['Full', 'Standard']);
    expect((await client.getAttributeByLabel('label_a149'))?.name).toBe('Name a149');
    expect(searchCalls).toBe(2); // 150 rows at page_size 100
    expect(
      calls.filter((u) => /\/api\/v1\/attributes\/product\/[^/?]+$/.test(u) && !u.includes('/search'))
    ).toHaveLength(0);
  });

  it('surfaces a build failure when most rows have no label', async () => {
    stubFetch(authRoute(), (url) =>
      url.includes('/api/v1/attributes/product/search')
        ? json({ data: [{ id: 'a1' }, { id: 'a2' }, { id: 'a3', label: 'label_a3' }] })
        : undefined
    );

    const client = makeClient(UNPACED);
    await expect(client.getAttributeByLabel('label_a3')).rejects.toThrow(
      /2\/3 attributes returned without a label/
    );
  });
});
