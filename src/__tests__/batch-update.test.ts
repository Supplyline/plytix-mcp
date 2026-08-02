import { mkdtemp, rm, truncate, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, it, vi, afterEach } from 'vitest';
import worker from '../worker.js';
import { PlytixClient } from '../client.js';
import { WorkerPlytixClient } from '../worker-client.js';
import { readBatchManifest } from '../batch/manifest.js';
import { executeBatchUpdate, type BatchUpdateOperations } from '../batch/runner.js';
import {
  STDIO_INLINE_MAX_BYTES,
  parsePlytixErrors,
  validateBatchItems,
} from '../batch/helpers.js';
import {
  PlytixError,
  type PlytixProduct,
  type PlytixResult,
  type PlytixSearchBody,
} from '../types.js';

const productResult = (id: string): PlytixResult<PlytixProduct> => ({
  data: [{ id, modified: '2026-06-09T00:00:00Z' }],
});

const skuResolutionPage = (page: number): PlytixResult<PlytixProduct> => {
  if (page === 1) {
    return {
      data: [
        ...Array.from({ length: 99 }, (_, index) => ({
          id: `product-${index + 1}`,
          sku: `SKU${index + 1}`,
        })),
        { id: 'dup-product-1', sku: 'DUP-SKU' },
      ],
      pagination: { page: 1, page_size: 100, total: 101, pages: 2 },
    };
  }

  return {
    data: [{ id: 'dup-product-2', sku: 'DUP-SKU' }],
    pagination: { page: 2, page_size: 100, total: 101, pages: 2 },
  };
};

function makeOps(args?: {
  resolved?: Record<string, Array<{ id: string; sku?: string }>>;
  live?: Record<string, PlytixProduct | undefined>;
  get?: (productId: string) => Promise<PlytixResult<PlytixProduct>>;
  update?: (productId: string) => Promise<PlytixResult<PlytixProduct>>;
}): BatchUpdateOperations & {
  getProduct: ReturnType<typeof vi.fn>;
  resolveProductIdsBySku: ReturnType<typeof vi.fn>;
  updateProduct: ReturnType<typeof vi.fn>;
} {
  return {
    getProduct: vi.fn(async (productId: string) => {
      if (args?.get) return args.get(productId);
      const product = args?.live?.[productId] ?? {
        id: productId,
        modified: '2026-06-09T00:00:00Z',
      };
      return { data: product ? [product] : [] };
    }),
    resolveProductIdsBySku: vi.fn(async (skus: string[]) => {
      const map = new Map<string, Array<{ id: string; sku?: string }>>();
      for (const sku of skus) {
        map.set(sku, args?.resolved?.[sku] ?? []);
      }
      return map;
    }),
    updateProduct: vi.fn(async (productId: string) =>
      args?.update ? args.update(productId) : productResult(productId)
    ),
  };
}

describe('batch update validation', () => {
  it('allows sku plus product_id and reports no structural failures', () => {
    const result = validateBatchItems(
      [
        {
          sku: 'LMI-PD041929NI',
          product_id: 'product-1',
          attributes: { google_detail: 'copy' },
        },
      ],
      { maxItems: 250 }
    );

    expect(result.failures).toEqual([]);
    expect(result.items[0]).toMatchObject({ sku: 'LMI-PD041929NI', product_id: 'product-1' });
  });

  it('rejects missing identity, non-object attributes, and empty attributes-only updates', () => {
    const result = validateBatchItems(
      [
        { attributes: { foo: 'bar' } },
        { sku: 'A', attributes: [] },
        { sku: 'B', attributes: {} },
      ],
      { maxItems: 250 }
    );

    expect(result.failures.map((failure) => failure.index)).toEqual([0, 1, 1, 2]);
    expect(result.failures.every((failure) => failure.stage === 'validation')).toBe(true);
  });

  it('rejects duplicate sku and duplicate product_id before writes', () => {
    const result = validateBatchItems(
      [
        { sku: 'A', product_id: '1', label: 'one' },
        { sku: 'A', product_id: '2', label: 'two' },
        { sku: 'B', product_id: '2', label: 'three' },
      ],
      { maxItems: 250 }
    );

    expect(result.failures.some((failure) => failure.stage === 'duplicate')).toBe(true);
    expect(result.failures.some((failure) => failure.errors[0]?.field === 'sku')).toBe(true);
    expect(result.failures.some((failure) => failure.errors[0]?.field === 'product_id')).toBe(true);
  });

  it('enforces serialized byte caps for inline calls', () => {
    const result = validateBatchItems(
      [{ product_id: '1', attributes: { google_detail: 'x'.repeat(STDIO_INLINE_MAX_BYTES) } }],
      { maxItems: 250, maxBytes: 1024 }
    );

    expect(result.failures[0]?.errors[0]?.msg).toContain('inline payload');
  });

  it('rejects empty or non-object optimistic guards', () => {
    const result = validateBatchItems(
      [
        { product_id: '1', label: 'one', expected_attributes: {} },
        { product_id: '2', label: 'two', if_match: [] },
      ],
      { maxItems: 250 }
    );

    expect(result.failures.map((failure) => failure.errors[0]?.field)).toEqual([
      'expected_attributes',
      'if_match',
    ]);
  });
});

