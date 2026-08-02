import type {
  BatchUpdateErrorDetail,
  BatchUpdateFailure,
  BatchUpdateItem,
  BatchUpdateMetadata,
  BatchUpdateResult,
  BatchUpdateSuccess,
} from '../types.js';

export const STDIO_INLINE_MAX_ITEMS = 250;
export const WORKER_INLINE_MAX_ITEMS = 50;
export const MANIFEST_MAX_ITEMS = 10_000;
export const STDIO_INLINE_MAX_BYTES = 512 * 1024;
export const WORKER_INLINE_MAX_BYTES = 256 * 1024;
export const MANIFEST_MAX_BYTES = 32 * 1024 * 1024;
export const DEFAULT_BATCH_CONCURRENCY = 3;
export const DEFAULT_BATCH_REQUEST_DELAY_MS = 250;

export interface BatchValidationOptions {
  maxItems: number;
  maxBytes?: number;
}

export interface BatchValidationResult {
  items: BatchUpdateItem[];
  failures: BatchUpdateFailure[];
}

export interface PatchBody {
  label?: string;
  status?: string;
  attributes?: Record<string, unknown>;
}

export function getBatchItemKey(item: Partial<BatchUpdateItem> | undefined): string {
  return item?.sku || item?.product_id || 'batch';
}

