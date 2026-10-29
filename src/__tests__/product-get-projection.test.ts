import { afterEach, describe, expect, it, vi } from 'vitest';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { PlytixProduct } from '../types.js';
import { PlytixClient } from '../client.js';
import { WorkerPlytixClient } from '../worker-client.js';
import { registerProductTools } from '../tools/products.js';
import worker from '../worker.js';
import { META_CLIENT_CAPABILITIES, META_PROTOCOL_VERSION, MODERN_PROTOCOL_VERSION } from '../protocol.js';
import {
  PRODUCT_GET_MAX_ATTRIBUTE_LABELS, PRODUCT_GET_ATTRIBUTE_LABELS_DESCRIPTION,
  validateProductGetAttributeLabels, projectProductGet,
} from '../utils/product-get-projection.js';

type Args = Record<string, unknown>;
type ToolResult = { isError?: boolean; content: Array<{ type: string; text: string }> };
const BASE = 'https://pim.offline.test';
const AUTH = 'https://auth.offline.test/get-token';
const id = 'product /id';
const product: PlytixProduct = {
  id, sku: 'SYNTHETIC', label: 'Test', modified: '2026-10-29T00:00:00Z',
  product_family_id: 'family', product_level: 3, product_type: 'VARIANT',
  overwritten_attributes: ['rich_copy', 'quantity'],
  attributes: { rich_copy: 'x'.repeat(100_000), quantity: 0, flag: false, nullable: null,
    empty: '', nested: { value: 'kept' }, list: [1, 2], Case: 'upper', case: 'lower', ' spaced ': 'literal' },
  assets: [{ id: 'asset' }], native_extra: { preserved: true },
};
const invalid = [null, '', 'quantity', 1, {}, [null], [7], [''], ['  '], ['attributes.quantity'],
  Array(51).fill('quantity')];
