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

  let resolution = new Map<string, ResolvedProductRef[]>();
  let resolutionError: unknown;
  if (skus.length > 0) {
    try {
      resolution = await ops.resolveProductIdsBySku(skus);
    } catch (error) {
      resolutionError = error;
    }
  }

  const failures: BatchUpdateFailure[] = [];
  const readyRows: ReadyRow[] = [];

  items.forEach((item, index) => {
    const key = getBatchItemKey(item);
    let productId = item.product_id;

    if (item.sku) {
      if (resolutionError) {
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
            (row) => checkRowGuard(ops, row)
          )
        : [];
    const guardFailures = guardResults.filter(Boolean) as BatchUpdateFailure[];

    return finishedResult({
      total,
      succeeded: 0,
      failures: [...failures, ...guardFailures],
      skipped: total,
      dryRun: true,
      metadata: options.metadata,
    });
  }

  const patchResults = await runWithConcurrency(
    readyRows,
    {
      concurrency: options.concurrency ?? DEFAULT_BATCH_CONCURRENCY,
      requestDelayMs: options.requestDelayMs ?? DEFAULT_BATCH_REQUEST_DELAY_MS,
    },
    (row) => patchRowWithRetry(ops, row)
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
  const allFailures = [...failures, ...patchFailures];
  const conflictFailures = patchFailures.filter((failure) => failure.stage === 'conflict');

  return finishedResult({
    total,
    succeeded: readyRows.length - patchFailures.length,
    failures: allFailures,
    skipped: failures.length + conflictFailures.length,
    ...(options.returnSuccesses ? { successes } : {}),
    metadata: options.metadata,
  });
}

async function checkRowGuard(
  ops: BatchUpdateOperations,
  row: ReadyRow
): Promise<BatchUpdateFailure | undefined> {
  if (!row.item.expected_attributes && !row.item.if_match) {
    return undefined;
  }

  let product: PlytixProduct | undefined;
  try {
    const result = await ops.getProduct(row.productId);
    product = result.data?.[0];
  } catch (error) {
    return {
      index: row.index,
      key: row.key,
      product_id: row.productId,
      stage: 'conflict',
      errors: parsePlytixErrors(error),
    };
  }

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
  | { status: 'failure'; failure: BatchUpdateFailure };

async function patchRowWithRetry(
  ops: BatchUpdateOperations,
  row: ReadyRow,
  retries = 2
): Promise<PatchRowResult> {
  const guardFailure = await checkRowGuard(ops, row);
  if (guardFailure) {
    return { status: 'failure', failure: guardFailure };
  }

  const body = buildPatchBody(row.item);

  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const result = await ops.updateProduct(row.productId, body);
      const updated = result.data?.[0];
      if (!updated?.id) {
        return {
          status: 'failure',
          failure: {
            index: row.index,
            key: row.key,
            product_id: row.productId,
            stage: 'patch',
            errors: [{ msg: `Product update returned no confirmed product for ${row.productId}` }],
          },
        };
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
    } catch (error) {
      if (attempt < retries && isTransientError(error)) {
        await new Promise((resolve) => setTimeout(resolve, 500 * 2 ** attempt));
        continue;
      }
      return {
        status: 'failure',
        failure: {
          index: row.index,
          key: row.key,
          product_id: row.productId,
          stage: 'patch',
          errors: parsePlytixErrors(error),
        },
      };
    }
  }

  return {
    status: 'failure',
    failure: {
      index: row.index,
      key: row.key,
      product_id: row.productId,
      stage: 'patch',
      errors: [{ msg: 'Product update retry loop exited unexpectedly' }],
    },
  };
}

function isTransientError(error: unknown): boolean {
  const status =
    error && typeof error === 'object' && 'status' in error
      ? (error as { status?: unknown }).status
      : undefined;
  if (typeof status === 'number') {
    return status === 429 || status >= 500;
  }
  return true;
}
