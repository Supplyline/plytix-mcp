import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { PlytixClient } from '../client.js';
import { PlytixError } from '../types.js';

// ─────────────────────────────────────────────────────────────
// Test harness: routed fetch mock
// ─────────────────────────────────────────────────────────────

const AUTH_URL = 'https://auth.example.com/get-token';
const BASE_URL = 'https://pim.example.com';

function makeClient(overrides: Partial<ConstructorParameters<typeof PlytixClient>[0]> = {}) {
  return new PlytixClient({
    apiKey: 'unit-test-key',
    apiPassword: 'unit-test-password',
    baseUrl: BASE_URL,
    authUrl: AUTH_URL,
    ...overrides,
  });
}

/** Tests that exercise request *volume* opt out of pacing so they don't sit in the bucket. */
const UNPACED = { rateLimit: { limit: 10_000, windowMs: 1000 } };

function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...headers },
  });
}

function tokenResponse(expiresIn = 900): Response {
  return json({ data: [{ access_token: 'tok-1', expires_in: expiresIn }] });
}

type Route = (url: string, init?: RequestInit) => Response | Promise<Response> | undefined;

/** Install a fetch mock that tries routes in order; throws on unmatched URLs. */
function stubFetch(...routes: Route[]) {
  const calls: string[] = [];
  const mock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push(url);
    for (const route of routes) {
      const res = await route(url, init);
      if (res) return res;
    }
    throw new Error(`Unmatched fetch in test: ${url}`);
  });
  vi.stubGlobal('fetch', mock);
  return { mock, calls };
}

const authRoute =
  (expiresIn = 900): Route =>
  (url) =>
    url === AUTH_URL ? tokenResponse(expiresIn) : undefined;

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

// ─────────────────────────────────────────────────────────────
// Token lifecycle
// ─────────────────────────────────────────────────────────────

describe('PlytixClient token lifecycle', () => {
  it('fetches the token once and reuses it while valid', async () => {
    const { calls } = stubFetch(authRoute(900), (url) =>
      url.includes('/api/v2/products/search') ? json({ data: [] }) : undefined
    );

    const client = makeClient();
    await client.searchProducts({});
    await client.searchProducts({});

    expect(calls.filter((u) => u === AUTH_URL)).toHaveLength(1);
    expect(calls.filter((u) => u.includes('/products/search'))).toHaveLength(2);
  });

  it('refreshes the token when within the 60s safety margin', async () => {
    // expires_in 30s < 60s margin → every call re-authenticates
    const { calls } = stubFetch(authRoute(30), (url) =>
      url.includes('/api/v2/products/search') ? json({ data: [] }) : undefined
    );

    const client = makeClient();
    await client.searchProducts({});
    await client.searchProducts({});

    expect(calls.filter((u) => u === AUTH_URL)).toHaveLength(2);
  });

  it('clears the token and retries once on 401', async () => {
    let productCalls = 0;
    const { calls } = stubFetch(authRoute(), (url) => {
      if (!url.includes('/api/v2/products/search')) return undefined;
      productCalls++;
      return productCalls === 1 ? json({ error: 'expired' }, 401) : json({ data: [{ id: 'p1' }] });
    });

    const client = makeClient();
    const result = await client.searchProducts({});

    expect(result.data?.[0]?.id).toBe('p1');
    // auth, 401 request, re-auth (token cleared), successful retry
    expect(calls.filter((u) => u === AUTH_URL)).toHaveLength(2);
    expect(productCalls).toBe(2);
  });

  it('backs off and retries once on 429 with rate-limit headers', async () => {
    vi.useFakeTimers();
    let productCalls = 0;
    stubFetch(authRoute(), (url) => {
      if (!url.includes('/api/v2/products/search')) return undefined;
      productCalls++;
      if (productCalls === 1) {
        return json({ error: 'rate limited' }, 429, {
          'x-ratelimit-limit': '10',
          'x-ratelimit-remaining': '0',
          'x-ratelimit-reset': String(Math.floor(Date.now() / 1000) + 1),
        });
      }
      return json({ data: [{ id: 'p1' }] });
    });

    const client = makeClient();
    const pending = client.searchProducts({});
    await vi.advanceTimersByTimeAsync(3000); // covers the >=1s backoff
    const result = await pending;

    expect(result.data?.[0]?.id).toBe('p1');
    expect(productCalls).toBe(2);
  });
});

// ─────────────────────────────────────────────────────────────
// Product filter discovery — /filters/product response shapes
// ─────────────────────────────────────────────────────────────

