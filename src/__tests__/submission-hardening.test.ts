import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PlytixClient } from '../client.js';
import { TokenBucket, fetchWithRetry } from '../rate-limit.js';
import { MutationNotSubmittedError, PlytixError, type BatchUpdateResult } from '../types.js';
import { executeBatchUpdate } from '../batch/runner.js';
import { readBatchManifest } from '../batch/manifest.js';
import { executeManifestUpdate, manifestResponse } from '../batch/manifest-submit.js';
import { parseAdapterArgs, runSupplylineSubmission } from '../extensions/supplyline-submit.js';

const dirs: string[] = [];
afterEach(async () => {
  vi.unstubAllGlobals();
  for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true });
});
const outcome = (): BatchUpdateResult => ({ status: 'finished', dry_run: false,
  summary: { total: 1, succeeded: 1, failed: 0, skipped: 0 }, failures: [],
  successes: [{ index: 0, key: 'p1', product_id: 'p1' }] });
async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), 'submission-test-')); dirs.push(dir);
  const manifest = join(dir, 'manifest.json');
  await writeFile(manifest, JSON.stringify({ schema_version: 1, items: [
    { product_id: 'p1', attributes: { description: 'new' }, expected_attributes: { description: 'old' } },
  ] }));
  const hash = (await readBatchManifest(manifest)).metadata.manifest_sha256;
  const context = join(dir, 'attempt.json');
  await writeFile(context, JSON.stringify({ schema: 'supplyline-submit/1', run_id: 'w03-all-test',
    ledger_path: join(dir, 'ledger.json'), chunk_name: 'chunk-001', manifest_path: manifest,
    manifest_sha256: hash, dry_run: false, created_at: new Date().toISOString(),
    expires_at: Date.now() / 1000 + 100, state: 'reserved', artifact_dir: dir }));
  return { dir, manifest, context };
}