describe('executeBatchUpdate', () => {
  it('dry-runs resolution and verification without PATCH calls', async () => {
    const ops = makeOps({ resolved: { SKU1: [{ id: 'product-1', sku: 'SKU1' }] } });

    const result = await executeBatchUpdate(
      ops,
      [{ sku: 'SKU1', product_id: 'product-1', label: 'New label' }],
      { maxItems: 250, dryRun: true }
    );

    expect(result).toMatchObject({
      status: 'finished',
      dry_run: true,
      summary: { total: 1, succeeded: 0, failed: 0, skipped: 1 },
    });
    expect(ops.resolveProductIdsBySku).toHaveBeenCalledWith(['SKU1']);
    expect(ops.updateProduct).not.toHaveBeenCalled();
  });

  it('skips rows when sku and product_id disagree', async () => {
    const ops = makeOps({ resolved: { SKU1: [{ id: 'resolved-product', sku: 'SKU1' }] } });

    const result = await executeBatchUpdate(
      ops,
      [{ sku: 'SKU1', product_id: 'wrong-product', label: 'New label' }],
      { maxItems: 250 }
    );

    expect(result.status).toBe('finished');
    expect(result.summary).toEqual({ total: 1, succeeded: 0, failed: 1, skipped: 1 });
    expect(result.failures[0]).toMatchObject({ stage: 'verify', key: 'SKU1' });
    expect(ops.updateProduct).not.toHaveBeenCalled();
  });

  it('rejects post-resolution duplicate product targets before PATCH calls', async () => {
    const ops = makeOps({
      resolved: {
        SKU1: [{ id: 'same-product', sku: 'SKU1' }],
        SKU2: [{ id: 'same-product', sku: 'SKU2' }],
      },
    });

    const result = await executeBatchUpdate(
      ops,
      [
        { sku: 'SKU1', label: 'One' },
        { sku: 'SKU2', label: 'Two' },
      ],
      { maxItems: 250 }
    );

    expect(result.status).toBe('rejected');
    expect(result.failures.every((failure) => failure.stage === 'duplicate')).toBe(true);
    expect(ops.updateProduct).not.toHaveBeenCalled();
  });

  it('aggregates mixed resolve, patch success, and structured patch failures', async () => {
    const ops = makeOps({
      resolved: {
        GOOD: [{ id: 'good-product', sku: 'GOOD' }],
        BAD: [{ id: 'bad-product', sku: 'BAD' }],
      },
      update: async (productId) => {
        if (productId === 'bad-product') {
          throw new PlytixError(
            'Request failed',
            422,
            JSON.stringify({
              error: { errors: [{ field: 'attributes.google_detail', msg: 'too long' }] },
            })
          );
        }
        return productResult(productId);
      },
    });

    const result = await executeBatchUpdate(
      ops,
      [
        { sku: 'GOOD', attributes: { google_detail: 'ok' } },
        { sku: 'MISSING', label: 'Missing' },
        { sku: 'BAD', attributes: { google_detail: 'bad' } },
      ],
      { maxItems: 250, requestDelayMs: 0 }
    );

    expect(result.status).toBe('finished');
    expect(result.summary).toEqual({ total: 3, succeeded: 1, failed: 2, skipped: 1 });
    expect(result.failures.map((failure) => failure.stage)).toEqual(['resolve', 'patch']);
    expect(result.failures[1]?.errors[0]).toEqual({
      field: 'attributes.google_detail',
      msg: 'too long',
    });
  });

  it('skips guarded rows whose live values drift before PATCH', async () => {
    const ops = makeOps({
      resolved: { GUARDED: [{ id: 'product-1', sku: 'GUARDED' }] },
      live: {
        'product-1': {
          id: 'product-1',
          sku: 'GUARDED',
          status: 'ACTIVE',
          attributes: { google_detail: 'changed' },
        },
      },
    });

    const result = await executeBatchUpdate(
      ops,
      [
        {
          sku: 'GUARDED',
          attributes: { google_detail: 'new value' },
          expected_attributes: { google_detail: 'original' },
          if_match: { status: 'ACTIVE' },
        },
      ],
      { maxItems: 250, requestDelayMs: 0 }
    );

    expect(result.status).toBe('finished');
    expect(result.summary).toEqual({ total: 1, succeeded: 0, failed: 1, skipped: 1 });
    expect(result.failures[0]).toMatchObject({
      index: 0,
      key: 'GUARDED',
      product_id: 'product-1',
      stage: 'conflict',
    });
    expect(result.failures[0]?.errors).toEqual([
      {
        field: 'expected_attributes.google_detail',
        msg: 'live attribute no longer matches expected value',
      },
    ]);
    expect(ops.getProduct).toHaveBeenCalledWith('product-1');
    expect(ops.updateProduct).not.toHaveBeenCalled();
  });

  it('checks each guarded row immediately before its own PATCH', async () => {
    const events: string[] = [];
    const ops = makeOps({
      get: async (productId) => {
        events.push(`get:${productId}`);
        return {
          data: [
            {
              id: productId,
              attributes: { google_detail: `${productId}:old` },
            },
          ],
        };
      },
      update: async (productId) => {
        events.push(`patch:${productId}`);
        return productResult(productId);
      },
    });

    const result = await executeBatchUpdate(
      ops,
      [
        {
          product_id: 'product-1',
          attributes: { google_detail: 'one:new' },
          expected_attributes: { google_detail: 'product-1:old' },
        },
        {
          product_id: 'product-2',
          attributes: { google_detail: 'two:new' },
          expected_attributes: { google_detail: 'product-2:old' },
        },
      ],
      { maxItems: 250, concurrency: 1, requestDelayMs: 0 }
    );

    expect(result.summary).toEqual({ total: 2, succeeded: 2, failed: 0, skipped: 0 });
    expect(events).toEqual([
      'get:product-1',
      'patch:product-1',
      'get:product-2',
      'patch:product-2',
    ]);
  });

  it('returns exact success rows when requested', async () => {
    const ops = makeOps();

    const result = await executeBatchUpdate(
      ops,
      [{ product_id: 'product-1', label: 'New label' }],
      { maxItems: 250, returnSuccesses: true, requestDelayMs: 0 }
    );

    expect(result.status).toBe('finished');
    expect(result.summary).toEqual({ total: 1, succeeded: 1, failed: 0, skipped: 0 });
    expect(result.successes).toEqual([
      {
        index: 0,
        key: 'product-1',
        product_id: 'product-1',
        modified: '2026-06-09T00:00:00Z',
      },
    ]);
    expect(ops.getProduct).not.toHaveBeenCalled();
  });

  it('expected null matches an ABSENT live attribute (nullish equivalence)', async () => {
    const ops = makeOps({
      resolved: { GUARDED: [{ id: 'product-1', sku: 'GUARDED' }] },
      live: { 'product-1': { id: 'product-1', attributes: {} } },
    });
    const result = await executeBatchUpdate(
      ops,
      [{ sku: 'GUARDED', attributes: { opt_1: 'new' }, expected_attributes: { opt_1: null } }],
      { maxItems: 250, requestDelayMs: 0 }
    );
    expect(result.status).toBe('finished');
    expect(result.summary).toEqual({ total: 1, succeeded: 1, failed: 0, skipped: 0 });
    expect(ops.updateProduct).toHaveBeenCalled();
  });

  it('expected null matches a live null attribute', async () => {
    const ops = makeOps({
      resolved: { GUARDED: [{ id: 'product-1', sku: 'GUARDED' }] },
      live: { 'product-1': { id: 'product-1', attributes: { opt_1: null } } },
    });
    const result = await executeBatchUpdate(
      ops,
      [{ sku: 'GUARDED', attributes: { opt_1: 'new' }, expected_attributes: { opt_1: null } }],
      { maxItems: 250, requestDelayMs: 0 }
    );
    expect(result.summary).toEqual({ total: 1, succeeded: 1, failed: 0, skipped: 0 });
  });

  it('expected null CONFLICTS with a present empty string', async () => {
    const ops = makeOps({
      resolved: { GUARDED: [{ id: 'product-1', sku: 'GUARDED' }] },
      live: { 'product-1': { id: 'product-1', attributes: { opt_1: '' } } },
    });
    const result = await executeBatchUpdate(
      ops,
      [{ sku: 'GUARDED', attributes: { opt_1: 'new' }, expected_attributes: { opt_1: null } }],
      { maxItems: 250, requestDelayMs: 0 }
    );
    expect(result.summary).toEqual({ total: 1, succeeded: 0, failed: 1, skipped: 1 });
    expect(result.failures[0]).toMatchObject({ stage: 'conflict' });
    expect(result.failures[0]?.errors?.[0]?.field).toBe('expected_attributes.opt_1');
    expect(ops.updateProduct).not.toHaveBeenCalled();
  });

  it('expected null CONFLICTS with a present live value', async () => {
    const ops = makeOps({
      resolved: { GUARDED: [{ id: 'product-1', sku: 'GUARDED' }] },
      live: { 'product-1': { id: 'product-1', attributes: { opt_1: 'someone wrote this' } } },
    });
    const result = await executeBatchUpdate(
      ops,
      [{ sku: 'GUARDED', attributes: { opt_1: 'new' }, expected_attributes: { opt_1: null } }],
      { maxItems: 250, requestDelayMs: 0 }
    );
    expect(result.failures[0]).toMatchObject({ stage: 'conflict' });
    expect(ops.updateProduct).not.toHaveBeenCalled();
  });

  it('if_match attribute paths get the same nullish equivalence', async () => {
    const ops = makeOps({
      resolved: { GUARDED: [{ id: 'product-1', sku: 'GUARDED' }] },
      live: { 'product-1': { id: 'product-1', attributes: {} } },
    });
    const result = await executeBatchUpdate(
      ops,
      [{ sku: 'GUARDED', attributes: { opt_1: 'new' }, if_match: { 'attributes.opt_1': null } }],
      { maxItems: 250, requestDelayMs: 0 }
    );
    expect(result.summary).toEqual({ total: 1, succeeded: 1, failed: 0, skipped: 0 });
  });

  it('dry-run with a null guard passes when the attribute is absent', async () => {
    const ops = makeOps({
      resolved: { GUARDED: [{ id: 'product-1', sku: 'GUARDED' }] },
      live: { 'product-1': { id: 'product-1', attributes: {} } },
    });
    const result = await executeBatchUpdate(
      ops,
      [{ sku: 'GUARDED', attributes: { opt_1: 'new' }, expected_attributes: { opt_1: null } }],
      { maxItems: 250, dryRun: true, requestDelayMs: 0 }
    );
    expect(result).toMatchObject({
      status: 'finished',
      dry_run: true,
      summary: { total: 1, succeeded: 0, failed: 0, skipped: 1 },
    });
    expect(result.failures).toEqual([]);
    expect(ops.updateProduct).not.toHaveBeenCalled();
  });
});

