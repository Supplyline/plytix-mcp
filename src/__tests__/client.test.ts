import { describe, it, expect, vi, afterEach } from 'vitest';
import { PlytixClient } from '../client.js';
import { PlytixError } from '../types.js';

// ─────────────────────────────────────────────────────────────
// Test harness: routed fetch mock
// ─────────────────────────────────────────────────────────────

const AUTH_URL = 'https://auth.example.com/get-token';
const BASE_URL = 'https://pim.example.com';

function makeClient() {
  return new PlytixClient({
    apiKey: 'unit-test-key',
    apiPassword: 'unit-test-password',
    baseUrl: BASE_URL,
    authUrl: AUTH_URL,
  });
}

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
    if (result === 'fail') return json({ error: 'boom' }, 500);
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

    const client = makeClient();
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

    const client = makeClient();
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

    const client = makeClient();
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
      await Promise.resolve(); // let siblings start before finishing
      inFlight--;
      return json({ data: [{ id: m[1], label: `label_${m[1]}` }] });
    });

    const client = makeClient();
    const attr = await client.getAttributeByLabel('label_a0');

    expect(attr?.label).toBe('label_a0');
    expect(maxInFlight).toBeGreaterThan(1);
    expect(maxInFlight).toBeLessThanOrEqual(10);
  });

  it('throws PlytixError when the account has no attributes at all', async () => {
    stubFetch(authRoute(), attrSearchRoute([]));

    const client = makeClient();
    await expect(client.getAttributeByLabel('anything')).rejects.toThrow(
      /no attributes found/
    );
  });
});
