import type {
  BatchUpdateFailure,
  BatchUpdateItem,
  BatchUpdateMetadata,
  BatchUpdateResult,
  BatchUpdateSuccess,
  PlytixProduct,
  PlytixResult,
} from '../types.js';
import {
  DEFAULT_BATCH_CONCURRENCY,
  DEFAULT_BATCH_REQUEST_DELAY_MS,
  buildPatchBody,
  detectDuplicateResolvedTargets,
  finishedResult,
  getBatchItemKey,
  parsePlytixErrors,
  rejectedResult,
  runWithConcurrency,
  validateBatchItems,
  runTransientRetry,
} from './helpers.js';

export interface ResolvedProductRef {
  id: string;
  sku?: string;
}

export interface BatchUpdateOperations {
  getProduct(productId: string): Promise<PlytixResult<PlytixProduct>>;
  resolveProductIdsBySku(skus: string[]): Promise<Map<string, ResolvedProductRef[]>>;
  updateProduct(
    productId: string,
    body: {
      label?: string;
      status?: string;
      attributes?: Record<string, unknown>;
    }
  ): Promise<PlytixResult<PlytixProduct>>;
}

export interface ExecuteBatchUpdateOptions {
  maxItems: number;
  maxBytes?: number;
  dryRun?: boolean;
  metadata?: BatchUpdateMetadata;
  concurrency?: number;
  requestDelayMs?: number;
  returnSuccesses?: boolean;
  /**
   * Minimum gap between a dry run and the live submit of the identical items through the same
   * client. The dry run's guard reads and the live run's guard reads plus PATCHes otherwise land
   * in one 10 s window and 429 the tail of the batch. Default DEFAULT_DRY_RUN_LIVE_GAP_MS.
   */
  dryRunLiveGapMs?: number;
  /** Test seams. */
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

/** 12 s: past one full 50 req / 10 s window, the gap sessions kept having to add by hand. */
export const DEFAULT_DRY_RUN_LIVE_GAP_MS = 12_000;
const DRY_RUN_MEMORY_LIMIT = 50;
const DEFERRED_MSG =
  'not started: an earlier row exhausted the account rate window; resubmit this row unchanged';

/** Dry runs per client (the stdio server keeps one client for its lifetime). */
const dryRunMemory = new WeakMap<object, Map<string, number>>();

/** FNV-1a over the serialized items: identical items, identical fingerprint. */
export function itemsFingerprint(items: unknown): string {
  const text = JSON.stringify(items) ?? '';
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return `${text.length}:${hash.toString(16)}`;
}

function isRateLimited(error: unknown): boolean {
  return (
    !!error &&
    typeof error === 'object' &&
    'status' in error &&
    (error as { status?: unknown }).status === 429
  );
}

/** Shared by every row of one call: the first exhausted 429 stops new rows from starting. */
interface RunState {
  halted: boolean;
}

function deferredFailure(row: ReadyRow): BatchUpdateFailure {
  return {
    index: row.index,
    key: row.key,
    product_id: row.productId,
    stage: 'deferred',
    errors: [{ msg: DEFERRED_MSG }],
  };
}

interface ReadyRow {
  index: number;
  item: BatchUpdateItem;
  key: string;
  productId: string;
}

export async function executeBatchUpdate(
  ops: BatchUpdateOperations,
  input: unknown,
  options: ExecuteBatchUpdateOptions
): Promise<BatchUpdateResult> {
  const validation = validateBatchItems(input, {
    maxItems: options.maxItems,
    maxBytes: options.maxBytes,
  });
  const total = Array.isArray(input) ? input.length : 0;
  if (validation.failures.length > 0) {
    return rejectedResult(total, validation.failures, options.metadata);
  }

  const items = validation.items;
  const skus = Array.from(new Set(items.map((item) => item.sku).filter(Boolean) as string[]));

  const now = options.now ?? Date.now;
  const sleep =
    options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const run: RunState = { halted: false };
  const unwrittenIndexes = new Set<number>();
  const fingerprint = itemsFingerprint(items);
  let memory = dryRunMemory.get(ops);
  if (!memory) {
    memory = new Map();
    dryRunMemory.set(ops, memory);
  }

  // A live submit of items dry-run moments ago through this client waits out the window first,
  // before ANY live request: SKU resolution included, or it meets the window the dry run used.
  let pacedMs = 0;
  const dryRunAt = memory.get(fingerprint);
  const gapMs = options.dryRunLiveGapMs ?? DEFAULT_DRY_RUN_LIVE_GAP_MS;
  if (!options.dryRun && dryRunAt !== undefined) {
    const wait = gapMs - (now() - dryRunAt);
    if (wait > 0) {
      pacedMs = Math.round(wait);
      await sleep(wait);
    }
  }

  let resolution = new Map<string, ResolvedProductRef[]>();
  let resolutionError: unknown;
  if (skus.length > 0) {
    try {
      resolution = await ops.resolveProductIdsBySku(skus);
    } catch (error) {
      resolutionError = error;
      // An exhausted 429 here blew the window for the product-ID rows too: defer them.
      if (isRateLimited(error)) run.halted = true;
    }
  }

  const failures: BatchUpdateFailure[] = [];
  const readyRows: ReadyRow[] = [];

  items.forEach((item, index) => {
    const key = getBatchItemKey(item);
    let productId = item.product_id;

    if (item.sku) {
      if (resolutionError) {
        // The resolution request failed at the transport, so no row behind it was read or
        // written: every one is safe to resubmit. (Not-found and ambiguous SKUs are results,
        // not errors, and stay out of `unwritten`.)
        unwrittenIndexes.add(index);
        failures.push({
          index,
          key,
          ...(productId ? { product_id: productId } : {}),
          stage: 'resolve',
          errors: parsePlytixErrors(resolutionError),
        });
        return;
      }

      const matches = resolution.get(item.sku) ?? [];
      if (matches.length === 0) {
        failures.push({
          index,
          key,
          ...(productId ? { product_id: productId } : {}),
          stage: 'resolve',
          errors: [{ field: 'sku', msg: `SKU not found: ${item.sku}` }],
        });
        return;
      }
      if (matches.length > 1) {
        failures.push({
          index,
          key,
          ...(productId ? { product_id: productId } : {}),
          stage: 'resolve',
          errors: [{ field: 'sku', msg: `SKU resolved to multiple products: ${item.sku}` }],
        });
        return;
      }

      const resolvedId = matches[0].id;
      if (productId && productId !== resolvedId) {
        failures.push({
          index,
          key,
          product_id: productId,
          stage: 'verify',
          errors: [
            {
              field: 'product_id',
              msg: `SKU ${item.sku} resolves to ${resolvedId}, not ${productId}`,
            },
          ],
        });
        return;
      }
      productId = productId ?? resolvedId;
    }

    if (!productId) {
      failures.push({
        index,
        key,
        stage: 'resolve',
        errors: [{ field: 'product_id', msg: 'product_id could not be resolved' }],
      });
      return;
    }

    readyRows.push({ index, item, key, productId });
  });

  const duplicateFailures = detectDuplicateResolvedTargets(readyRows);
  if (duplicateFailures.length > 0) {
    return rejectedResult(total, [...failures, ...duplicateFailures], options.metadata);
  }

  if (options.dryRun) {
    const guardRows = readyRows.filter((row) => row.item.expected_attributes || row.item.if_match);
    const guardResults =
      guardRows.length > 0
        ? await runWithConcurrency(
            guardRows,
            {
              concurrency: options.concurrency ?? DEFAULT_BATCH_CONCURRENCY,
              requestDelayMs: options.requestDelayMs ?? DEFAULT_BATCH_REQUEST_DELAY_MS,
            },
            (row) =>
              run.halted
                ? Promise.resolve(deferredFailure(row))
                : runTransientRetry(() => checkRowGuard(ops, row)).catch(
                    (error): BatchUpdateFailure => {
                      if (isRateLimited(error)) run.halted = true;
                      return {
                        index: row.index,
                        key: row.key,
                        product_id: row.productId,
                        stage: 'read',
                        errors: parsePlytixErrors(error),
                      };
                    }
                  )
          )
        : [];
    const guardFailures = guardResults.filter(Boolean) as BatchUpdateFailure[];
    const dryRunFailures = [...failures, ...guardFailures];
    // Remember only a dry run that spent requests (SKU resolution or guard reads): a
    // request-free dry run used no window, so its live submit has nothing to wait out.
    if (skus.length > 0 || guardRows.length > 0) {
      memory.delete(fingerprint); // re-insert so eviction stays least-recently-used
      memory.set(fingerprint, now());
      while (memory.size > DRY_RUN_MEMORY_LIMIT) {
        memory.delete(memory.keys().next().value as string);
      }
    }

    return {
      ...finishedResult({
        total,
        succeeded: 0,
        failures: dryRunFailures,
        // Failed rows are not also "skipped": skipped counts only the rows that
        // would have been patched, so failed + skipped === total in a dry run.
        skipped: total - dryRunFailures.length,
        dryRun: true,
        metadata: options.metadata,
      }),
      would_patch: total - dryRunFailures.length,
    };
  }

  const patchResults = await runWithConcurrency(
    readyRows,
    {
      concurrency: options.concurrency ?? DEFAULT_BATCH_CONCURRENCY,
      requestDelayMs: options.requestDelayMs ?? DEFAULT_BATCH_REQUEST_DELAY_MS,
    },
    (row) => patchRowWithRetry(ops, row, undefined, run)
  );

  const patchFailures = patchResults
    .filter((result): result is { status: 'failure'; failure: BatchUpdateFailure } =>
      result?.status === 'failure'
    )
    .map((result) => result.failure);
  const successes = patchResults
    .filter((result): result is { status: 'success'; success: BatchUpdateSuccess } =>
      result?.status === 'success'
    )
    .map((result) => result.success);
  for (const result of patchResults) {
    if (result?.status === 'failure' && result.unwritten) unwrittenIndexes.add(result.failure.index);
  }
  const allFailures = [...failures, ...patchFailures];
  // Rows whose guard read failed (transport), drifted (conflict) or never started (deferred)
  // never reached PATCH.
  const conflictFailures = patchFailures.filter(
    (failure) =>
      failure.stage === 'conflict' || failure.stage === 'read' || failure.stage === 'deferred'
  );
  const succeeded = readyRows.length - patchFailures.length;
  const unwritten = allFailures
    .filter((failure) => unwrittenIndexes.has(failure.index))
    .sort((a, b) => a.index - b.index)
    .map((failure) => ({ index: failure.index, key: failure.key }));

  const result = finishedResult({
    total,
    succeeded,
    failures: allFailures,
    skipped: failures.length + conflictFailures.length,
    ...(options.returnSuccesses ? { successes } : {}),
    metadata: options.metadata,
  });
  return {
    ...result,
    // Some rows patched and some did not: say so in the status, not only in the counts.
    ...(succeeded > 0 && allFailures.length > 0 ? { status: 'partial' as const } : {}),
    ...(unwritten.length > 0 ? { unwritten } : {}),
    ...(pacedMs > 0 ? { paced_ms: pacedMs } : {}),
  } as BatchUpdateResult;
}

async function checkRowGuard(
  ops: BatchUpdateOperations,
  row: ReadyRow
): Promise<BatchUpdateFailure | undefined> {
  if (!row.item.expected_attributes && !row.item.if_match) {
    return undefined;
  }

  // Transport failures propagate: the caller reports them as `read`, never `conflict`.
  const result = await ops.getProduct(row.productId);
  const product: PlytixProduct | undefined = result.data?.[0];

  if (!product?.id) {
    return {
      index: row.index,
      key: row.key,
      product_id: row.productId,
      stage: 'conflict',
      errors: [{ msg: `Product guard check returned no product for ${row.productId}` }],
    };
  }

  const errors = [
    ...compareExpectedAttributes(product, row.item.expected_attributes),
    ...compareIfMatch(product, row.item.if_match),
  ];
  if (errors.length === 0) return undefined;

  return {
    index: row.index,
    key: row.key,
    product_id: row.productId,
    stage: 'conflict',
    errors,
  };
}

function compareExpectedAttributes(
  product: PlytixProduct,
  expected?: Record<string, unknown>
): Array<{ field?: string; msg: string }> {
  if (!expected) return [];

  return Object.entries(expected)
    .filter(([field, value]) => !guardValueMatches(product.attributes?.[field], value))
    .map(([field]) => ({
      field: `expected_attributes.${field}`,
      msg: 'live attribute no longer matches expected value',
    }));
}

function compareIfMatch(
  product: PlytixProduct,
  expected?: Record<string, unknown>
): Array<{ field?: string; msg: string }> {
  if (!expected) return [];

  return Object.entries(expected)
    .filter(([field, value]) => !guardValueMatches(readProductPath(product, field), value))
    .map(([field]) => ({
      field: `if_match.${field}`,
      msg: 'live field no longer matches expected value',
    }));
}

function readProductPath(product: PlytixProduct, path: string): unknown {
  if (path.startsWith('attributes.')) {
    return product.attributes?.[path.slice('attributes.'.length)];
  }
  return product[path];
}

function guardValueMatches(live: unknown, expected: unknown): boolean {
  // JSON cannot express `undefined`, so a guard's `null` means "expect empty": it matches a
  // live value that is null OR absent. A present empty string is a value and does NOT match.
  // Nullish equivalence applies only at the TOP level of the expected object — nested nulls
  // inside objects/arrays compare strictly via valuesEqual.
  if (expected === null) return live === null || live === undefined;
  return valuesEqual(live, expected);
}

function valuesEqual(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true;
  if (Array.isArray(left) && Array.isArray(right)) {
    return (
      left.length === right.length &&
      left.every((value, index) => valuesEqual(value, right[index]))
    );
  }
  if (isComparableObject(left) && isComparableObject(right)) {
    const leftKeys = Object.keys(left).sort();
    const rightKeys = Object.keys(right).sort();
    return (
      leftKeys.length === rightKeys.length &&
      leftKeys.every((key, index) => key === rightKeys[index] && valuesEqual(left[key], right[key]))
    );
  }
  return false;
}

function isComparableObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

type PatchRowResult =
  | { status: 'success'; success: BatchUpdateSuccess }
  | { status: 'failure'; failure: BatchUpdateFailure; unwritten?: boolean };

async function patchRowWithRetry(
  ops: BatchUpdateOperations,
  row: ReadyRow,
  retries?: number,
  run: RunState = { halted: false }
): Promise<PatchRowResult> {
  const failure = (
    stage: 'read' | 'patch',
    errors: BatchUpdateFailure['errors'],
    unwritten: boolean
  ): PatchRowResult => ({
    status: 'failure',
    failure: { index: row.index, key: row.key, product_id: row.productId, stage, errors },
    unwritten,
  });

  if (run.halted) {
    return { status: 'failure', failure: deferredFailure(row), unwritten: true };
  }

  let guardFailure: BatchUpdateFailure | undefined;
  try {
    guardFailure = await runTransientRetry(() => checkRowGuard(ops, row), { retries });
  } catch (error) {
    // The guard read precedes the PATCH, so a failed read wrote nothing.
    if (isRateLimited(error)) run.halted = true;
    return failure('read', parsePlytixErrors(error), true);
  }
  if (guardFailure) {
    return { status: 'failure', failure: guardFailure };
  }

  const body = buildPatchBody(row.item);
  let result: PlytixResult<PlytixProduct>;
  try {
    result = await runTransientRetry(() => ops.updateProduct(row.productId, body), {
      retries,
      mutation: true,
    });
  } catch (error) {
    // A 429 means Plytix did not process the PATCH; any other error may have applied it.
    const rateLimited = isRateLimited(error);
    if (rateLimited) run.halted = true;
    return failure('patch', parsePlytixErrors(error), rateLimited);
  }

  const updated = result.data?.[0];
  if (!updated?.id) {
    return failure(
      'patch',
      [{ msg: `Product update returned no confirmed product for ${row.productId}` }],
      false
    );
  }
  return {
    status: 'success',
    success: {
      index: row.index,
      key: row.key,
      product_id: updated.id,
      ...(typeof updated.modified === 'string' ? { modified: updated.modified } : {}),
    },
  };
}