describe('SKU resolution pagination', () => {
  const skus = ['DUP-SKU', ...Array.from({ length: 99 }, (_, index) => `SKU${index + 1}`)];

  it('stdio client pages through all SKU matches before verification', async () => {
    const client = new PlytixClient({ apiKey: 'key', apiPassword: 'password' });
    const searchProducts = vi.fn(async (body: PlytixSearchBody) =>
      skuResolutionPage(body.pagination?.page ?? 1)
    );
    client.searchProducts = searchProducts as typeof client.searchProducts;

    const resolved = await client.resolveProductIdsBySku(skus);

    expect(searchProducts).toHaveBeenCalledTimes(2);
    expect(searchProducts.mock.calls.map(([body]) => body.pagination?.page)).toEqual([1, 2]);
    expect(resolved.get('DUP-SKU')?.map((product) => product.id)).toEqual([
      'dup-product-1',
      'dup-product-2',
    ]);
  });

  it('Worker client pages through all SKU matches before verification', async () => {
    const client = new WorkerPlytixClient({ apiKey: 'key', apiPassword: 'password' });
    const searchProducts = vi.fn(async (body: PlytixSearchBody) =>
      skuResolutionPage(body.pagination?.page ?? 1)
    );
    client.searchProducts = searchProducts as typeof client.searchProducts;

    const resolved = await client.resolveProductIdsBySku(skus);

    expect(searchProducts).toHaveBeenCalledTimes(2);
    expect(searchProducts.mock.calls.map(([body]) => body.pagination?.page)).toEqual([1, 2]);
    expect(resolved.get('DUP-SKU')?.map((product) => product.id)).toEqual([
      'dup-product-1',
      'dup-product-2',
    ]);
  });
});

