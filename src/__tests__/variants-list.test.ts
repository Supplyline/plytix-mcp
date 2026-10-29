import { afterEach, describe, expect, it, vi } from 'vitest';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { PlytixClient } from '../client.js';
import { WorkerPlytixClient } from '../worker-client.js';
import { registerVariantTools } from '../tools/variants.js';
import worker from '../worker.js';
import { META_CLIENT_CAPABILITIES, META_PROTOCOL_VERSION, MODERN_PROTOCOL_VERSION } from '../protocol.js';

type Args = Record<string, unknown>;
type Result = { isError?: boolean; content: Array<{ type: string; text: string }> };
const BASE = 'https://pim.offline.test';
const AUTH = 'https://auth.offline.test/get-token';
const productId = 'parent /nested';
const path = `/api/v1/products/${encodeURIComponent(productId)}/variants`;
const rows = [{ id: 'child-1', sku: 'CHILD-1', _parent_id: productId, product_type: 'VARIANT', product_level: 2 }];
const fullResponse = {
  data: rows,
  pagination: { page: 1, page_size: 1, total: 9, pages: 9, count: 9, total_count: 999 },
  attributes: ['sku', '_parent_id', 'product_type', 'product_level'],
};
let credential = 0;
const config = () => ({ apiKey: `variants-offline-${++credential}`, apiPassword: 'not-a-secret', baseUrl: BASE, authUrl: AUTH });
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), {
  status, headers: { 'Content-Type': 'application/json' },
});

function outbound(body: unknown, status = 200) {
  const requests: Array<{ url: string; method: string; body: unknown }> = [];
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url === AUTH) return json({ data: [{ access_token: 'offline-token', expires_in: 900 }] });
    requests.push({ url, method: init?.method ?? 'GET', body: init?.body });
    if (url.startsWith(BASE)) return json(body, status);
    throw new Error(`Unexpected outbound URL: ${url}`);
  }));
  return requests;
}

function stdioTool() {
  let call!: (args: Args) => Promise<Result>;
  let description = '';
  const server = { registerTool: vi.fn((name, supplied, handler) => {
    if (name === 'variants_list') { call = handler; description = supplied.description; }
  }) };
  registerVariantTools(server as unknown as McpServer, new PlytixClient(config()));
  return { call: () => call({ product_id: productId }), description };
}

async function workerRequest(method: string, params: Args, modern = false) {
  const credentials = config();
  const headers: Record<string, string> = { 'Content-Type': 'application/json',
    'X-Plytix-API-Key': credentials.apiKey, 'X-Plytix-API-Password': credentials.apiPassword };
  if (modern) {
    params = { ...params, _meta: { [META_PROTOCOL_VERSION]: MODERN_PROTOCOL_VERSION, [META_CLIENT_CAPABILITIES]: {} } };
    headers['MCP-Protocol-Version'] = MODERN_PROTOCOL_VERSION;
    headers['Mcp-Method'] = method;
    if (method === 'tools/call') headers['Mcp-Name'] = String(params.name);
  }
  const response = await worker.fetch(new Request('https://worker.offline.test/mcp', {
    method: 'POST', headers, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  }), { PLYTIX_API_BASE: BASE, PLYTIX_AUTH_URL: AUTH });
  expect(response.status).toBe(200);
  const envelope = await response.json() as { result: any; error?: unknown };
  expect(envelope.error).toBeUndefined();
  return envelope.result;
}

const workerTool = (modern = false) => ({ call: (): Promise<Result> => workerRequest('tools/call', {
  name: 'variants_list', arguments: { product_id: productId },
}, modern) });

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

for (const [name, factory, isWorker] of [
  ['stdio registered tool', stdioTool, false],
  ['Worker HTTP legacy', workerTool, true],
  ['Worker HTTP modern', () => workerTool(true), true],
] as const) {
  describe(`${name}: actual client and mocked HTTP`, () => {
    it('uses one encoded v1 GET and preserves response metadata without claiming complete count', async () => {
      const calls = outbound(fullResponse);
      const result = await factory().call();
      expect(result.isError).not.toBe(true);
      const payload = JSON.parse(result.content[0].text);
      expect(payload).toEqual(isWorker ? {
        variants: rows, count: 1, pagination: fullResponse.pagination, attributes: fullResponse.attributes,
      } : fullResponse);
      expect(calls).toEqual([{ url: BASE + path, method: 'GET', body: undefined }]);
    });

    it('returns an absent-pagination response without inventing completeness or more calls', async () => {
      const calls = outbound({ data: [] });
      const result = await factory().call();
      expect(result.isError).not.toBe(true);
      expect(JSON.parse(result.content[0].text)).toEqual(isWorker ? { variants: [], count: 0 } : { data: [] });
      expect(calls).toHaveLength(1);
      expect(calls[0].url).toBe(BASE + path);
    });

    it('surfaces 405 without falling back or broadening the request', async () => {
      const calls = outbound({ error: 'Method not allowed' }, 405);
      const result = await factory().call();
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('405');
      expect(calls).toEqual([{ url: BASE + path, method: 'GET', body: undefined }]);
    });
  });
}

it('advertises the same bounded response contract on both transports', async () => {
  const calls = outbound({ data: [] });
  const description = stdioTool().description;
  const listed = await workerRequest('tools/list', {});
  expect(listed.tools.find((t: { name: string }) => t.name === 'variants_list').description).toBe(description);
  expect(description).toContain('no automatic pagination or completeness guarantee');
  expect(calls).toEqual([]);
});

for (const Client of [PlytixClient, WorkerPlytixClient]) {
  it(`${Client.name}: keeps create, link, unlink, and resync on v2`, async () => {
    const calls = outbound({ data: [] });
    const client = new Client({ ...config(), rateLimit: { limit: 1000, windowMs: 1000 } });
    await client.createVariant(productId, { sku: 'CHILD-NEW' });
    await client.linkVariant(productId, 'child /1');
    await client.unlinkVariant(productId, 'child /1');
    await client.resyncVariants(productId, ['label'], ['child /1']);
    const root = `${BASE}/api/v2/products/${encodeURIComponent(productId)}`;
    expect(calls).toEqual([
      { url: `${root}/variants`, method: 'POST', body: JSON.stringify({ sku: 'CHILD-NEW' }) },
      { url: `${root}/variant/child%20%2F1`, method: 'POST', body: undefined },
      { url: `${root}/variant/child%20%2F1`, method: 'DELETE', body: undefined },
      { url: `${root}/variants/resync`, method: 'POST', body: JSON.stringify({ attribute_labels: ['label'], variant_ids: ['child /1'] }) },
    ]);
  });
}
