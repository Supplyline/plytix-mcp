import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { PlytixClient } from '../client.js';
import { registerProductTools } from '../tools/products.js';
import worker from '../worker.js';
import { WorkerPlytixClient } from '../worker-client.js';
import { PRODUCT_SEARCH_FILTERS_DESCRIPTION } from '../utils/product-search-filters.js';
import { META_CLIENT_CAPABILITIES, META_PROTOCOL_VERSION, MODERN_PROTOCOL_VERSION } from '../protocol.js';

type Args = Record<string, unknown>;
type ToolResult = { isError?: boolean; content: Array<{ type: string; text: string }> };
const result = { data: [{ id: 'test-product', sku: 'TEST-A' }], pagination: { page: 2 } };
const sku = { field: 'sku', operator: 'eq', value: 'TEST-A' };
const present = { field: 'attributes.series_id', operator: 'exists' };

function stdioTool() {
  let search!: (args: Args) => Promise<ToolResult>;
  let definition: any;
  const server = { registerTool: vi.fn((name, supplied, handler) => {
    if (name === 'products_search') { search = handler; definition = supplied; }
  }) };
  const client = { searchProducts: vi.fn().mockResolvedValue(result) };
  registerProductTools(server as unknown as McpServer, client as unknown as PlytixClient);
  return { search: client.searchProducts, call: (args: Args) => search(args), definition };
}

async function workerRequest(method: string, params: Args, modern = false) {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'X-Plytix-API-Key': 'offline-test-key',
    'X-Plytix-API-Password': 'offline-test-password',
  };
  if (modern) {
    params = { ...params, _meta: {
      [META_PROTOCOL_VERSION]: MODERN_PROTOCOL_VERSION, [META_CLIENT_CAPABILITIES]: {},
    } };
    headers['MCP-Protocol-Version'] = MODERN_PROTOCOL_VERSION;
    headers['Mcp-Method'] = method;
    if (method === 'tools/call') headers['Mcp-Name'] = String(params.name);
  }
  const response = await worker.fetch(new Request('https://offline.test/mcp', {
    method: 'POST', headers,
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  }), {});
  expect(response.status).toBe(200);
  const body = await response.json() as { error?: unknown; result: any };
  expect(body.error).toBeUndefined();
  return body.result;
}

function workerTool(modern = false) {
  const search = vi.spyOn(WorkerPlytixClient.prototype, 'searchProducts').mockResolvedValue(result);
  return { search, call: (args: Args): Promise<ToolResult> => workerRequest('tools/call', {
    name: 'products_search', arguments: args,
  }, modern) };
}

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn(() => { throw new Error('Unexpected network call in offline handler test'); }));
});
afterEach(() => {
  expect(globalThis.fetch).not.toHaveBeenCalled();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

for (const [name, factory] of [['stdio', stdioTool], ['Worker HTTP tools/call', workerTool]] as const) {
  describe(`${name} products_search filters`, () => {
    it('preserves native OR-of-AND groups and the rest of the search body', async () => {
      const t = factory();
      const args = { filters: [[sku, present], [{ field: ['sku', 'label'], operator: 'text_search', value: 'B' }]],
        attributes: ['sku'], pagination: { page: 2, page_size: 10 }, sort: { field: 'sku', order: 'asc' } };
      const before = structuredClone(args);
      const response = await t.call(args);
      expect(response.isError).not.toBe(true);
      expect(t.search).toHaveBeenCalledExactlyOnceWith(before);
      expect(JSON.parse(response.content[0].text).products).toEqual(result.data);
      expect(args).toEqual(before);
    });

    it('decodes each group once without merging OR groups or dropping AND predicates', async () => {
      const t = factory();
      const groups = [[sku, present], [{ ...sku, value: 'TEST-B' }]];
      const args = { filters: groups.map(group => JSON.stringify(group)) };
      const before = structuredClone(args);
      expect((await t.call(args)).isError).not.toBe(true);
      expect(t.search).toHaveBeenCalledExactlyOnceWith({ filters: groups });
      expect(args).toEqual(before);
    });

    it('accepts mixed groups, field arrays, and literal JSON-looking values', async () => {
      const t = factory();
      const literal = { field: ['sku', 'label'], operator: 'text_search', value: '[{"field":"label","operator":"exists"}]' };
      expect((await t.call({ filters: [[present], JSON.stringify([literal])] })).isError).not.toBe(true);
      expect(t.search).toHaveBeenCalledExactlyOnceWith({ filters: [[present], [literal]] });
    });

    it('normalizes native and encoded tuples, including valueless predicates', async () => {
      const t = factory();
      await t.call({ filters: [[['sku', 'eq', 'TEST-A']], JSON.stringify([['attributes.series_id', 'exists']])] });
      expect(t.search).toHaveBeenCalledExactlyOnceWith({ filters: [[sku], [{ ...present, value: undefined }]] });
    });

    it('preserves explicit native empty filters and groups; no synthetic broad query is added', async () => {
      const t = factory();
      await t.call({}); await t.call({ filters: [] }); await t.call({ filters: [[]] });
      expect(t.search.mock.calls).toEqual([[{}], [{ filters: [] }], [{ filters: [[]] }]]);
    });

    it('leaves API-specific operators and values untouched', async () => {
      const t = factory();
      const predicate = { field: 'sku', operator: 'future_operator', value: { literal: ['x', 2] } };
      await t.call({ filters: [JSON.stringify([predicate])] });
      expect(t.search).toHaveBeenCalledExactlyOnceWith({ filters: [[predicate]] });
    });

    it.each([
      'not json', 'null', '{}', '"text"', '42', '[]', '[null]', '[{}]', '["condition"]',
      JSON.stringify(JSON.stringify([sku])), JSON.stringify([[sku]]),
      '[["sku"]]', '[["sku","eq","x","extra"]]', '[{"field":"sku","operator":false}]',
      '[{"field":" ","operator":"eq"}]', '[{"field":[],"operator":"eq"}]',
      '[{"field":["sku",4],"operator":"eq"}]', '[{"field":"sku","operator":" "}]',
      JSON.stringify([sku, {}]),
    ])('rejects malformed encoded group before a client request: %s', async group => {
      const t = factory();
      const response = await t.call({ filters: [[sku], group, JSON.stringify([present])] });
      expect(response.isError).toBe(true);
      expect(response.content[0].text).toContain('filters[1]');
      expect(t.search).not.toHaveBeenCalled();
    });
  });
}

it('uses the same filter description in stdio discovery and Worker tools/list', async () => {
  const stdio = stdioTool();
  expect(stdio.definition.inputSchema.filters.description).toBe(PRODUCT_SEARCH_FILTERS_DESCRIPTION);
  const listed = await workerRequest('tools/list', {});
  const definition = listed.tools.find((tool: { name: string }) => tool.name === 'products_search');
  expect(definition.inputSchema.properties.filters.description).toBe(PRODUCT_SEARCH_FILTERS_DESCRIPTION);
});

it('also reaches the Worker handler through modern protocol tools/call', async () => {
  const t = workerTool(true);
  expect((await t.call({ filters: [JSON.stringify([sku])] })).isError).not.toBe(true);
  expect(t.search).toHaveBeenCalledExactlyOnceWith({ filters: [[sku]] });
});