export function measureSerializedBytes(value: unknown): number {
  return new TextEncoder().encode(JSON.stringify(value)).length;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function makeFailure(
  index: number,
  item: Partial<BatchUpdateItem> | undefined,
  stage: BatchUpdateFailure['stage'],
  msg: string,
  field?: string
): BatchUpdateFailure {
  return {
    index,
    key: getBatchItemKey(item),
    ...(item?.product_id ? { product_id: item.product_id } : {}),
    stage,
    errors: [{ ...(field ? { field } : {}), msg }],
  };
}

export function buildPatchBody(item: BatchUpdateItem): PatchBody {
  const body: PatchBody = {};
  if (item.label !== undefined) body.label = item.label;
  if (item.status !== undefined) body.status = item.status;
  if (item.attributes !== undefined && Object.keys(item.attributes).length > 0) {
    body.attributes = item.attributes;
  }
  return body;
}

export function validateBatchItems(
  input: unknown,
  options: BatchValidationOptions
): BatchValidationResult {
  const failures: BatchUpdateFailure[] = [];

  if (!Array.isArray(input)) {
    return {
      items: [],
      failures: [makeFailure(-1, undefined, 'validation', 'items must be an array', 'items')],
    };
  }

  if (input.length > options.maxItems) {
    failures.push(
      makeFailure(
        -1,
        undefined,
        'validation',
        `batch has ${input.length} items; max is ${options.maxItems}`,
        'items'
      )
    );
  }

  if (options.maxBytes !== undefined) {
    const bytes = measureSerializedBytes(input);
    if (bytes > options.maxBytes) {
      failures.push(
        makeFailure(
          -1,
          undefined,
          'validation',
          `inline payload is ${bytes} bytes; max is ${options.maxBytes}`,
          'items'
        )
      );
    }
  }

  const items: BatchUpdateItem[] = [];
  input.forEach((raw, index) => {
    if (!isPlainObject(raw)) {
      failures.push(makeFailure(index, undefined, 'validation', 'item must be an object'));
      return;
    }

    const item = raw as Partial<BatchUpdateItem>;
    const normalized: BatchUpdateItem = {};

    if (item.sku !== undefined) {
      if (typeof item.sku !== 'string' || item.sku.trim() === '') {
        failures.push(makeFailure(index, item, 'validation', 'sku must be a non-empty string', 'sku'));
      } else {
        normalized.sku = item.sku;
      }
    }

    if (item.product_id !== undefined) {
      if (typeof item.product_id !== 'string' || item.product_id.trim() === '') {
        failures.push(
          makeFailure(index, item, 'validation', 'product_id must be a non-empty string', 'product_id')
        );
      } else {
        normalized.product_id = item.product_id;
      }
    }

    if (!normalized.sku && !normalized.product_id) {
      failures.push(
        makeFailure(index, item, 'validation', 'at least one of sku or product_id is required')
      );
    }

    if (item.label !== undefined) {
      if (typeof item.label !== 'string') {
        failures.push(makeFailure(index, item, 'validation', 'label must be a string', 'label'));
      } else {
        normalized.label = item.label;
      }
    }

    if (item.status !== undefined) {
      if (typeof item.status !== 'string') {
        failures.push(makeFailure(index, item, 'validation', 'status must be a string', 'status'));
      } else {
        normalized.status = item.status;
      }
    }

    if (item.attributes !== undefined) {
      if (!isPlainObject(item.attributes)) {
        failures.push(
          makeFailure(index, item, 'validation', 'attributes must be an object', 'attributes')
        );
      } else {
        normalized.attributes = item.attributes;
      }
    }

    if (item.expected_attributes !== undefined) {
      if (!isPlainObject(item.expected_attributes)) {
        failures.push(
          makeFailure(
            index,
            item,
            'validation',
            'expected_attributes must be an object',
            'expected_attributes'
          )
        );
      } else if (Object.keys(item.expected_attributes).length === 0) {
        failures.push(
          makeFailure(
            index,
            item,
            'validation',
            'expected_attributes must not be empty',
            'expected_attributes'
          )
        );
      } else {
        normalized.expected_attributes = item.expected_attributes;
      }
    }

    if (item.if_match !== undefined) {
      if (!isPlainObject(item.if_match)) {
        failures.push(
          makeFailure(index, item, 'validation', 'if_match must be an object', 'if_match')
        );
      } else if (Object.keys(item.if_match).length === 0) {
        failures.push(
          makeFailure(index, item, 'validation', 'if_match must not be empty', 'if_match')
        );
      } else {
        normalized.if_match = item.if_match;
      }
    }

    const hasAttributes =
      normalized.attributes !== undefined && Object.keys(normalized.attributes).length > 0;
    if (
      normalized.label === undefined &&
      normalized.status === undefined &&
      !hasAttributes
    ) {
      failures.push(
        makeFailure(
          index,
          item,
          'validation',
          'at least one update field is required: label, status, or non-empty attributes'
        )
      );
    }

    items[index] = normalized;
  });

  failures.push(...detectDuplicateInputs(items));

  return { items, failures };
}

export function detectDuplicateInputs(items: BatchUpdateItem[]): BatchUpdateFailure[] {
  const failures: BatchUpdateFailure[] = [];
  const bySku = new Map<string, number[]>();
  const byProductId = new Map<string, number[]>();

  items.forEach((item, index) => {
    if (item?.sku) {
      bySku.set(item.sku, [...(bySku.get(item.sku) ?? []), index]);
    }
    if (item?.product_id) {
      byProductId.set(item.product_id, [...(byProductId.get(item.product_id) ?? []), index]);
    }
  });

  for (const [sku, indices] of bySku) {
    if (indices.length > 1) {
      for (const index of indices) {
        failures.push(
          makeFailure(index, items[index], 'duplicate', `duplicate sku in batch: ${sku}`, 'sku')
        );
      }
    }
  }

  for (const [productId, indices] of byProductId) {
    if (indices.length > 1) {
      for (const index of indices) {
        failures.push(
          makeFailure(
            index,
            items[index],
            'duplicate',
            `duplicate product_id in batch: ${productId}`,
            'product_id'
          )
        );
      }
    }
  }

  return failures;
}

export function detectDuplicateResolvedTargets(
  rows: Array<{ index: number; item: BatchUpdateItem; productId: string }>
): BatchUpdateFailure[] {
  const byProductId = new Map<string, Array<{ index: number; item: BatchUpdateItem }>>();
  for (const row of rows) {
    byProductId.set(row.productId, [
      ...(byProductId.get(row.productId) ?? []),
      { index: row.index, item: row.item },
    ]);
  }

  const failures: BatchUpdateFailure[] = [];
  for (const [productId, matches] of byProductId) {
    if (matches.length > 1) {
      for (const match of matches) {
        failures.push(
          makeFailure(
            match.index,
            match.item,
            'duplicate',
            `post-resolution duplicate product_id in batch: ${productId}`,
            'product_id'
          )
        );
      }
    }
  }
  return failures;
}

export function parsePlytixErrors(error: unknown): BatchUpdateErrorDetail[] {
  const response = error && typeof error === 'object' && 'response' in error
    ? (error as { response?: unknown }).response
    : undefined;
  const parsed = parseErrorPayload(response) ?? parseErrorPayload(error);

  const details = parsed?.error?.errors;
  if (Array.isArray(details) && details.length > 0) {
    return details.map((detail) => ({
      ...(typeof detail?.field === 'string' ? { field: detail.field } : {}),
      msg: typeof detail?.msg === 'string' ? detail.msg : JSON.stringify(detail),
    }));
  }

  const message =
    (typeof parsed?.error?.msg === 'string' && parsed.error.msg) ||
    (typeof parsed?.msg === 'string' && parsed.msg) ||
    (error instanceof Error ? error.message : undefined) ||
    'Unknown Plytix error';
  return [{ msg: message }];
}

function parseErrorPayload(value: unknown): any {
  if (!value) return undefined;
  if (typeof value === 'string') {
    try {
      return JSON.parse(value);
    } catch {
      return undefined;
    }
  }
  if (typeof value === 'object') return value;
  return undefined;
}

export function rejectedResult(
  total: number,
  failures: BatchUpdateFailure[],
  metadata?: BatchUpdateMetadata
): BatchUpdateResult {
  return {
    status: 'rejected',
    summary: {
      total,
      succeeded: 0,
      failed: failures.length,
      // Conservative: a rejected batch patches nothing, so every row counts as
      // skipped — including rows that also appear in failures[].
      skipped: total,
    },
    failures,
    ...(metadata ? { metadata } : {}),
  };
}

export function finishedResult(args: {
  total: number;
  succeeded: number;
  failures: BatchUpdateFailure[];
  skipped: number;
  dryRun?: boolean;
  successes?: BatchUpdateSuccess[];
  metadata?: BatchUpdateMetadata;
}): BatchUpdateResult {
  return {
    status: 'finished',
    ...(args.dryRun ? { dry_run: true } : {}),
    summary: {
      total: args.total,
      succeeded: args.succeeded,
      failed: args.failures.length,
      skipped: args.skipped,
    },
    failures: args.failures,
    ...(args.successes ? { successes: args.successes } : {}),
    ...(args.metadata ? { metadata: args.metadata } : {}),
  };
}

export async function runWithConcurrency<T, R>(
  items: T[],
  options: { concurrency: number; requestDelayMs: number },
  handler: (item: T) => Promise<R>
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let nextIndex = 0;
  let nextStartAt = Date.now();

  async function reserveStartSlot(): Promise<void> {
    const startAt = Math.max(Date.now(), nextStartAt);
    nextStartAt = startAt + options.requestDelayMs;
    const delayMs = startAt - Date.now();
    if (delayMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }

  async function worker(): Promise<void> {
    while (nextIndex < items.length) {
      const currentIndex = nextIndex++;
      await reserveStartSlot();
      results[currentIndex] = await handler(items[currentIndex]);
    }
  }

  const workers = Array.from(
    { length: Math.min(options.concurrency, Math.max(items.length, 1)) },
    () => worker()
  );
  await Promise.all(workers);
  return results;
}
