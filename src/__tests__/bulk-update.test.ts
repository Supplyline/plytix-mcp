import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  BULK_MAX_ITEMS,
  BULK_MAX_WAIT_TIMEOUT_MS,
  BulkSubmitError,
  executeBulkUpdate,
  isBulkJobSettled,
  normalizeCounters,
  pollBulkJob,
  toBulkRows,
  type BulkUpdateOperations,
} from '../batch/bulk.js';
import type { BulkJobRecord, BulkJobSummary } from '../types.js';

// ─────────────────────────────────────────────────────────────
// Fake endpoint. Scripts a sequence of status responses so the Finished-before-summary
// behaviour observed live (REST-EVIDENCE 2026-09-15) can be reproduced exactly.
// ─────────────────────────────────────────────────────────────

const JOB: BulkJobRecord = {
  id: 'job-1',
  state: 'CREATED',
  external_process_id: 'job-1',
  display_name: 'Edit products',
};

function summary(
  status: string,
  counters: { ok?: number; error?: number; cancelled?: number } = {},
  extra: Partial<BulkJobSummary> = {}
): BulkJobSummary {
  return {
    action: 'Edited',
    status,
    // the real API sends the counters as strings
    summary: {
      ok: String(counters.ok ?? 0),
      error: String(counters.error ?? 0),
      cancelled: String(counters.cancelled ?? 0),
    },
    products: [],
    errors: [],
    ...extra,
  };
}

function makeOps(statuses: BulkJobSummary[], submit: BulkJobRecord | Error = JOB) {
  const polls: string[] = [];
  const ops: BulkUpdateOperations & {
    submitBulkProductUpdate: ReturnType<typeof vi.fn>;
    getBulkProductJob: ReturnType<typeof vi.fn>;
    polls: string[];
  } = {
    polls,
    submitBulkProductUpdate: vi.fn(async () => {
      if (submit instanceof Error) throw submit;
      return submit;
    }),
    getBulkProductJob: vi.fn(async (jobId: string) => {
      polls.push(jobId);
      // hold the last scripted response once the script is exhausted
      return statuses[Math.min(polls.length - 1, statuses.length - 1)];
    }),
  };
  return ops;
}

/** Zero-cost clock: sleeps advance a virtual `now` instead of waiting. */
function fakeClock() {
  let now = 0;
  const sleeps: number[] = [];
  return {
    now: () => now,
    sleep: async (ms: number) => {
      sleeps.push(ms);
      now += ms;
    },
    sleeps,
  };
}

const ITEMS = [
  { sku: 'A', attributes: { box_1: 'FD' } },
  { sku: 'B', attributes: { box_1: 'FD' } },
  { product_id: 'p-c', label: 'C label' },
];

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

// ─────────────────────────────────────────────────────────────
// Pure helpers
// ─────────────────────────────────────────────────────────────

describe('toBulkRows', () => {
  it('maps items to the documented request rows', () => {
    expect(toBulkRows(ITEMS as never)).toEqual([
      { sku: 'A', data: { attributes: { box_1: 'FD' } } },
      { sku: 'B', data: { attributes: { box_1: 'FD' } } },
      { id: 'p-c', data: { label: 'C label' } },
    ]);
  });

  it('prefers id when both identifiers are given, and never sends undefined keys', () => {
    const [row] = toBulkRows([{ sku: 'A', product_id: 'p-a', status: 'Archived' }] as never);
    expect(row).toEqual({ id: 'p-a', data: { status: 'Archived' } });
    expect('sku' in row).toBe(false);
    expect('attributes' in row.data).toBe(false);
  });
});