let credential = 0;
const config = () => ({ apiKey: `get-projection-${++credential}`, apiPassword: 'offline-only', baseUrl: BASE, authUrl: AUTH });
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), {
  status, headers: { 'Content-Type': 'application/json' },
});
function outbound(body: unknown, status = 200) {
  const calls: Array<{ url: string; method: string }> = [];
  const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url === AUTH) return json({ data: [{ access_token: 'offline-token', expires_in: 900 }] });
    if (!url.startsWith(BASE)) throw new Error(`Unexpected network: ${url}`);
    calls.push({ url, method: init?.method ?? 'GET' });
    return json(body, status);
  });
  vi.stubGlobal('fetch', fetch);
  return { calls, fetch };
}
function stdioTool() {
  let call!: (args: Args) => Promise<ToolResult>;
  let definition: any;
  const server = { registerTool: vi.fn((name, supplied, handler) => {
    if (name === 'products_get') { call = handler; definition = supplied; }
  }) };
  registerProductTools(server as unknown as McpServer, new PlytixClient(config()));
  return { call: (args: Args) => call({ product_id: id, ...args }), definition };
}
async function workerRequest(method: string, params: Args, modern: boolean) {
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
const workerTool = (modern = false) => ({ call: (args: Args): Promise<ToolResult> => workerRequest('tools/call', {
  name: 'products_get', arguments: { product_id: id, ...args },
}, modern) });
const payload = (result: ToolResult) => { expect(result.isError).not.toBe(true); return JSON.parse(result.content[0].text); };
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

it('validates the pre-deduplication cap and keeps exact stable label identities', () => {
  expect(validateProductGetAttributeLabels(undefined)).toBeUndefined();
  expect(validateProductGetAttributeLabels([])).toEqual([]);
  expect(validateProductGetAttributeLabels(['Case', 'case', 'Case', ' spaced '])).toEqual(['Case', 'case', ' spaced ']);
  expect(validateProductGetAttributeLabels(Array(50).fill('x'))).toEqual(['x']);
  for (const value of invalid) expect(() => validateProductGetAttributeLabels(value)).toThrow('attribute_labels');
});

it('projects only own keys, safely preserving unusual keys and not mutating input', () => {
  const attrs = JSON.parse('{"__proto__":{"safe":true},"constructor":"literal","x":0}');
  Object.freeze(attrs.__proto__); Object.freeze(attrs);
  const source = Object.freeze({ ...product, attributes: attrs });
  const labels = ['__proto__', 'constructor', 'toString', 'x']; Object.freeze(labels);
  const result: any = projectProductGet(source, labels);
  expect(result.product.attributes).toEqual(attrs);
  expect(Object.getPrototypeOf(result.product.attributes)).toBe(Object.prototype);
  expect(Object.prototype.hasOwnProperty.call(result.product.attributes, '__proto__')).toBe(true);
  expect(result.projection.missing_labels).toEqual(['toString']);
  expect(source.attributes).toBe(attrs);
  expect(projectProductGet(source, undefined)).toBe(source);
  expect(result.product.overwritten_attributes).toBe(source.overwritten_attributes);
});

it('preserves absent/null maps and rejects malformed maps only for projected views', () => {
  const absent = { id }; const nullMap = { id, attributes: null } as unknown as PlytixProduct;
  expect(projectProductGet(absent, ['x'])).toEqual({ product: absent,
    projection: { scope: 'custom_attributes', requested_labels: ['x'], missing_labels: ['x'], source: 'local_response' } });
  expect((projectProductGet(nullMap, []) as any).product).toEqual(nullMap);
  for (const attributes of [undefined, false, 0, '', [], new Date()]) {
    const source = { id, attributes } as unknown as PlytixProduct;
    expect(() => projectProductGet(source, [])).toThrow('attributes must be');
    expect(projectProductGet(source, undefined)).toBe(source);
  }
  const source = { id, attributes: Object.assign(Object.create(null), { x: 0 }) };
  expect((projectProductGet(source, ['x']) as any).product.attributes).toEqual({ x: 0 });
});

for (const [name, factory] of [
  ['stdio', stdioTool], ['Worker legacy', workerTool], ['Worker modern', () => workerTool(true)],
] as const) {
  describe(`${name}: actual handler/client and mocked HTTP`, () => {
    it('keeps omitted output byte-for-byte and uses one encoded direct GET', async () => {
      const { calls } = outbound({ data: [product], attributes: ['ignored-envelope'] });
      const result = await factory().call({});
      expect(result.content[0].text).toBe(JSON.stringify(product, null, 2));
      expect(calls).toEqual([{ url: `${BASE}/api/v2/products/product%20%2Fid`, method: 'GET' }]);
    });
    it('removes unrequested long copy and preserves exact requested values plus native/inheritance fields', async () => {
      const { calls } = outbound({ data: [product] });
      const labels = ['quantity', 'flag', 'nullable', 'empty', 'nested', 'list', 'missing', 'quantity'];
      const result = await factory().call({ attribute_labels: labels });
      const projected = payload(result);
      expect(projected).toEqual({ product: { ...product, attributes: { quantity: 0, flag: false, nullable: null,
        empty: '', nested: { value: 'kept' }, list: [1, 2] } },
      projection: { scope: 'custom_attributes', requested_labels: labels.slice(0, -1), missing_labels: ['missing'], source: 'local_response' } });
      expect(result.content[0].text.length).toBeLessThan(2000);
      expect(projected.product.overwritten_attributes).toEqual(['rich_copy', 'quantity']);
      expect(calls).toEqual([{ url: `${BASE}/api/v2/products/product%20%2Fid`, method: 'GET' }]);
    });
    it('treats [] as an explicit projection, not an omitted argument', async () => {
      outbound({ data: [product] });
      expect(payload(await factory().call({ attribute_labels: [] }))).toEqual({
        product: { ...product, attributes: {} },
        projection: { scope: 'custom_attributes', requested_labels: [], missing_labels: [], source: 'local_response' },
      });
    });
    it.each([{ id }, { id, attributes: null }])('preserves absent/null attributes (%j)', async source => {
      outbound({ data: [source] });
      expect(payload(await factory().call({ attribute_labels: ['x'] }))).toEqual({ product: source,
        projection: { scope: 'custom_attributes', requested_labels: ['x'], missing_labels: ['x'], source: 'local_response' } });
    });
    it.each(invalid.map((value, index) => ({ value, index })))('rejects invalid labels case $index before any fetch', async ({ value }) => {
      const { fetch } = outbound({ data: [product] });
      const result = await factory().call({ attribute_labels: value });
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('attribute_labels');
      expect(fetch).not.toHaveBeenCalled();
    });
    it('accepts exactly 50 distinct labels and keeps missing labels visible', async () => {
      const labels = Array.from({ length: 50 }, (_, i) => `missing_${i}`);
      outbound({ data: [product] });
      expect(payload(await factory().call({ attribute_labels: labels })).projection.missing_labels).toEqual(labels);
    });
    it('refuses malformed returned attributes without claiming an empty projection', async () => {
      outbound({ data: [{ id, attributes: ['bad'] }] });
      const result = await factory().call({ attribute_labels: [] });
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('attributes must be');
    });
    it('preserves missing-product errors', async () => {
      outbound({ data: [] });
      const result = await factory().call({ attribute_labels: ['x'] });
      expect(result.isError).toBe(true); expect(result.content[0].text).toContain('Product not found');
    });
    it('preserves HTTP errors without fallback', async () => {
      const { calls } = outbound({ error: 'not found' }, 404);
      const result = await factory().call({ attribute_labels: ['x'] });
      expect(result.isError).toBe(true); expect(result.content[0].text).toContain('404');
      expect(calls).toHaveLength(1);
    });
  });
}

it('advertises matching opt-in contract and cap on stdio and Worker', async () => {
  const { fetch } = outbound({});
  const stdio = stdioTool().definition;
  const tools = (await workerRequest('tools/list', {}, false)).tools;
  const remote = tools.find((tool: any) => tool.name === 'products_get');
  expect(remote.description).toBe(stdio.description);
  expect(remote.inputSchema.properties.attribute_labels).toEqual({
    type: 'array', items: { type: 'string', minLength: 1 }, maxItems: PRODUCT_GET_MAX_ATTRIBUTE_LABELS,
    description: PRODUCT_GET_ATTRIBUTE_LABELS_DESCRIPTION,
  });
  expect(stdio.inputSchema.attribute_labels.safeParse(Array(51).fill('x')).success).toBe(false);
  expect(stdio.inputSchema.attribute_labels.safeParse([]).success).toBe(true);
  expect(stdio.inputSchema.attribute_labels.safeParse(undefined).success).toBe(true);
  expect(remote.inputSchema.required).toEqual(['product_id']);
  expect(fetch).not.toHaveBeenCalled();
});

for (const Client of [PlytixClient, WorkerPlytixClient]) {
  it(`${Client.name}: complete getProduct result remains available to guards, exports, and readbacks`, async () => {
    const envelope = { data: [product], pagination: { page: 1 }, attributes: ['rich_copy'] };
    const { calls } = outbound(envelope);
    expect(await new Client(config()).getProduct(id)).toEqual(envelope);
    expect(calls).toHaveLength(1);
  });
}
