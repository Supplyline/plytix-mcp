import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_DRY_RUN_LIVE_GAP_MS,
  executeBatchUpdate,
  itemsFingerprint,
  type BatchUpdateOperations,
} from '../batch/runner.js';
import { RECEIPT_SCHEMA, writeBatchReceipt } from '../batch/manifest.js';
import { VERSION } from '../version.js';
import { PlytixError, type PlytixProduct, type PlytixResult } from '../types.js';

// The transport papercuts this file pins (supplyline-etl papercuts.md, 2026-09-14 to 2026-10-08):
// a dry run followed at once by its live submit 429'd the tail of a batch; the rows behind an
// exhausted 429 kept firing into a blown window; a partial landing reported "finished".

const rateLimited = () =>
  new PlytixError(
    '429 rate limited after 4 attempts: {"message":"API rate limit exceeded","limit":50,"window_size":10}',
    429,
    '{"message":"API rate limit exceeded","limit":50,"window_size":10}',
    { limit: 50, windowSeconds: 10 }
  );

function ops(args: {
  ids: string[];
  get?: (id: string) => Promise<PlytixResult<PlytixProduct>>;
  update?: (id: string) => Promise<PlytixResult<PlytixProduct>>;
  resolveError?: unknown;
}): BatchUpdateOperations & {
  getProduct: ReturnType<typeof vi.fn>;
  updateProduct: ReturnType<typeof vi.fn>;
} {
  return {
    getProduct: vi.fn(async (id: string) =>
      args.get ? args.get(id) : { data: [{ id, attributes: { list_price: 1 } }] }
    ),
    resolveProductIdsBySku: vi.fn(async (skus: string[]) => {
      if (args.resolveError) throw args.resolveError;
      return new Map(skus.map((sku) => [sku, [{ id: `id-${sku}`, sku }]]));
    }),
    updateProduct: vi.fn(async (id: string) =>
      args.update ? args.update(id) : { data: [{ id, modified: '2026-10-15T00:00:00Z' }] }
    ),
  };
}

const guarded = (sku: string) => ({
  sku,
  attributes: { list_price: 2 },
  expected_attributes: { list_price: 1 },
});

describe('dry run readiness', () => {
  it('reports would_patch explicitly instead of only "skipped"', async () => {
    const o = ops({ ids: [] });
    const result = await executeBatchUpdate(o, [guarded('A'), guarded('B')], {
      maxItems: 20,
      dryRun: true,
      requestDelayMs: 0,
    });
    expect(result).toMatchObject({ status: 'finished', dry_run: true, would_patch: 2 });
    expect(o.updateProduct).not.toHaveBeenCalled();
  });
});

describe('an exhausted 429 halts the batch', () => {
  afterEach(() => vi.useRealTimers());

  it('defers every row not yet started and lists them, with the failed read, as unwritten', async () => {
    vi.useFakeTimers();
    const o = ops({
      ids: [],
      get: async (id) => {
        if (id === 'id-B') throw rateLimited();
        return { data: [{ id, attributes: { list_price: 1 } }] };
      },
    });
    const pending = executeBatchUpdate(o, ['A', 'B', 'C', 'D'].map(guarded), {
      maxItems: 20,
      concurrency: 1,
      requestDelayMs: 0,
      returnSuccesses: true,
    });
    await vi.advanceTimersByTimeAsync(60_000);
    const result = await pending;

    expect(result.status).toBe('partial');
    expect(result.summary).toEqual({ total: 4, succeeded: 1, failed: 3, skipped: 3 });
    expect(result.failures.map((f) => [f.key, f.stage])).toEqual([
      ['B', 'read'],
      ['C', 'deferred'],
      ['D', 'deferred'],
    ]);
    expect('unwritten' in result && result.unwritten).toEqual([
      { index: 1, key: 'B' },
      { index: 2, key: 'C' },
      { index: 3, key: 'D' },
    ]);
    // C and D made no request at all once B blew the window.
    expect(o.getProduct.mock.calls.map((c) => c[0])).not.toContain('id-C');
    expect(o.updateProduct.mock.calls.map((c) => c[0])).toEqual(['id-A']);
  });

  it('halts on a PATCH 429 too, and counts that row as unwritten', async () => {
    vi.useFakeTimers();
    const o = ops({
      ids: [],
      update: async (id) => {
        if (id === 'id-A') throw rateLimited();
        return { data: [{ id }] };
      },
    });
    const pending = executeBatchUpdate(o, [guarded('A'), guarded('B')], {
      maxItems: 20,
      concurrency: 1,
      requestDelayMs: 0,
    });
    await vi.advanceTimersByTimeAsync(60_000);
    const result = await pending;
    expect(result.status).toBe('finished'); // nothing landed, so not partial
    expect('unwritten' in result && result.unwritten).toEqual([
      { index: 0, key: 'A' },
      { index: 1, key: 'B' },
    ]);
  });

  it('never lists a non-429 PATCH failure as unwritten: it may have applied', async () => {
    const o = ops({
      ids: [],
      update: async (id) => {
        if (id === 'id-A') throw new PlytixError('Request failed: 502 - bad gateway', 502, 'bad gateway');
        return { data: [{ id }] };
      },
    });
    const result = await executeBatchUpdate(o, [guarded('A'), guarded('B')], {
      maxItems: 20,
      concurrency: 1,
      requestDelayMs: 0,
    });
    expect(result.status).toBe('partial');
    expect('unwritten' in result).toBe(false);
    expect(o.updateProduct).toHaveBeenCalledTimes(2); // a 5xx does not halt the batch
  });

  it('a dry run halts the same way, so a blown window costs no further reads', async () => {
    vi.useFakeTimers();
    const o = ops({
      ids: [],
      get: async (id) => {
        if (id === 'id-A') throw rateLimited();
        return { data: [{ id, attributes: { list_price: 1 } }] };
      },
    });
    const pending = executeBatchUpdate(o, [guarded('A'), guarded('B')], {
      maxItems: 20,
      concurrency: 1,
      requestDelayMs: 0,
      dryRun: true,
    });
    await vi.advanceTimersByTimeAsync(60_000);
    const result = await pending;
    expect(result.failures.map((f) => f.stage)).toEqual(['read', 'deferred']);
    expect(result).toMatchObject({ would_patch: 0 });
    expect(o.getProduct.mock.calls.map((c) => c[0])).not.toContain('id-B');
  });

  it('a 429 while resolving SKUs leaves every row unwritten', async () => {
    const o = ops({ ids: [], resolveError: rateLimited() });
    const result = await executeBatchUpdate(o, [guarded('A'), guarded('B')], {
      maxItems: 20,
      requestDelayMs: 0,
    });
    expect(result.failures.map((f) => f.stage)).toEqual(['resolve', 'resolve']);
    expect('unwritten' in result && result.unwritten?.map((u) => u.key)).toEqual(['A', 'B']);
  });
});