describe('mutation dispatch guard', () => {
  it('threads the guard through the real client batch path without changing legacy callers', async () => {
    const fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({ data: [{ access_token: 'fake-token' }] }), { status: 200 }));
    vi.stubGlobal('fetch', fetch);
    const client = new PlytixClient({ apiKey: 'fake', apiPassword: 'fake' });
    const gate = vi.fn(async () => { throw new Error('lease expired'); });
    const result = await client.batchUpdateProducts([{ product_id: 'p1', attributes: { a: 1 } }],
      { beforeMutation: gate, concurrency: 1, requestDelayMs: 0, returnSuccesses: true });
    expect(gate).toHaveBeenCalledTimes(1);
    expect(fetch).toHaveBeenCalledTimes(1); // auth only; PATCH never sent
    expect(result).toMatchObject({ unwritten: [{ index: 0 }], failures: [{ stage: 'deferred' }] });
  });
  it('runs after bucket and refreshed auth, and refuses before fetch', async () => {
    const order: string[] = [];
    let now = 0;
    const bucket = new TokenBucket({ limit: 10, windowMs: 10000 });
    vi.spyOn(bucket, 'take').mockImplementation(async () => { order.push('pace'); now++; });
    const fetch = vi.fn(); vi.stubGlobal('fetch', fetch);
    await expect(fetchWithRetry({ url: 'https://example.test/p', init: { method: 'PATCH' },
      method: 'PATCH', path: '/api/v2/products/p', bucket, timeoutMs: 1000, log: vi.fn(), now: () => now,
      getToken: async () => { order.push('auth'); return 'fake'; },
      beforeMutation: async () => { order.push('gate'); throw new Error('expired'); },
    })).rejects.toBeInstanceOf(MutationNotSubmittedError);
    expect(order).toEqual(['auth', 'pace', 'auth', 'gate']);
    expect(fetch).not.toHaveBeenCalled();
  });
  it('checks again after 429 retry pacing and stops a now-expired lease', async () => {
    const bucket = new TokenBucket({ limit: 10, windowMs: 10000 });
    vi.spyOn(bucket, 'take').mockResolvedValue(undefined);
    const fetch = vi.fn().mockResolvedValue(new Response('{"ttl":1}', { status: 429 }));
    vi.stubGlobal('fetch', fetch);
    let afterWait = false;
    const guard = vi.fn(async () => { if (afterWait) throw new Error('expired during backoff'); });
    await expect(fetchWithRetry({ url: 'https://example.test/p', init: { method: 'PATCH' },
      method: 'PATCH', path: '/api/v2/products/p', bucket, timeoutMs: 1000, log: vi.fn(),
      beforeMutation: guard, rand: () => 0, sleep: async () => { afterWait = true; },
    })).rejects.toBeInstanceOf(MutationNotSubmittedError);
    expect(fetch).toHaveBeenCalledTimes(1); expect(guard).toHaveBeenCalledTimes(2);
  });
  it('checks again after 401 auth retry', async () => {
    const bucket = new TokenBucket({ limit: 10, windowMs: 10000 });
    vi.spyOn(bucket, 'take').mockResolvedValue(undefined);
    const fetch = vi.fn().mockResolvedValue(new Response('', { status: 401 }));
    vi.stubGlobal('fetch', fetch);
    let reauthed = false;
    const guard = vi.fn(async () => { if (reauthed) throw new Error('hold'); });
    await expect(fetchWithRetry({ url: 'https://example.test/p', init: { method: 'PATCH' },
      method: 'PATCH', path: '/api/v2/products/p', bucket, timeoutMs: 1000, log: vi.fn(),
      getToken: async () => 'fake', onUnauthorized: () => { reauthed = true; }, beforeMutation: guard,
    })).rejects.toBeInstanceOf(MutationNotSubmittedError);
    expect(fetch).toHaveBeenCalledTimes(1); expect(guard).toHaveBeenCalledTimes(2);
  });
  it('classifies pre-dispatch refusal as unwritten and defers later rows', async () => {
    const update = vi.fn().mockRejectedValue(new MutationNotSubmittedError('expired'));
    const result = await executeBatchUpdate({ getProduct: vi.fn(), resolveProductIdsBySku: vi.fn(), updateProduct: update },
      [{ product_id: 'p1', attributes: { a: 1 } }, { product_id: 'p2', attributes: { a: 2 } }],
      { maxItems: 20, concurrency: 1, requestDelayMs: 0, beforeMutation: async () => {}, returnSuccesses: true });
    expect(update).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({ unwritten: [{ index: 0 }, { index: 1 }] });
  });
});

