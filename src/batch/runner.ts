import type {
  BatchUpdateFailure,
  BatchUpdateItem,
  BatchUpdateMetadata,
  BatchUpdateResult,
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
    return finishedResult({
      total,
      succeeded: 0,
      failures,
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

  const patchFailures = patchResults.filter(Boolean) as BatchUpdateFailure[];
  const allFailures = [...failures, ...patchFailures];

  return finishedResult({
    total,
    succeeded: readyRows.length - patchFailures.length,
    failures: allFailures,
    skipped: failures.length,
    metadata: options.metadata,
  });
}

async function patchRowWithRetry(
  ops: BatchUpdateOperations,
  row: ReadyRow,
  retries = 2
): Promise<BatchUpdateFailure | undefined> {
  const body = buildPatchBody(row.item);

  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const result = await ops.updateProduct(row.productId, body);
      const updated = result.data?.[0];
      if (!updated?.id) {
        return {
          index: row.index,
          key: row.key,
          product_id: row.productId,
          stage: 'patch',
          errors: [{ msg: `Product update returned no confirmed product for ${row.productId}` }],
        };
      }
      return undefined;
    } catch (error) {
      if (attempt < retries && isTransientError(error)) {
        await new Promise((resolve) => setTimeout(resolve, 500 * 2 ** attempt));
        continue;
      }
      return {
        index: row.index,
        key: row.key,
        product_id: row.productId,
        stage: 'patch',
        errors: parsePlytixErrors(error),
      };
    }
  }

  return undefined;
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