describe('batch manifest parsing', () => {
  let tempDir: string | undefined;

  afterEach(async () => {
    if (tempDir) {
      await rm(tempDir, { recursive: true, force: true });
      tempDir = undefined;
    }
  });

  async function writeManifest(name: string, value: unknown) {
    tempDir = await mkdtemp(join(tmpdir(), 'plytix-batch-'));
    const path = join(tempDir, name);
    await writeFile(path, JSON.stringify(value), 'utf8');
    return path;
  }

  it('reads schema_version 1 manifests and returns metadata plus sha256', async () => {
    const path = await writeManifest('manifest.json', {
      schema_version: 1,
      series_id: 'LMI-PD',
      config_snapshot_hash: 'abc123',
      items: [{ sku: 'SKU1', product_id: 'product-1', label: 'Label' }],
    });

    const manifest = await readBatchManifest(path);

    expect(manifest.items).toHaveLength(1);
    expect(manifest.metadata).toMatchObject({
      series_id: 'LMI-PD',
      config_snapshot_hash: 'abc123',
    });
    expect(manifest.metadata.manifest_sha256).toMatch(/^[a-f0-9]{64}$/);
  });

  it('rejects non-json manifests and missing schema_version', async () => {
    const txtPath = await writeManifest('manifest.txt', {
      schema_version: 1,
      items: [],
    });
    await expect(readBatchManifest(txtPath)).rejects.toThrow('.json');

    const jsonPath = await writeManifest('manifest.json', { items: [] });
    await expect(readBatchManifest(jsonPath)).rejects.toThrow('schema_version');
  });
});