describe('retained compact manifests', () => {
  it('retains exact full success evidence and returns a compact view only afterward', async () => {
    const { manifest } = await fixture();
    const full = outcome(); const batch = vi.fn().mockResolvedValue(full);
    const result = await executeManifestUpdate({ batchUpdateProducts: batch }, manifest, { compact: true });
    expect(batch.mock.calls[0][1]).toMatchObject({ returnSuccesses: true });
    const receipt = JSON.parse(await readFile(result.receipt_path!, 'utf8'));
    expect(receipt.result).toEqual(outcome());
    const compact = manifestResponse(result, true);
    expect(compact).not.toHaveProperty('successes'); expect(compact).toHaveProperty('receipt_path');
    expect(manifestResponse(result)).toHaveProperty('successes');
  });
  it('never drops successes when receipt persistence fails after a write', async () => {
    const { manifest, dir } = await fixture();
    const batch = vi.fn(async () => { await rm(dir, { recursive: true, force: true }); return outcome(); });
    const result = await executeManifestUpdate({ batchUpdateProducts: batch }, manifest, { compact: true });
    expect(result.receipt_error).toBeTruthy(); expect(manifestResponse(result, true)).toHaveProperty('successes');
  });
  it('refuses disabled receipt and changed bytes before invoking a writer', async () => {
    const { manifest } = await fixture(); const batch = vi.fn();
    await expect(executeManifestUpdate({ batchUpdateProducts: batch }, manifest,
      { compact: true, writeReceipt: false })).rejects.toThrow('requires retained');
    await expect(executeManifestUpdate({ batchUpdateProducts: batch }, manifest,
      { expectedSha256: '0'.repeat(64) })).rejects.toThrow('hash differs');
    expect(batch).not.toHaveBeenCalled();
  });
  it('adapter refuses initial gate before API access, retains raw readback on success', async () => {
    const { context, dir } = await fixture();
    const client = { batchUpdateProducts: vi.fn().mockResolvedValue(outcome()),
      getProduct: vi.fn().mockResolvedValue({ data: [{ id: 'p1', attributes: { description: 'new' } }] }) };
    const options = { context, python: '/python', etlRoot: '/etl' };
    await expect(runSupplylineSubmission(options, { client, gate: async () => { throw new Error('held'); } })).rejects.toThrow('held');
    expect(client.batchUpdateProducts).not.toHaveBeenCalled();
    const second = await fixture();
    const result = await runSupplylineSubmission({ ...options, context: second.context }, { client, gate: async () => {} });
    expect(result).toMatchObject({ verification_required: true, readback_count: 1, execution_evidence_incomplete: false });
    const raw = JSON.parse(await readFile(join(second.dir, 'readback-001.json'), 'utf8'));
    const report = JSON.parse(await readFile(result.readback_path as string, 'utf8'));
    expect(raw.response.data).toEqual(report.products);
    expect(result).not.toHaveProperty('successes');
    expect(client.batchUpdateProducts.mock.calls[0][1].beforeMutation).toBeTypeOf('function');
    await expect(runSupplylineSubmission({ ...options, context: second.context }, { client, gate: async () => {} })).rejects.toThrow('EEXIST');
    expect(client.batchUpdateProducts).toHaveBeenCalledTimes(1);
  });
  it('fails receipt preflight before API work when evidence cannot be created', async () => {
    const { dir, manifest } = await fixture();
    const tooLongForReceipt = join(dir, 'x'.repeat(230) + '.json');
    await writeFile(tooLongForReceipt, await readFile(manifest));
    const batch = vi.fn();
    await expect(executeManifestUpdate({ batchUpdateProducts: batch }, tooLongForReceipt,
      { requireReceipt: true, compact: true })).rejects.toThrow();
    expect(batch).not.toHaveBeenCalled();
  });
  it('distinguishes admission from dispatch checks and retains failed raw read evidence', async () => {
    const { context, dir } = await fixture();
    const gate = vi.fn(async (_admit?: boolean) => {});
    const client = { batchUpdateProducts: vi.fn(async (_items, options) => {
      await options.beforeMutation(); return outcome();
    }), getProduct: vi.fn().mockRejectedValue(new PlytixError('read failed', 503, { error: 'source unavailable' })) };
    const result = await runSupplylineSubmission({ context, python: '/python', etlRoot: '/etl' }, { client, gate });
    expect(gate.mock.calls).toEqual([[true], []]);
    expect(result).toMatchObject({ execution_evidence_incomplete: true, readback_count: 0, verification_required: true });
    const error = JSON.parse(await readFile(join(dir, 'readback-001.json.error.json'), 'utf8'));
    expect(error).toMatchObject({ product_id: 'p1', status: 503, response: { error: 'source unavailable' } });
  });
  it('rejects ambiguous/missing CLI paths and duplicate flags', () => {
    expect(() => parseAdapterArgs(['--context', 'relative'])).toThrow();
    expect(() => parseAdapterArgs(['--context', '/a', '--context', '/b'])).toThrow();
    expect(parseAdapterArgs(['--context', '/a', '--python', '/p', '--etl-root', '/e'])).toEqual({ context: '/a', python: '/p', etlRoot: '/e' });
  });
});