describe('PlytixClient getProductAttributes', () => {
  const FILTER_DEFS = [
    { key: 'sku', filter_type: 'TextAttribute' },
    { key: 'status', filter_type: 'Dropdown' },
    { key: 'attributes.head_material', filter_type: 'Dropdown' },
  ];

  it('parses the legacy shape (definitions directly in data)', async () => {
    stubFetch(authRoute(), (url) =>
      url.includes('/api/v1/filters/product') ? json({ data: FILTER_DEFS }) : undefined
    );

    const result = await makeClient().getProductAttributes();

    expect(result.system).toEqual(['sku', 'status']);
    expect(result.custom.map((f) => f.key)).toEqual(['attributes.head_material']);
  });

  it('parses the wrapped shape (data[0].attributes, observed 2026-08)', async () => {
    stubFetch(authRoute(), (url) =>
      url.includes('/api/v1/filters/product')
        ? json({ data: [{ attributes: FILTER_DEFS }] })
        : undefined
    );

    const result = await makeClient().getProductAttributes();

    expect(result.system).toEqual(['sku', 'status']);
    expect(result.custom.map((f) => f.key)).toEqual(['attributes.head_material']);
  });
});

// ─────────────────────────────────────────────────────────────
// Attribute pagination + cache build
// ─────────────────────────────────────────────────────────────

function attrSearchRoute(ids: string[], pageSize = 100): Route {
  return async (url, init) => {
    if (!url.includes('/api/v1/attributes/product/search')) return undefined;
    const body = JSON.parse(String(init?.body ?? '{}')) as {
      pagination?: { page?: number; page_size?: number };
    };
    const page = body.pagination?.page ?? 1;
    const size = body.pagination?.page_size ?? pageSize;
    const slice = ids.slice((page - 1) * size, page * size);
    return json({ data: slice.map((id) => ({ id })) });
  };
}

function attrDetailRoute(
  detail: (id: string) => { label?: string } | 'fail'
): Route {
  return (url) => {
    const m = url.match(/\/api\/v1\/attributes\/product\/([^/?]+)$/);
    if (!m || url.includes('/search')) return undefined;
    const result = detail(m[1]);
    // 422, not 5xx: a 5xx on a GET is now retried with real backoff, which is not what
    // these tests are about.
    if (result === 'fail') return json({ error: 'boom' }, 422);
    return json({ data: [{ id: m[1], ...result }] });
  };
}

describe('PlytixClient attribute cache', () => {
  it('caps pagination at MAX_PAGES (50) even if the API never returns a short page', async () => {
    // Every page is full → without the cap this would loop forever.
    const ids = Array.from({ length: 100 }, (_, i) => `id${i}`);
    const { calls } = stubFetch(authRoute(), (url) =>
      url.includes('/api/v1/attributes/product/search')
        ? json({ data: ids.map((id) => ({ id })) }) // always full
        : undefined
    );

    const client = makeClient(UNPACED);
    const result = await client.searchAttributeIds();

    expect(result).toHaveLength(50 * 100);
    expect(calls.filter((u) => u.includes('/attributes/product/search'))).toHaveLength(50);
  });

  it('deduplicates concurrent cache builds (one search pass for parallel callers)', async () => {
    const ids = ['a1', 'a2'];
    const { calls } = stubFetch(
      authRoute(),
      attrSearchRoute(ids),
      attrDetailRoute((id) => ({ label: `label_${id}` }))
    );

    const client = makeClient(UNPACED);
    const [a, b] = await Promise.all([
      client.getAttributeByLabel('label_a1'),
      client.getAttributeByLabel('label_a2'),
    ]);

    expect(a?.label).toBe('label_a1');
    expect(b?.label).toBe('label_a2');
    expect(calls.filter((u) => u.includes('/attributes/product/search'))).toHaveLength(1);
  });

  it('throws PlytixError when more than 20% of detail fetches fail', async () => {
    const ids = ['a1', 'a2', 'a3', 'a4', 'a5'];
    stubFetch(
      authRoute(),
      attrSearchRoute(ids),
      attrDetailRoute((id) => (id === 'a1' || id === 'a2' ? 'fail' : { label: `label_${id}` }))
    );

    const client = makeClient(UNPACED);
    await expect(client.getAttributeByLabel('label_a3')).rejects.toThrow(PlytixError);
    await expect(client.getAttributeByLabel('label_a3')).rejects.toThrow(
      /Attribute cache build failed/
    );
  });

  it('fetches attribute details in batches of at most 10', async () => {
    const ids = Array.from({ length: 25 }, (_, i) => `a${i}`);
    let inFlight = 0;
    let maxInFlight = 0;
    stubFetch(authRoute(), attrSearchRoute(ids), async (url) => {
      const m = url.match(/\/api\/v1\/attributes\/product\/(a\d+)$/);
      if (!m) return undefined;
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      // A macrotask, not a microtask: bucket admission is a FIFO promise chain, so
      // siblings need a real tick to all reach fetch().
      await new Promise((resolve) => setTimeout(resolve, 0));
      inFlight--;
      return json({ data: [{ id: m[1], label: `label_${m[1]}` }] });
    });

    const client = makeClient(UNPACED);
    const attr = await client.getAttributeByLabel('label_a0');

    expect(attr?.label).toBe('label_a0');
    expect(maxInFlight).toBeGreaterThan(1);
    expect(maxInFlight).toBeLessThanOrEqual(10);
  });

  it('throws PlytixError when the account has no attributes at all', async () => {
    stubFetch(authRoute(), attrSearchRoute([]));

    const client = makeClient(UNPACED);
    await expect(client.getAttributeByLabel('anything')).rejects.toThrow(
      /no attributes found/
    );
  });
});

