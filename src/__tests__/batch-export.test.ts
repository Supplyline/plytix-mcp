import { mkdtemp, readFile, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import worker from '../worker.js';
import {
  canonicalJson,
  executeBatchExport,
  type ProductExportOperations,
  type ProductExportSink,
} from '../batch/export.js';
import { exportProductsToFile } from '../batch/export-file.js';
import type { PlytixProduct, PlytixResult, PlytixSearchBody } from '../types.js';

const searchFilter = [[{ field: 'status', operator: 'eq', value: 'ACTIVE' }]];

function makeOps(args?: {
  search?: (body: PlytixSearchBody) => Promise<PlytixResult<PlytixProduct>>;
  get?: (productId: string) => Promise<PlytixResult<PlytixProduct>>;
}): ProductExportOperations & {
  searchProducts: ReturnType<typeof vi.fn>;
  getProduct: ReturnType<typeof vi.fn>;
} {
  return {
    searchProducts: vi.fn(async (body: PlytixSearchBody) =>
      args?.search
        ? args.search(body)
        : {
            data: [],
            pagination: { page: body.pagination?.page ?? 1, page_size: 100, total: 0, pages: 1 },
          }
    ),
    getProduct: vi.fn(async (productId: string) =>
      args?.get ? args.get(productId) : { data: [{ id: productId }] }
    ),
  };
}

describe('canonical JSON', () => {
  it('sorts object keys at every depth and preserves array order', () => {
    expect(canonicalJson({ z: 1, a: { y: 2, b: 1 }, rows: [{ b: 2, a: 1 }] })).toBe(
      '{"a":{"b":1,"y":2},"rows":[{"a":1,"b":2}],"z":1}'
    );
  });

  it('rejects non-finite numbers', () => {
    expect(() => canonicalJson({ value: Number.NaN })).toThrow('non-finite');
  });
});

describe('executeBatchExport', () => {
  it('allows explicit limited inline search reads and marks truncation', async () => {
    const ops = makeOps({
      search: async () => ({
        data: [{ id: '1' }, { id: '2' }, { id: '3' }],
        pagination: { page: 1, page_size: 100, total: 3, pages: 1 },
      }),
    });

    const result = await executeBatchExport(
      ops,
      { mode: 'search', filters: searchFilter, max_rows: 2 },
      { mode: 'inline', maxRows: 5, maxResponseBytes: 1024 * 1024 }
    );

    expect(result.status).toBe('finished');
    expect(result.summary).toMatchObject({
      exported: 2,
      matched: 3,
      truncated: true,
      limit_reason: 'max_rows',
    });
    expect(result.products?.map((product) => product.id)).toEqual(['1', '2']);
  });

  it('rejects omitted max_rows inline searches that exceed the inline row cap', async () => {
    const ops = makeOps({
      search: async () => ({
        data: [{ id: '1' }, { id: '2' }, { id: '3' }],
        pagination: { page: 1, page_size: 100, total: 3, pages: 1 },
      }),
    });

    const result = await executeBatchExport(
      ops,
      { mode: 'search', filters: searchFilter },
      { mode: 'inline', maxRows: 2, maxResponseBytes: 1024 * 1024 }
    );

    expect(result.status).toBe('rejected');
    expect(result.summary).toMatchObject({
      exported: 0,
      matched: 3,
      limit_reason: 'inline_row_cap',
    });
    expect('products' in result).toBe(false);
  });

  it('pages SKU resolution and reports missing or ambiguous SKUs as row failures', async () => {
    const ops = makeOps({
      search: async (body) => {
        if ((body.pagination?.page ?? 1) === 1) {
          return {
            data: [
              { id: 'good-product', sku: 'GOOD' },
              { id: 'dup-product-1', sku: 'DUP' },
            ],
            attributes: ['sku', 'attributes.foo'],
            pagination: { page: 1, page_size: 100, total: 3, pages: 2 },
          };
        }
        return {
          data: [{ id: 'dup-product-2', sku: 'DUP' }],
          attributes: ['sku', 'attributes.foo'],
          pagination: { page: 2, page_size: 100, total: 3, pages: 2 },
        };
      },
    });

    const result = await executeBatchExport(
      ops,
      { mode: 'skus', skus: ['GOOD', 'MISSING', 'DUP'], attributes: ['attributes.foo'] },
      { mode: 'inline', maxRows: 10, maxResponseBytes: 1024 * 1024 }
    );

    expect(result.status).toBe('finished');
    expect(result.summary).toMatchObject({ requested: 3, exported: 1, failed: 2 });
    expect(result.failures.map((failure) => failure.key)).toEqual(['MISSING', 'DUP']);
    expect(result.products?.map((product) => product.id)).toEqual(['good-product']);
    expect(ops.searchProducts).toHaveBeenCalledTimes(2);
    expect(ops.searchProducts.mock.calls[0]?.[0].attributes).toEqual([
      'sku',
      'attributes.foo',
    ]);
  });

  it('rejects page_size for product_id exports', async () => {
    const result = await executeBatchExport(
      makeOps(),
      { mode: 'product_ids', product_ids: ['product-1'], page_size: 10 },
      { mode: 'inline', maxRows: 10, maxResponseBytes: 1024 * 1024 }
    );

    expect(result.status).toBe('rejected');
    expect(result.failures[0]?.errors[0]?.field).toBe('page_size');
  });

  it('rejects stray selector fields before API calls', async () => {
    const ops = makeOps();
    const result = await executeBatchExport(
      ops,
      { mode: 'search', filters: searchFilter, max_rows: 1, skus: ['SKU1'] },
      { mode: 'inline', maxRows: 10, maxResponseBytes: 1024 * 1024 }
    );

    expect(result.status).toBe('rejected');
    expect(result.failures[0]?.errors[0]?.field).toBe('skus');
    expect(ops.searchProducts).not.toHaveBeenCalled();
  });

  it('exports product_id successes and row-level fetch failures in input order', async () => {
    const ops = makeOps({
      get: async (productId) => ({
        data: productId === 'missing-product' ? [] : [{ id: productId, label: productId }],
      }),
    });

    const result = await executeBatchExport(
      ops,
      { mode: 'product_ids', product_ids: ['product-1', 'missing-product', 'product-2'] },
      { mode: 'inline', maxRows: 10, maxResponseBytes: 1024 * 1024, requestDelayMs: 0 }
    );

    expect(result.status).toBe('finished');
    expect(result.summary).toMatchObject({ requested: 3, exported: 2, failed: 1 });
    expect(result.products?.map((product) => product.id)).toEqual(['product-1', 'product-2']);
    expect(result.failures[0]).toMatchObject({ key: 'missing-product', stage: 'fetch' });
  });

  it('returns a structured rejection when the export sink cannot finish', async () => {
    const sink: ProductExportSink = {
      accept: vi.fn(async () => undefined),
      finish: vi.fn(async () => {
        throw new Error('disk full');
      }),
      abort: vi.fn(async () => undefined),
    };
    const ops = makeOps({
      search: async () => ({
        data: [{ id: 'product-1' }],
        pagination: { page: 1, page_size: 100, total: 1, pages: 1 },
      }),
    });

    const result = await executeBatchExport(
      ops,
      { mode: 'search', filters: searchFilter, max_rows: 1 },
      { mode: 'file', maxRows: 10, sink }
    );

    expect(result.status).toBe('rejected');
    expect(result.failures[0]).toMatchObject({ key: 'output_path', stage: 'write' });
    expect(sink.abort).toHaveBeenCalled();
  });
});

describe('exportProductsToFile', () => {
  let tempDir: string | undefined;

  afterEach(async () => {
    if (tempDir) {
      await rm(tempDir, { recursive: true, force: true });
      tempDir = undefined;
    }
  });

  async function makeTempDir() {
    tempDir = await mkdtemp(join(tmpdir(), 'plytix-export-'));
    return tempDir;
  }

  it('rejects output paths outside the configured export root before API calls', async () => {
    const root = await makeTempDir();
    const ops = makeOps();

    const result = await exportProductsToFile(
      ops,
      {
        mode: 'search',
        filters: searchFilter,
        max_rows: 10,
        output_path: '../escape.jsonl',
      },
      { exportRoot: root }
    );

    expect(result.status).toBe('rejected');
    expect(result.failures[0]?.stage).toBe('validation');
    expect(ops.searchProducts).not.toHaveBeenCalled();
  });

  it('writes canonical JSONL under the configured export root', async () => {
    const root = await makeTempDir();
    const ops = makeOps({
      search: async () => ({
        data: [
          { id: 'product-1', attributes: { z: 2, a: 1 } },
          { id: 'product-2', sku: 'SKU2' },
        ],
        pagination: { page: 1, page_size: 100, total: 2, pages: 1 },
      }),
    });

    const result = await exportProductsToFile(
      ops,
      {
        mode: 'search',
        filters: searchFilter,
        max_rows: 10,
        output_path: 'snapshot.jsonl',
      },
      { exportRoot: root }
    );

    expect(result.status).toBe('finished');
    expect(result.summary).toMatchObject({ exported: 2, failed: 0, truncated: false });
    expect(result.metadata.output_path).toBe(join(await realpath(root), 'snapshot.jsonl'));
    expect(result.metadata.export_sha256).toMatch(/^[a-f0-9]{64}$/);

    const body = await readFile(join(root, 'snapshot.jsonl'), 'utf8');
    expect(body).toBe(
      '{"attributes":{"a":1,"z":2},"id":"product-1"}\n{"id":"product-2","sku":"SKU2"}\n'
    );
  });
});

describe('worker batch export surface', () => {
  it('exposes inline batch export and omits the stdio-only file export tool', async () => {
    const response = await worker.fetch(
      new Request('https://mcp.example.com/mcp', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
      }),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      {} as any
    );

    const body = await response.json() as { result: { tools: Array<{ name: string }> } };
    const toolNames = body.result.tools.map((tool) => tool.name);

    expect(toolNames).toContain('products_batch_export');
    expect(toolNames).not.toContain('products_batch_export_to_file');
  });
});