describe('normalizeCounters / isBulkJobSettled', () => {
  it('parses string counters and treats garbage as zero', () => {
    expect(normalizeCounters({ summary: { ok: '4', error: '1', cancelled: 'x' } })).toEqual({
      ok: 4,
      error: 1,
      cancelled: 0,
    });
    expect(normalizeCounters({})).toEqual({ ok: 0, error: 0, cancelled: 0 });
  });

  it('is settled only when the counters account for every row', () => {
    expect(isBulkJobSettled(summary('Finished', { ok: 0 }), 4)).toBe(false); // the live gotcha
    expect(isBulkJobSettled(summary('Finished', { ok: 3, error: 1 }), 4)).toBe(true);
    expect(isBulkJobSettled(summary('FINISHED', { ok: 4 }), 4)).toBe(true); // case-insensitive
    // counters win over the status string — the vocabulary has already drifted once
    expect(isBulkJobSettled(summary('In progress', { ok: 4 }), 4)).toBe(true);
    expect(isBulkJobSettled(summary('Finished with errors', { ok: 3, error: 1 }), 4)).toBe(true);
    expect(isBulkJobSettled(summary('In progress', { ok: 1 }), 4)).toBe(false);
  });

  it('treats a failed/cancelled job as terminal regardless of counters', () => {
    expect(isBulkJobSettled(summary('Failed'), 4)).toBe(true);
    expect(isBulkJobSettled(summary('Cancelled'), 4)).toBe(true);
  });

  it('cannot decide without a submitted count', () => {
    expect(isBulkJobSettled(summary('Finished', { ok: 4 }), undefined)).toBeNull();
    expect(isBulkJobSettled(summary('In progress', { ok: 4 }), undefined)).toBe(false);
    expect(isBulkJobSettled(summary('Failed'), undefined)).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────
// executeBulkUpdate
// ─────────────────────────────────────────────────────────────

describe('executeBulkUpdate', () => {
  it('submits the documented body once and reports a settled job', async () => {
    const ops = makeOps([
      summary('Finished', { ok: 3 }, {
        products: [
          { id: 'p-a', sku: 'A' },
          { id: 'p-b', sku: 'B' },
          { id: 'p-c', sku: 'C' },
        ],
      }),
    ]);
    const clock = fakeClock();

    const result = await executeBulkUpdate(ops, ITEMS, {
      maxItems: BULK_MAX_ITEMS,
      returnSuccesses: true,
      ...clock,
    });

    expect(ops.submitBulkProductUpdate).toHaveBeenCalledTimes(1);
    expect(ops.submitBulkProductUpdate).toHaveBeenCalledWith(toBulkRows(ITEMS as never));
    expect(result.status).toBe('finished');
    if (result.status !== 'finished') return;
    expect(result.job).toEqual({
      id: 'job-1',
      status: 'Finished',
      counters: { ok: 3, error: 0, cancelled: 0 },
      settled: true,
    });
    expect(result.summary).toEqual({ total: 3, succeeded: 3, failed: 0, skipped: 0 });
    expect(result.failures).toEqual([]);
    expect(result.successes).toEqual([
      { key: 'A', index: 0, product_id: 'p-a' },
      { key: 'B', index: 1, product_id: 'p-b' },
      { key: 'C', index: 2, product_id: 'p-c' },
    ]);
  });

  it('keeps polling while "Finished" arrives before the summary is populated (live gotcha)', async () => {
    const ops = makeOps([
      summary('Finished', { ok: 0 }), // what the real API returned at 0.4 s
      summary('Finished', { ok: 0 }),
      summary('Finished', { ok: 3 }, { products: [{ id: 'p-a', sku: 'A' }, { id: 'p-b', sku: 'B' }, { id: 'p-c', sku: 'C' }] }),
    ]);
    const clock = fakeClock();

    const result = await executeBulkUpdate(ops, ITEMS, { maxItems: BULK_MAX_ITEMS, ...clock });

    expect(ops.polls).toHaveLength(3);
    expect(result.status).toBe('finished');
    expect(result.summary.succeeded).toBe(3);
    // backoff between polls: 500 ms, then 1 s, capped at 2 s
    expect(clock.sleeps).toEqual([500, 1000]);
  });

  it('maps server error rows to stage "bulk" failures with the field the server named', async () => {
    const ops = makeOps([
      summary('Finished', { ok: 2, error: 1 }, {
        products: [{ id: 'p-a', sku: 'A' }, { id: 'p-c', sku: 'C' }],
        errors: [{ sku: 'B', errors: [{ sku: 'sku does not exist' }, { box_1: 'not allowed' }] }],
      }),
    ]);

    const result = await executeBulkUpdate(ops, ITEMS, { maxItems: BULK_MAX_ITEMS, ...fakeClock() });

    expect(result.status).toBe('finished');
    expect(result.summary).toEqual({ total: 3, succeeded: 2, failed: 1, skipped: 0 });
    expect(result.failures).toEqual([
      {
        key: 'B',
        index: 1,
        stage: 'bulk',
        errors: [
          { field: 'sku', msg: 'sku does not exist' },
          { field: 'box_1', msg: 'not allowed' },
        ],
      },
    ]);
  });

  it('rejects any item carrying an optimistic guard, without submitting', async () => {
    const ops = makeOps([summary('Finished', { ok: 1 })]);

    const result = await executeBulkUpdate(
      ops,
      [{ sku: 'A', attributes: { x: 1 }, expected_attributes: { x: null } }, { sku: 'B', attributes: { x: 1 }, if_match: { status: 'Active' } }],
      { maxItems: BULK_MAX_ITEMS, ...fakeClock() }
    );

    expect(result.status).toBe('rejected');
    expect(ops.submitBulkProductUpdate).not.toHaveBeenCalled();
    expect(result.failures.map((f) => f.key)).toEqual(['A', 'B']);
    expect(result.failures[0]?.errors[0]?.msg).toMatch(/not supported by the bulk endpoint/);
    expect(result.failures[0]?.errors[0]?.field).toBe('expected_attributes');
    expect(result.failures[1]?.errors[0]?.field).toBe('if_match');
  });

  it('rejects duplicates and over-cap batches before any network call', async () => {
    const ops = makeOps([summary('Finished', { ok: 1 })]);

    const dup = await executeBulkUpdate(ops, [{ sku: 'A', label: 'x' }, { sku: 'A', label: 'y' }], {
      maxItems: BULK_MAX_ITEMS,
      ...fakeClock(),
    });
    expect(dup.status).toBe('rejected');
    expect(dup.failures.every((f) => f.stage === 'duplicate')).toBe(true);

    const big = await executeBulkUpdate(
      ops,
      Array.from({ length: BULK_MAX_ITEMS + 1 }, (_, i) => ({ sku: `S${i}`, label: 'x' })),
      { maxItems: BULK_MAX_ITEMS, ...fakeClock() }
    );
    expect(big.status).toBe('rejected');
    expect(big.failures[0]?.errors[0]?.msg).toMatch(/max is 1000; split into jobs of at most 1000 rows/);

    expect(ops.submitBulkProductUpdate).not.toHaveBeenCalled();
    expect(ops.getBulkProductJob).not.toHaveBeenCalled();
  });

  it('dry_run validates and counts without touching the network', async () => {
    const ops = makeOps([summary('Finished', { ok: 3 })]);

    const result = await executeBulkUpdate(ops, ITEMS, {
      maxItems: BULK_MAX_ITEMS,
      dryRun: true,
      ...fakeClock(),
    });

    expect(result).toEqual({
      status: 'finished',
      dry_run: true,
      summary: { total: 3, succeeded: 0, failed: 0, skipped: 3 },
      failures: [],
    });
    expect(ops.submitBulkProductUpdate).not.toHaveBeenCalled();
    expect(ops.getBulkProductJob).not.toHaveBeenCalled();
  });

  it('wait: false returns pending with the job id straight after submit', async () => {
    const ops = makeOps([summary('Finished', { ok: 3 })]);

    const result = await executeBulkUpdate(ops, ITEMS, {
      maxItems: BULK_MAX_ITEMS,
      wait: false,
      ...fakeClock(),
    });

    expect(result.status).toBe('pending');
    if (result.status !== 'pending') return;
    expect(result.job).toEqual({ id: 'job-1', status: 'CREATED', counters: { ok: 0, error: 0, cancelled: 0 }, settled: false });
    expect(result.next).toMatch(/products_bulk_status/);
    expect(ops.getBulkProductJob).not.toHaveBeenCalled();
  });

  it('returns pending with the latest counters when the wait budget runs out', async () => {
    const ops = makeOps([summary('In progress', { ok: 1 })]);
    const clock = fakeClock();

    const result = await executeBulkUpdate(ops, ITEMS, {
      maxItems: BULK_MAX_ITEMS,
      waitTimeoutMs: 4000,
      ...clock,
    });

    expect(result.status).toBe('pending');
    if (result.status !== 'pending') return;
    expect(result.job.status).toBe('In progress');
    expect(result.job.counters.ok).toBe(1);
    expect(result.job.settled).toBe(false);
    expect(result.summary).toEqual({ total: 3, succeeded: 1, failed: 0, skipped: 0 });
    // 500 + 1000 + 2000 = 3500 ≤ 4000; the next 2000 would exceed the budget
    expect(clock.sleeps).toEqual([500, 1000, 2000]);
    expect(clock.now()).toBeLessThanOrEqual(4000);
  });

  it('surfaces a job that ends in a terminal failure state as finished, with a job-level failure row', async () => {
    const ops = makeOps([summary('Failed')]);

    const result = await executeBulkUpdate(ops, ITEMS, { maxItems: BULK_MAX_ITEMS, ...fakeClock() });

    expect(result.status).toBe('finished');
    if (result.status !== 'finished') return;
    expect(result.job?.status).toBe('Failed');
    // summary counts rows; the job-level failure is a diagnostic row (index -1), not a row count
    expect(result.summary).toEqual({ total: 3, succeeded: 0, failed: 0, skipped: 3 });
    expect(result.failures).toEqual([
      { key: 'job-1', index: -1, stage: 'bulk', errors: [{ msg: expect.stringMatching(/job ended in status "Failed"/) }] },
    ]);
  });

  it('flags a non-429 submit failure as ambiguous — the job may have been created', async () => {
    const boom = Object.assign(new Error('Request failed: 502 - bad gateway'), { status: 502 });
    const ops = makeOps([], boom);
    const error = await executeBulkUpdate(ops, ITEMS, { maxItems: BULK_MAX_ITEMS, ...fakeClock() }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(BulkSubmitError);
    expect((error as BulkSubmitError).ambiguous).toBe(true);
    expect((error as BulkSubmitError).status).toBe(502);
    expect((error as Error).message).toMatch(/MAY still have been created/);
    expect((error as Error).message).toMatch(/do not resubmit these 3 rows/);
    expect((error as Error).message).toMatch(/502 - bad gateway/);
  });

  it('a rate-limited submit is not ambiguous — nothing was queued', async () => {
    const limited = Object.assign(new Error('429 rate limited after 4 attempts'), { status: 429 });
    const ops = makeOps([], limited);
    const error = await executeBulkUpdate(ops, ITEMS, { maxItems: BULK_MAX_ITEMS, ...fakeClock() }).catch((e: unknown) => e);
    expect((error as BulkSubmitError).ambiguous).toBe(false);
    expect((error as Error).message).toMatch(/nothing was queued/);
  });

  it('rejects guards in any shape, including ones validateBatchItems would reject first', async () => {
    const ops = makeOps([]);
    for (const guard of [{ expected_attributes: {} }, { expected_attributes: null }, { if_match: 5 }]) {
      const result = await executeBulkUpdate(ops, [{ sku: 'A', label: 'x', ...guard }], { maxItems: BULK_MAX_ITEMS, ...fakeClock() });
      expect(result.status).toBe('rejected');
    }
    expect(ops.submitBulkProductUpdate).not.toHaveBeenCalled();
  });

  it('never lets a caller raise the item cap above the endpoint limit', async () => {
    const ops = makeOps([]);
    const big = await executeBulkUpdate(ops, Array.from({ length: BULK_MAX_ITEMS + 1 }, (_, i) => ({ sku: `S${i}`, label: 'x' })), { maxItems: 5000, ...fakeClock() });
    expect(big.status).toBe('rejected');
    expect(ops.submitBulkProductUpdate).not.toHaveBeenCalled();
  });

  it('settles on the counters even when the status string is one we have never seen', async () => {
    const ops = makeOps([summary('Finished with errors', { ok: 2, error: 1 }, { errors: [{ sku: 'B', errors: [{ box_1: 'bad' }] }] })]);
    const result = await executeBulkUpdate(ops, ITEMS, { maxItems: BULK_MAX_ITEMS, ...fakeClock() });
    expect(result.status).toBe('finished');
    expect(ops.polls).toHaveLength(1);
    expect(result.summary).toEqual({ total: 3, succeeded: 2, failed: 1, skipped: 0 });
  });

  it('a failed job that also carries error rows still sums to total', async () => {
    const ops = makeOps([summary('Cancelled', { ok: 1, error: 1 }, { errors: [{ sku: 'B', errors: [{ box_1: 'bad' }] }] })]);
    const result = await executeBulkUpdate(ops, ITEMS, { maxItems: BULK_MAX_ITEMS, ...fakeClock() });
    if (result.status !== 'finished') throw new Error(result.status);
    const s = result.summary;
    expect(s).toEqual({ total: 3, succeeded: 1, failed: 1, skipped: 1 });
    expect(s.succeeded + s.failed + s.skipped).toBe(s.total);
    expect(result.failures.map((f) => f.index)).toEqual([1, -1]); // the row, then the job diagnostic
  });

  it('reconciles failed with the error counter when errors[] lags, and says so', async () => {
    const ops = makeOps([summary('Finished', { ok: 2, error: 1 })]); // counter says 1, no detail yet
    const result = await executeBulkUpdate(ops, ITEMS, { maxItems: BULK_MAX_ITEMS, ...fakeClock() });
    if (result.status !== 'finished') throw new Error(result.status);
    expect(result.summary).toEqual({ total: 3, succeeded: 2, failed: 1, skipped: 0 });
    expect(result.failures).toEqual([
      { key: 'job-1', index: -1, stage: 'bulk', errors: [{ msg: expect.stringMatching(/counts 1 failed row\(s\) but has detailed 0/) }] },
    ]);
  });

  it('attributes server rows tolerantly by SKU case/whitespace and flags unattributable ones', async () => {
    const ops = makeOps([
      summary('Finished', { ok: 1, error: 2 }, {
        products: [{ id: 'p-a', sku: ' a ' }],
        errors: [{ sku: 'b', errors: [{ box_1: 'bad' }] }, { errors: [{ box_1: 'bad' }] }],
      }),
    ]);
    const result = await executeBulkUpdate(ops, ITEMS, { maxItems: BULK_MAX_ITEMS, returnSuccesses: true, ...fakeClock() });
    if (result.status !== 'finished') throw new Error(result.status);
    expect(result.successes).toEqual([{ key: ' a ', index: 0, product_id: 'p-a' }]);
    expect(result.failures[0]).toMatchObject({ key: 'b', index: 1 });
    expect(result.failures[1]).toMatchObject({ key: 'unattributed', index: -1 });
    expect(result.failures[1]?.errors.map((e) => e.msg)).toContain('Plytix did not identify which row this error belongs to');
  });

  it('caps the wait budget at BULK_MAX_WAIT_TIMEOUT_MS whatever the caller asks for', async () => {
    const ops = makeOps([summary('In progress')]);
    const clock = fakeClock();
    const result = await executeBulkUpdate(ops, ITEMS, { maxItems: BULK_MAX_ITEMS, waitTimeoutMs: 3_600_000, ...clock });
    expect(result.status).toBe('pending');
    expect(clock.now()).toBeLessThanOrEqual(BULK_MAX_WAIT_TIMEOUT_MS);
  });

  it('keys success rows by sku even when the row was submitted by id', async () => {
    const ops = makeOps([summary('Finished', { ok: 1 }, { products: [{ id: 'p-a', sku: 'A' }] })]);

    const result = await executeBulkUpdate(ops, [{ sku: 'A', product_id: 'p-a', label: 'x' }], {
      maxItems: BULK_MAX_ITEMS,
      returnSuccesses: true,
      ...fakeClock(),
    });

    expect(ops.submitBulkProductUpdate).toHaveBeenCalledWith([{ id: 'p-a', data: { label: 'x' } }]);
    if (result.status !== 'finished') throw new Error(result.status);
    expect(result.successes).toEqual([{ key: 'A', index: 0, product_id: 'p-a' }]);
  });
});

// ─────────────────────────────────────────────────────────────
// pollBulkJob — the status tool
// ─────────────────────────────────────────────────────────────

describe('pollBulkJob', () => {
  it('settles against expected_total', async () => {
    const ops = makeOps([summary('Finished', { ok: 0 }), summary('Finished', { ok: 4 })]);
    const result = await pollBulkJob(ops, 'job-1', { submitted: 4, wait: true, ...fakeClock() });
    expect(result.status).toBe('finished');
    expect(result.status === 'finished' && result.job?.settled).toBe(true);
    expect(ops.polls).toHaveLength(2);
  });

  it('without expected_total returns one snapshot with settled: null', async () => {
    const ops = makeOps([summary('Finished', { ok: 4 })]);
    const result = await pollBulkJob(ops, 'job-1', { wait: true, ...fakeClock() });
    expect(ops.polls).toHaveLength(1);
    expect(result.status).toBe('pending');
    if (result.status !== 'pending') return;
    expect(result.job.settled).toBeNull();
    expect(result.summary).toEqual({ total: 4, succeeded: 4, failed: 0, skipped: 0 });
    expect(result.next).toMatch(/expected_total/);
  });

  it('wait: false returns the current snapshot even when not settled', async () => {
    const ops = makeOps([summary('In progress', { ok: 1 })]);
    const result = await pollBulkJob(ops, 'job-1', { submitted: 4, wait: false, ...fakeClock() });
    expect(result.status).toBe('pending');
    expect(ops.polls).toHaveLength(1);
  });
});

// ─────────────────────────────────────────────────────────────
// Worker surface
// ─────────────────────────────────────────────────────────────

describe('worker bulk-update surface', () => {
  const rpc = async (body: unknown) => {
    const { default: worker } = await import('../worker.js');
    const response = await worker.fetch(
      new Request('https://mcp.example.com/mcp', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer test-key:test-pass' },
        body: JSON.stringify(body),
      }),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      {} as any
    );
    return response.json() as Promise<{ result: { isError?: boolean; tools?: Array<{ name: string }>; content?: Array<{ text: string }> } }>;
  };

  it('lists both bulk tools', async () => {
    const body = await rpc({ jsonrpc: '2.0', id: 1, method: 'tools/list' });
    const names = body.result.tools?.map((t) => t.name) ?? [];
    expect(names).toContain('products_bulk_update');
    expect(names).toContain('products_bulk_status');
  });

  it('rejects a 1,001-item bulk update before any Plytix call', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('network must not be called for a cap rejection');
      })
    );
    const items = Array.from({ length: BULK_MAX_ITEMS + 1 }, (_, i) => ({ sku: `S${i}`, label: 'x' }));
    const body = await rpc({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'products_bulk_update', arguments: { items } } });
    const payload = JSON.parse(body.result.content?.[0]?.text ?? '{}') as { status: string; failures: unknown[] };
    expect(body.result.isError).toBe(true);
    expect(payload.status).toBe('rejected');
    expect(JSON.stringify(payload.failures)).toContain('max is 1000');
  });

  it('rejects guarded items before any Plytix call', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('network must not be called'); }));
    const body = await rpc({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'products_bulk_update', arguments: { items: [{ sku: 'A', label: 'x', if_match: { status: 'Active' } }] } } });
    const payload = JSON.parse(body.result.content?.[0]?.text ?? '{}') as { status: string; failures: Array<{ errors: Array<{ field?: string }> }> };
    expect(payload.status).toBe('rejected');
    expect(payload.failures[0]?.errors[0]?.field).toBe('if_match');
  });
});