// ─────────────────────────────────────────────────────────────
// Rate limiting — Plytix sends no x-ratelimit-* headers; the 429 body is all we get
// ─────────────────────────────────────────────────────────────

describe('PlytixClient rate limiting', () => {
  const RATE_LIMITED = { message: 'API rate limit exceeded', limit: 50, window_size: 10 };
  const productUrl = (u: string) => u.includes('/api/v2/products/search');

  /** JWT whose payload advertises the given windows (signature is irrelevant to the client). */
  function jwtWith(rateLimit: Array<{ limit: number; window_size: number }> | undefined) {
    const payload = { user_claims: { account: rateLimit ? { rate_limit: rateLimit } : {} } };
    return `hdr.${Buffer.from(JSON.stringify(payload)).toString('base64url')}.sig`;
  }
  const authRouteWithJwt =
    (jwt: string): Route =>
    (url) =>
      url === AUTH_URL ? json({ data: [{ access_token: jwt, expires_in: 900 }] }) : undefined;

  let stderr: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    stderr = vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  it('waits before retrying a header-less 429 (regression: used to retry instantly)', async () => {
    vi.useFakeTimers();
    let productCalls = 0;
    stubFetch(authRoute(), (url) => {
      if (!productUrl(url)) return undefined;
      productCalls++;
      return productCalls === 1 ? json(RATE_LIMITED, 429) : json({ data: [{ id: 'p1' }] });
    });

    const client = makeClient();
    const pending = client.searchProducts({});
    await vi.advanceTimersByTimeAsync(900); // schedule is ≥ 1 s for the first retry
    expect(productCalls).toBe(1);
    await vi.advanceTimersByTimeAsync(2000);
    const result = await pending;

    expect(result.data?.[0]?.id).toBe('p1');
    expect(productCalls).toBe(2);
    expect(stderr).toHaveBeenCalledWith(expect.stringContaining('"event":"plytix.retry"'));
  });

  it('gives up after four attempts and attaches the parsed limit', async () => {
    vi.useFakeTimers();
    let productCalls = 0;
    stubFetch(authRoute(), (url) => {
      if (!productUrl(url)) return undefined;
      productCalls++;
      return json(RATE_LIMITED, 429);
    });

    const client = makeClient();
    const pending = client.searchProducts({}).catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(30_000);
    const error = (await pending) as PlytixError;

    expect(error).toBeInstanceOf(PlytixError);
    expect(error.status).toBe(429);
    expect(error.message).toMatch(/^429 rate limited after 4 attempts/);
    expect(error.rateLimit).toEqual({ limit: 50, windowSeconds: 10 });
    expect(productCalls).toBe(4);
    expect(stderr).toHaveBeenCalledWith(expect.stringContaining('"event":"plytix.retry_aborted"'));
  });

  it('fails fast when Retry-After asks for more than the cap', async () => {
    let productCalls = 0;
    stubFetch(authRoute(), (url) => {
      if (!productUrl(url)) return undefined;
      productCalls++;
      return json(RATE_LIMITED, 429, { 'Retry-After': '20' });
    });

    const client = makeClient();
    await expect(client.searchProducts({})).rejects.toThrow(/server asked for a 20s wait/);
    expect(productCalls).toBe(1);
  });

  it('a 429 parks requests issued afterwards until the penalty elapses', async () => {
    vi.useFakeTimers();
    let productCalls = 0;
    stubFetch(authRoute(), (url) => {
      if (!productUrl(url)) return undefined;
      productCalls++;
      return productCalls === 1 ? json({ ...RATE_LIMITED, ttl: 5000 }, 429) : json({ data: [] });
    });

    const client = makeClient();
    const first = client.searchProducts({});
    await vi.advanceTimersByTimeAsync(0); // let the 429 land and the penalty be set
    expect(productCalls).toBe(1);

    const second = client.searchProducts({});
    await vi.advanceTimersByTimeAsync(4000);
    expect(productCalls).toBe(1); // second call is parked behind the 5 s penalty
    await vi.advanceTimersByTimeAsync(3000);
    await Promise.all([first, second]);
    expect(productCalls).toBe(3);
  });

  it('refreshes the token exactly once on 401 and surfaces a second 401', async () => {
    let productCalls = 0;
    const { calls } = stubFetch(authRoute(), (url) => {
      if (!productUrl(url)) return undefined;
      productCalls++;
      return json({ error: 'expired' }, 401);
    });

    const client = makeClient();
    await expect(client.searchProducts({})).rejects.toMatchObject({ status: 401 });
    expect(productCalls).toBe(2);
    expect(calls.filter((u) => u === AUTH_URL)).toHaveLength(2);
  });

  it('retries 5xx on reads but not on mutations', async () => {
    vi.useFakeTimers();
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
    await vi.advanceTimersByTimeAsync(5000);
    await search;
    expect(searchCalls).toBe(2);

    const patch = client.updateProduct('p1', { label: 'x' }).catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(await patch).toMatchObject({ status: 502 });
    expect(patchCalls).toBe(1);
  });

  it('retries a rate-limited auth mint', async () => {
    vi.useFakeTimers();
    let authCalls = 0;
    stubFetch(
      (url) => {
        if (url !== AUTH_URL) return undefined;
        authCalls++;
        return authCalls === 1 ? json(RATE_LIMITED, 429) : tokenResponse();
      },
      (url) => (productUrl(url) ? json({ data: [{ id: 'p1' }] }) : undefined)
    );

    const client = makeClient();
    const pending = client.searchProducts({});
    await vi.advanceTimersByTimeAsync(5000);
    expect((await pending).data?.[0]?.id).toBe('p1');
    expect(authCalls).toBe(2);
  });

  it('learns the account windows from the JWT and paces to 80% of the tightest', async () => {
    vi.useFakeTimers();
    let productCalls = 0;
    stubFetch(
      authRouteWithJwt(jwtWith([{ limit: 2, window_size: 10 }, { limit: 5000, window_size: 3600 }])),
      (url) => (productUrl(url) ? (productCalls++, json({ data: [] })) : undefined)
    );

    const client = makeClient();
    await client.searchProducts({});
    expect(client.getRateLimits()).toEqual([
      { limit: 2, windowSeconds: 10 },
      { limit: 5000, windowSeconds: 3600 },
    ]);

    // floor(2 · 0.8) = 1 per 10 s → the second call must wait for the first to age out
    const second = client.searchProducts({});
    await vi.advanceTimersByTimeAsync(9000);
    expect(productCalls).toBe(1);
    await vi.advanceTimersByTimeAsync(1500);
    await second;
    expect(productCalls).toBe(2);
  });

  it('keeps the default pacing when the JWT carries no windows, and lets explicit config win', async () => {
    vi.useFakeTimers();
    stubFetch(authRouteWithJwt(jwtWith(undefined)), (url) =>
      productUrl(url) ? json({ data: [] }) : undefined
    );
    const client = makeClient();
    await client.searchProducts({});
    expect(client.getRateLimits()).toBeUndefined();

    vi.unstubAllGlobals();
    let productCalls = 0;
    stubFetch(authRouteWithJwt(jwtWith([{ limit: 2, window_size: 10 }])), (url) =>
      productUrl(url) ? (productCalls++, json({ data: [] })) : undefined
    );
    const explicit = new PlytixClient({
      apiKey: 'k',
      apiPassword: 'p',
      baseUrl: BASE_URL,
      authUrl: AUTH_URL,
      rateLimit: { limit: 40, windowMs: 10_000 },
    });
    await explicit.searchProducts({});
    await explicit.searchProducts({}); // would block 10 s under the JWT-derived 1/10 s
    expect(productCalls).toBe(2);
    expect(explicit.getRateLimits()).toEqual([{ limit: 2, windowSeconds: 10 }]);
  });
});
