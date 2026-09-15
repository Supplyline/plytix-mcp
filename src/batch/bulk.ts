/**
 * Bulk product updates over Plytix's async job endpoint.
 *
 *   POST /api/v1/bulk/products            → job record   (≤ 1,000 rows, returns at once)
 *   GET  /api/v1/bulk/products/<job_id>   → job summary  (status, counters, per-row errors)
 *
 * Shared by the stdio and Worker clients; keep it free of Node-only imports.
 *
 * Two facts about the endpoint drive the shape of this module (both verified live,
 * see docs/features/batch-update/REST-EVIDENCE.md, 2026-09-15):
 *
 * 1. The job reports `status: "Finished"` BEFORE its summary and product list are
 *    populated. A caller that stops at "Finished" sees `ok: 0` on a fully successful job.
 *    So "settled" here means finished AND the counters account for every submitted row.
 * 2. There is no optimistic-concurrency guard. A bulk job writes over whatever is live.
 *    Items that carry `expected_attributes` / `if_match` are rejected up front rather than
 *    silently stripped — use `products_batch_update` when a guard is needed.
 */

import type {
  BatchUpdateFailure,
  BatchUpdateItem,
  BatchUpdateMetadata,
  BatchUpdateSuccess,
  BatchUpdateSummary,
  BulkJobCounters,
  BulkJobInfo,
  BulkJobRecord,
  BulkJobSummary,
  BulkProductRow,
  BulkUpdateResult,
} from '../types.js';
import {
  detectDuplicateInputs,
  finishedResult,
  getBatchItemKey,
  rejectedResult,
  validateBatchItems,
  type BatchValidationOptions,
} from './helpers.js';

/** Plytix's documented per-job cap. */
export const BULK_MAX_ITEMS = 1000;
/**
 * How long a submit call will wait for the job to settle before handing back a `pending`
 * result. Kept under a typical MCP client timeout; `products_bulk_status` picks up from there.
 */
export const BULK_DEFAULT_WAIT_TIMEOUT_MS = 45_000;
/** Poll spacing: quick first look, then back off to a 2 s cadence. */
const POLL_SCHEDULE_MS = [500, 1000, 2000];

export interface BulkUpdateOperations {
  submitBulkProductUpdate(rows: BulkProductRow[]): Promise<BulkJobRecord>;
  getBulkProductJob(jobId: string): Promise<BulkJobSummary>;
}

