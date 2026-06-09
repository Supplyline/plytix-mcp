import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, it, vi, afterEach } from 'vitest';
import worker from '../worker.js';
import { readBatchManifest } from '../batch/manifest.js';
import { executeBatchUpdate, type BatchUpdateOperations } from '../batch/runner.js';
import {
  STDIO_INLINE_MAX_BYTES,
  validateBatchItems,
} from '../batch/helpers.js';
import { PlytixError, type PlytixProduct, type PlytixResult } from '../types.js';

const productResult = (id: string): PlytixResult<PlytixProduct> => ({
  data: [{ id, modified: '2026-06-09T00:00:00Z' }],
});

function makeOps(args?: {
  resolved?: Record<string, Array<{ id: string; sku?: string }>>;
  update?: (productId: string) => Promise<PlytixResult<PlytixProduct>>;
}): BatchUpdateOperations & {
  resolveProductIdsBySku: ReturnType<typeof vi.fn>;
  updateProduct: ReturnType<typeof vi.fn>;
} {
  return {
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