describe('dry run to live pacing', () => {
  const clockAt = (start: number) => {
    let clock = start;
    const sleep = vi.fn(async (ms: number) => {
      clock += ms;
    });
    return { now: () => clock, sleep, advance: (ms: number) => (clock += ms) };
  };

  it('waits out the gap before a live submit of the identical items', async () => {
    const o = ops({ ids: [] });
    const t = clockAt(5_000_000);
    const items = [guarded('A')];
    await executeBatchUpdate(o, items, { maxItems: 20, dryRun: true, requestDelayMs: 0, ...t });
    t.advance(3_000);
    const result = await executeBatchUpdate(o, items, { maxItems: 20, requestDelayMs: 0, ...t });
    expect(t.sleep).toHaveBeenCalledWith(DEFAULT_DRY_RUN_LIVE_GAP_MS - 3_000);
    expect(result).toMatchObject({ status: 'finished', paced_ms: DEFAULT_DRY_RUN_LIVE_GAP_MS - 3_000 });
  });

  it('does not wait once the gap has passed, for other items, for another client, or at gap 0', async () => {
    const t = clockAt(9_000_000);
    const o = ops({ ids: [] });
    await executeBatchUpdate(o, [guarded('A')], { maxItems: 20, dryRun: true, requestDelayMs: 0, ...t });
    await executeBatchUpdate(o, [guarded('B')], { maxItems: 20, requestDelayMs: 0, ...t });
    await executeBatchUpdate(ops({ ids: [] }), [guarded('A')], { maxItems: 20, requestDelayMs: 0, ...t });
    await executeBatchUpdate(o, [guarded('A')], { maxItems: 20, requestDelayMs: 0, dryRunLiveGapMs: 0, ...t });
    expect(t.sleep).not.toHaveBeenCalled();
    t.advance(DEFAULT_DRY_RUN_LIVE_GAP_MS);
    const late = await executeBatchUpdate(o, [guarded('A')], { maxItems: 20, requestDelayMs: 0, ...t });
    expect(t.sleep).not.toHaveBeenCalled();
    expect('paced_ms' in late).toBe(false);
  });

  it('fingerprints identical items identically and different items differently', () => {
    expect(itemsFingerprint([guarded('A')])).toBe(itemsFingerprint([guarded('A')]));
    expect(itemsFingerprint([guarded('A')])).not.toBe(itemsFingerprint([guarded('B')]));
  });
});

describe('manifest receipts', () => {
  let dir: string | undefined;
  afterEach(async () => {
    if (dir) await rm(dir, { recursive: true, force: true });
    dir = undefined;
  });

  it('writes the result next to the manifest and never overwrites one', async () => {
    dir = await mkdtemp(join(tmpdir(), 'plytix-receipt-'));
    const manifest = join(dir, 'fix.chunk-001.json');
    await writeFile(manifest, '{"schema_version":1,"items":[]}');
    const now = new Date('2026-10-15T06:00:00.000Z');
    const result = { status: 'finished', summary: { total: 0, succeeded: 0, failed: 0, skipped: 0 }, failures: [] };
    const first = await writeBatchReceipt(manifest, result, { dryRun: true, manifestSha256: 'abc', now });
    const second = await writeBatchReceipt(manifest, result, { dryRun: true, now });
    expect(first).toBe(join(dir, 'fix.chunk-001.receipt.dry-run.2026-10-15T06-00-00-000Z.json'));
    expect(second).not.toBe(first);
    const body = JSON.parse(await readFile(first, 'utf-8'));
    expect(body).toEqual({
      schema: RECEIPT_SCHEMA,
      manifest_path: manifest,
      manifest_sha256: 'abc',
      dry_run: true,
      written_at: '2026-10-15T06:00:00.000Z',
      result,
    });
    expect((await readdir(dir)).length).toBe(3);
  });
});

describe('server version', () => {
  it('comes from package.json, not a hand-edited constant', () => {
    const pkg = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf-8'));
    expect(VERSION).toBe(pkg.version);
  });
});