describe('worker batch-update surface', () => {
  it('exposes inline batch update and omits the stdio-only manifest tool', async () => {
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

    expect(toolNames).toContain('products_batch_update');
    expect(toolNames).not.toContain('products_batch_update_manifest');
  });
});

// ─────────────────────────────────────────────────────────────
// Review follow-ups (2026-06-10): contractually-required cases
// from the SPEC's Testing section that were missing.
// ─────────────────────────────────────────────────────────────

describe('parsePlytixErrors shapes', () => {
  it('parses a single-message { error: { msg } } body', () => {
    const err = new PlytixError('Request failed', 400, '{"error":{"msg":"bad attribute"}}');
    expect(parsePlytixErrors(err)).toEqual([{ msg: 'bad attribute' }]);
  });

  it('falls back to Error.message for plain errors', () => {
    expect(parsePlytixErrors(new Error('socket hang up'))).toEqual([
      { msg: 'socket hang up' },
    ]);
  });

  it('falls back to a generic message for opaque throws', () => {
    expect(parsePlytixErrors('boom')).toEqual([{ msg: 'Unknown Plytix error' }]);
  });
});

describe('batch manifest read failures', () => {
  let tempDir: string | undefined;

  afterEach(async () => {
    if (tempDir) {
      await rm(tempDir, { recursive: true, force: true });
      tempDir = undefined;
    }
  });

  it('surfaces a clear error for a missing manifest file', async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'plytix-batch-'));
    await expect(readBatchManifest(join(tempDir, 'missing.json'))).rejects.toThrow(
      /ENOENT|no such file/
    );
  });

  it('rejects malformed JSON without echoing file contents', async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'plytix-batch-'));
    const path = join(tempDir, 'broken.json');
    await writeFile(path, '{ this is not json', 'utf8');
    await expect(readBatchManifest(path)).rejects.toThrow('valid JSON');
  });

  it('rejects manifests whose items field is not an array', async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'plytix-batch-'));
    const path = join(tempDir, 'items.json');
    await writeFile(path, JSON.stringify({ schema_version: 1, items: {} }), 'utf8');
    await expect(readBatchManifest(path)).rejects.toThrow('items must be an array');
  });

  it('rejects oversized manifest files before parsing (32 MB cap)', async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'plytix-batch-'));
    const path = join(tempDir, 'big.json');
    await writeFile(path, '{}', 'utf8');
    // Sparse-extend past the cap; the size check must fire before any parse.
    await truncate(path, 32 * 1024 * 1024 + 1);
    await expect(readBatchManifest(path)).rejects.toThrow('max is');
  });
});

describe('worker batch-update caps', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('rejects a 51-item batch via the worker handler without any Plytix call', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('network must not be called for a cap rejection');
      })
    );

    const items = Array.from({ length: 51 }, (_, index) => ({
      product_id: `product-${index}`,
      label: 'X',
    }));

    const response = await worker.fetch(
      new Request('https://mcp.example.com/mcp', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: 'Bearer test-key:test-pass',
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'tools/call',
          params: { name: 'products_batch_update', arguments: { items } },
        }),
      }),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      {} as any
    );

    const body = (await response.json()) as {
      result: { isError?: boolean; content: Array<{ text: string }> };
    };
    const payload = JSON.parse(body.result.content[0].text) as {
      status: string;
      failures: unknown[];
    };
    expect(payload.status).toBe('rejected');
    expect(JSON.stringify(payload.failures)).toContain('50');
  });
});