interface ClockOptions {
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

export interface ExecuteBulkUpdateOptions extends ClockOptions {
  maxItems: number;
  maxBytes?: number;
  dryRun?: boolean;
  /** Poll the job after submitting (default true). `false` returns `pending` immediately. */
  wait?: boolean;
  waitTimeoutMs?: number;
  returnSuccesses?: boolean;
  metadata?: BatchUpdateMetadata;
}

export interface PollBulkJobOptions extends ClockOptions {
  /** Rows the job was submitted with. Without it, completion cannot be confirmed. */
  submitted?: number;
  /** Keep polling until settled or the budget runs out (default false: one snapshot). */
  wait?: boolean;
  waitTimeoutMs?: number;
  returnSuccesses?: boolean;
  metadata?: BatchUpdateMetadata;
  /** The submitted items, so failures/successes can carry the caller's row index. */
  items?: BatchUpdateItem[];
  /** Status from the submit response, reported if we never poll. */
  initialStatus?: string | null;
}

// ─────────────────────────────────────────────────────────────
// Pure helpers
// ─────────────────────────────────────────────────────────────

/** Build the request rows. `product_id` wins over `sku`; only defined data keys are sent. */
export function toBulkRows(items: BatchUpdateItem[]): BulkProductRow[] {
  return items.map((item) => {
    const data: BulkProductRow['data'] = {};
    if (item.label !== undefined) data.label = item.label;
    if (item.status !== undefined) data.status = item.status;
    if (item.attributes !== undefined) data.attributes = item.attributes;
    return item.product_id ? { id: item.product_id, data } : { sku: item.sku as string, data };
  });
}

/** Counters arrive as strings (`"4"`); anything unparsable counts as zero. */
export function normalizeCounters(summary: BulkJobSummary | undefined): BulkJobCounters {
  const read = (value: unknown): number => {
    const n = typeof value === 'number' ? value : Number.parseInt(String(value ?? ''), 10);
    return Number.isFinite(n) && n >= 0 ? n : 0;
  };
  return {
    ok: read(summary?.summary?.ok),
    error: read(summary?.summary?.error),
    cancelled: read(summary?.summary?.cancelled),
  };
}

type StatusClass = 'finished' | 'failed' | 'running' | 'unknown';

function classifyStatus(status: string | undefined | null): StatusClass {
  const s = (status ?? '').trim().toLowerCase();
  if (!s) return 'unknown';
  if (['finished', 'completed', 'done', 'success', 'succeeded'].includes(s)) return 'finished';
  if (['failed', 'failure', 'error', 'cancelled', 'canceled', 'aborted'].includes(s)) return 'failed';
  return 'running';
}

/**
 * true  — terminal, and every submitted row is accounted for.
 * false — not yet (still running, or "Finished" with counters lagging).
 * null  — finished but `submitted` is unknown, so completeness cannot be judged.
 */
export function isBulkJobSettled(
  summary: BulkJobSummary,
  submitted: number | undefined
): boolean | null {
  const cls = classifyStatus(summary.status);
  if (cls === 'failed') return true;
  if (cls !== 'finished') return false;
  if (submitted === undefined) return null;
  const c = normalizeCounters(summary);
  return c.ok + c.error + c.cancelled >= submitted;
}

// ─────────────────────────────────────────────────────────────
// Result assembly
// ─────────────────────────────────────────────────────────────

function indexMaps(items: BatchUpdateItem[] | undefined) {
  const bySku = new Map<string, number>();
  const byId = new Map<string, number>();
  (items ?? []).forEach((item, index) => {
    if (item.sku && !bySku.has(item.sku)) bySku.set(item.sku, index);
    if (item.product_id && !byId.has(item.product_id)) byId.set(item.product_id, index);
  });
  const lookup = (sku: string | undefined, id: string | undefined): number => {
    if (sku !== undefined && bySku.has(sku)) return bySku.get(sku) as number;
    if (id !== undefined && byId.has(id)) return byId.get(id) as number;
    return -1;
  };
  return { lookup };
}

function failuresFromSummary(
  summary: BulkJobSummary,
  maps: ReturnType<typeof indexMaps>
): BatchUpdateFailure[] {
  return (summary.errors ?? []).map((row) => {
    const index = maps.lookup(row.sku, row.id);
    const errors = (row.errors ?? []).flatMap((entry) =>
      Object.entries(entry ?? {}).map(([field, msg]) => ({ field, msg: String(msg) }))
    );
    return {
      key: row.sku ?? row.id ?? 'unknown',
      index,
      ...(row.id ? { product_id: row.id } : {}),
      stage: 'bulk' as const,
      errors: errors.length > 0 ? errors : [{ msg: 'row failed (no detail returned)' }],
    };
  });
}

function successesFromSummary(
  summary: BulkJobSummary,
  maps: ReturnType<typeof indexMaps>
): BatchUpdateSuccess[] {
  return (summary.products ?? []).map((p) => ({
    key: p.sku ?? p.id,
    index: maps.lookup(p.sku, p.id),
    product_id: p.id,
  }));
}

function buildResult(args: {
  jobId: string;
  snapshot: BulkJobSummary;
  settled: boolean | null;
  submitted: number | undefined;
  items?: BatchUpdateItem[];
  returnSuccesses?: boolean;
  metadata?: BatchUpdateMetadata;
  next?: string;
}): BulkUpdateResult {
  const { snapshot } = args;
  const counters = normalizeCounters(snapshot);
  const maps = indexMaps(args.items);
  const failures = failuresFromSummary(snapshot, maps);
  const total = args.submitted ?? counters.ok + counters.error + counters.cancelled;
  const jobFailed = classifyStatus(snapshot.status) === 'failed';

  if (jobFailed) {
    const accounted = counters.ok + counters.error + counters.cancelled;
    failures.push({
      key: args.jobId,
      index: -1,
      stage: 'bulk',
      errors: [
        {
          msg: `bulk job ended in status "${snapshot.status}" with ${accounted} of ${total} rows accounted for`,
        },
      ],
    });
  }

  const summary: BatchUpdateSummary = {
    total,
    succeeded: counters.ok,
    failed: failures.length,
    // Rows the server never processed are skipped; otherwise only explicit cancellations are.
    skipped: jobFailed ? Math.max(0, total - counters.ok - counters.error) : counters.cancelled,
  };
  const job: BulkJobInfo = {
    id: args.jobId,
    status: snapshot.status ?? null,
    counters,
    settled: args.settled,
  };
  const successes = args.returnSuccesses ? successesFromSummary(snapshot, maps) : undefined;
  const common = {
    job,
    summary,
    failures,
    ...(successes ? { successes } : {}),
    ...(args.metadata ? { metadata: args.metadata } : {}),
  };

  if (args.settled === true) return { status: 'finished', ...common };
  return {
    status: 'pending',
    ...common,
    next:
      args.next ??
      (args.settled === null
        ? `job reports "${snapshot.status}" but completion cannot be confirmed without expected_total; call products_bulk_status with job_id and expected_total`
        : `call products_bulk_status with job_id "${args.jobId}" (expected_total ${total}) to pick up the result`),
  };
}

// ─────────────────────────────────────────────────────────────
// Polling
// ─────────────────────────────────────────────────────────────

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export async function pollBulkJob(
  ops: BulkUpdateOperations,
  jobId: string,
  options: PollBulkJobOptions = {}
): Promise<BulkUpdateResult> {
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? defaultSleep;
  const budget = options.waitTimeoutMs ?? BULK_DEFAULT_WAIT_TIMEOUT_MS;
  const started = now();
  const common = {
    submitted: options.submitted,
    items: options.items,
    returnSuccesses: options.returnSuccesses,
    metadata: options.metadata,
  };

  for (let attempt = 0; ; attempt++) {
    const snapshot = await ops.getBulkProductJob(jobId);
    const settled = isBulkJobSettled(snapshot, options.submitted);
    if (settled !== false || !options.wait) {
      return buildResult({ jobId, snapshot, settled, ...common });
    }
    const delay = POLL_SCHEDULE_MS[Math.min(attempt, POLL_SCHEDULE_MS.length - 1)];
    if (now() - started + delay > budget) {
      return buildResult({
        jobId,
        snapshot,
        settled,
        ...common,
        next: `not settled after ${budget} ms; call products_bulk_status with job_id "${jobId}"${
          options.submitted !== undefined ? ` and expected_total ${options.submitted}` : ''
        }`,
      });
    }
    await sleep(delay);
  }
}

// ─────────────────────────────────────────────────────────────
// Submit
// ─────────────────────────────────────────────────────────────

const GUARD_FIELDS = ['expected_attributes', 'if_match'] as const;

/** Guards must be rejected loudly: the endpoint has no equivalent and would just write. */
function detectGuards(input: unknown): BatchUpdateFailure[] {
  if (!Array.isArray(input)) return [];
  const failures: BatchUpdateFailure[] = [];
  input.forEach((raw, index) => {
    if (!raw || typeof raw !== 'object') return;
    const item = raw as Partial<BatchUpdateItem>;
    for (const field of GUARD_FIELDS) {
      if (item[field] !== undefined) {
        failures.push({
          index,
          key: getBatchItemKey(item),
          ...(item.product_id ? { product_id: item.product_id } : {}),
          stage: 'validation',
          errors: [
            {
              field,
              msg: `${field} is not supported by the bulk endpoint (no optimistic guards); use products_batch_update for guarded writes`,
            },
          ],
        });
        break;
      }
    }
  });
  return failures;
}

export async function executeBulkUpdate(
  ops: BulkUpdateOperations,
  input: unknown,
  options: ExecuteBulkUpdateOptions
): Promise<BulkUpdateResult> {
  const validation: BatchValidationOptions = { maxItems: options.maxItems, maxBytes: options.maxBytes };
  const total = Array.isArray(input) ? input.length : 0;
  const { items, failures } = validateBatchItems(input, validation);
  const allFailures = [...failures, ...detectGuards(input)];
  if (allFailures.length > 0) {
    return rejectedResult(total, allFailures, options.metadata);
  }
  const duplicates = detectDuplicateInputs(items);
  if (duplicates.length > 0) {
    return rejectedResult(total, duplicates, options.metadata);
  }

  const rows = toBulkRows(items);

  if (options.dryRun) {
    return finishedResult({
      total: rows.length,
      succeeded: 0,
      failures: [],
      skipped: rows.length,
      dryRun: true,
      metadata: options.metadata,
    }) as BulkUpdateResult;
  }

  const job = await ops.submitBulkProductUpdate(rows);

  if (options.wait === false) {
    return {
      status: 'pending',
      job: {
        id: job.id,
        status: job.state ?? null,
        counters: { ok: 0, error: 0, cancelled: 0 },
        settled: false,
      },
      summary: { total: rows.length, succeeded: 0, failed: 0, skipped: 0 },
      failures: [],
      ...(options.metadata ? { metadata: options.metadata } : {}),
      next: `call products_bulk_status with job_id "${job.id}" and expected_total ${rows.length}`,
    };
  }

  return pollBulkJob(ops, job.id, {
    submitted: rows.length,
    items,
    wait: true,
    waitTimeoutMs: options.waitTimeoutMs,
    returnSuccesses: options.returnSuccesses,
    metadata: options.metadata,
    initialStatus: job.state ?? null,
    now: options.now,
    sleep: options.sleep,
  });
}
