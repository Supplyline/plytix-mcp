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
  BatchUpdateErrorDetail,
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
/** Hard ceiling on any wait, whatever the caller asks for. Polling is a subrequest each time. */
export const BULK_MAX_WAIT_TIMEOUT_MS = 120_000;
/**
 * Ceiling on the serialized request body for one job. The server's own limit is unknown;
 * a 620-row manifest measured ~1.5 MB, so this leaves room without letting a 32 MB manifest
 * through as a single POST.
 */
export const BULK_MAX_BODY_BYTES = 8 * 1024 * 1024;
/** Poll spacing: quick first look, then back off to a 2 s cadence. */
const POLL_SCHEDULE_MS = [500, 1000, 2000];

/** Thrown when the submit call fails; `ambiguous` is false only for a 429 (nothing queued). */
export class BulkSubmitError extends Error {
  readonly status?: number;
  readonly ambiguous: boolean;
  constructor(message: string, public readonly cause: unknown) {
    super(message);
    this.name = 'BulkSubmitError';
    const status = (cause as { status?: unknown })?.status;
    this.status = typeof status === 'number' ? status : undefined;
    this.ambiguous = this.status !== 429;
  }
}

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
 * true  — every submitted row is accounted for by the counters (whatever the status string
 *         says — Plytix's vocabulary has already drifted from its own draft doc, so the
 *         counters are the stronger signal), or the job ended in a failure state.
 * false — not yet (still running, or "Finished" with counters lagging).
 * null  — finished but `submitted` is unknown, so completeness cannot be judged.
 */
export function isBulkJobSettled(
  summary: BulkJobSummary,
  submitted: number | undefined
): boolean | null {
  const cls = classifyStatus(summary.status);
  if (cls === 'failed') return true;
  if (submitted !== undefined) {
    const c = normalizeCounters(summary);
    if (c.ok + c.error + c.cancelled >= submitted) return true;
    return false;
  }
  return cls === 'finished' ? null : false;
}

// ─────────────────────────────────────────────────────────────
// Result assembly
// ─────────────────────────────────────────────────────────────

function indexMaps(items: BatchUpdateItem[] | undefined) {
  const bySku = new Map<string, number>();
  const byId = new Map<string, number>();
  // Plytix echoes SKUs back as stored; match tolerantly on case and surrounding whitespace.
  const norm = (sku: string) => sku.trim().toLowerCase();
  (items ?? []).forEach((item, index) => {
    if (item.sku && !bySku.has(norm(item.sku))) bySku.set(norm(item.sku), index);
    if (item.product_id && !byId.has(item.product_id)) byId.set(item.product_id, index);
  });
  const lookup = (sku: string | undefined, id: string | undefined): number => {
    if (sku !== undefined && bySku.has(norm(sku))) return bySku.get(norm(sku)) as number;
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
    const errors: BatchUpdateErrorDetail[] = (row.errors ?? []).flatMap((entry) =>
      Object.entries(entry ?? {}).map(([field, msg]) => ({ field, msg: String(msg) }))
    );
    if (index === -1 && !row.sku && !row.id) {
      errors.push({ msg: 'Plytix did not identify which row this error belongs to' });
    }
    return {
      key: row.sku ?? row.id ?? 'unattributed',
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
  const errorRows = failures.length;
  const total = args.submitted ?? counters.ok + counters.error + counters.cancelled;
  const jobFailed = classifyStatus(snapshot.status) === 'failed';

  // `summary` counts ROWS and is reconciled with the server counters: the errors[] list can
  // lag the counters just as products[] does. Diagnostic rows below carry index -1 and are
  // reported in failures[] but never counted as rows.
  const failed = Math.max(errorRows, counters.error);
  if (counters.error > errorRows) {
    failures.push({
      key: args.jobId,
      index: -1,
      stage: 'bulk',
      errors: [
        {
          msg: `Plytix counts ${counters.error} failed row(s) but has detailed ${errorRows}; re-poll products_bulk_status for the rest`,
        },
      ],
    });
  }
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
    failed,
    // On a failed job every unprocessed row is skipped; otherwise only explicit cancellations.
    skipped: jobFailed ? Math.max(0, total - counters.ok - failed) : counters.cancelled,
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
  const budget = Math.min(options.waitTimeoutMs ?? BULK_DEFAULT_WAIT_TIMEOUT_MS, BULK_MAX_WAIT_TIMEOUT_MS);
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
  // validateBatchItems also enforces the per-batch item cap and rejects duplicate inputs.
  const validation: BatchValidationOptions = {
    maxItems: Math.min(options.maxItems, BULK_MAX_ITEMS),
    maxBytes: Math.min(options.maxBytes ?? BULK_MAX_BODY_BYTES, BULK_MAX_BODY_BYTES),
  };
  const total = Array.isArray(input) ? input.length : 0;
  const { items, failures } = validateBatchItems(input, validation);
  const allFailures = [...failures, ...detectGuards(input)].map((f) =>
    f.errors.some((e) => /max is \d+$/.test(e.msg) && e.field === 'items' && /items;/.test(e.msg))
      ? { ...f, errors: f.errors.map((e) => ({ ...e, msg: `${e.msg}; split into jobs of at most ${BULK_MAX_ITEMS} rows` })) }
      : f
  );
  if (allFailures.length > 0) {
    return rejectedResult(total, allFailures, options.metadata);
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

  let job: BulkJobRecord;
  try {
    job = await ops.submitBulkProductUpdate(rows);
  } catch (error) {
    // A 429 means Plytix did not process the request. Anything else after the request was
    // sent (5xx, timeout, connection reset) is ambiguous: the job MAY have been created and
    // there is no job-listing endpoint to check. Say so, loudly, instead of inviting a rerun.
    const status = (error as { status?: unknown })?.status;
    const detail = error instanceof Error ? error.message : String(error);
    const message =
      status === 429
        ? `bulk submit was rate limited and nothing was queued: ${detail}`
        : `bulk submit failed after the request was sent — the job MAY still have been created on Plytix; do not resubmit these ${rows.length} rows without checking the products first: ${detail}`;
    throw new BulkSubmitError(message, error);
  }

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
    now: options.now,
    sleep: options.sleep,
  });
}
