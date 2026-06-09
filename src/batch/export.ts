import type {
  BatchUpdateErrorDetail,
  PlytixProduct,
  PlytixResult,
  PlytixSearchBody,
  ProductBatchExportFailure,
  ProductBatchExportFormat,
  ProductBatchExportInput,
  ProductBatchExportLimitReason,
  ProductBatchExportMetadata,
  ProductBatchExportResult,
  ProductBatchExportSummary,
} from '../types.js';
import {
  DEFAULT_BATCH_CONCURRENCY,
  DEFAULT_BATCH_REQUEST_DELAY_MS,
  measureSerializedBytes,
  parsePlytixErrors,
  runWithConcurrency,
} from './helpers.js';

export const STDIO_EXPORT_INLINE_MAX_ROWS = 250;
export const WORKER_EXPORT_INLINE_MAX_ROWS = 100;
export const FILE_EXPORT_MAX_ROWS = 100_000;
export const FILE_EXPORT_MAX_BYTES = 256 * 1024 * 1024;
export const STDIO_EXPORT_INLINE_MAX_BYTES = 512 * 1024;
export const WORKER_EXPORT_INLINE_MAX_BYTES = 256 * 1024;
export const DEFAULT_EXPORT_PAGE_SIZE = 100;
export const MAX_EXPORT_PAGE_SIZE = 100;
export const DEFAULT_EXPORT_PREVIEW_ROWS = 5;
export const MAX_EXPORT_PREVIEW_ROWS = 20;
export const MAX_EXPORT_ATTRIBUTES = 50;

export interface ProductExportOperations {
  searchProducts(body: PlytixSearchBody): Promise<PlytixResult<PlytixProduct>>;
  getProduct(productId: string): Promise<PlytixResult<PlytixProduct>>;
}

export interface ExecuteBatchExportOptions {
  mode: 'inline' | 'file';
  maxRows: number;
  maxResponseBytes?: number;
  maxFileBytes?: number;
  sink?: ProductExportSink;
  metadata?: Partial<ProductBatchExportMetadata>;
  concurrency?: number;
  requestDelayMs?: number;
}

export interface ProductExportSinkResult {
  products?: PlytixProduct[];
  preview: PlytixProduct[];
  rowCount: number;
  exportSha256?: string;
  outputPath?: string;
  format?: ProductBatchExportFormat;
}

export interface ProductExportSink {
  accept(product: PlytixProduct): Promise<ProductBatchExportLimitReason | undefined>;
  finish(): Promise<ProductExportSinkResult>;
  abort(): Promise<void>;
}

type NormalizedInput =
  | {
      mode: 'search';
      filters?: PlytixSearchBody['filters'];
      sort?: unknown;
      confirmFullCatalog: boolean;
      attributes?: string[];
      maxRows: number;
      maxRowsExplicit: boolean;
      pageSize: number;
      previewRows: number;
      querySha256?: string;
    }
  | {
      mode: 'skus';
      skus: string[];
      attributes?: string[];
      maxRows: number;
      maxRowsExplicit: boolean;
      pageSize: number;
      previewRows: number;
      querySha256?: string;
    }
  | {
      mode: 'product_ids';
      productIds: string[];
      maxRows: number;
      maxRowsExplicit: boolean;
      pageSize: number;
      previewRows: number;
      querySha256?: string;
    };

interface ValidationResult {
  input?: NormalizedInput;
  failures: ProductBatchExportFailure[];
  requested?: number;
}

interface ExportState {
  failures: ProductBatchExportFailure[];
  pagesRead: number;
  matched?: number;
  truncated: boolean;
  limitReason?: ProductBatchExportLimitReason;
  attributesObserved: Set<string>;
}

export class InlineProductExportSink implements ProductExportSink {
  private readonly products: PlytixProduct[] = [];
  private readonly preview: PlytixProduct[] = [];

  constructor(private readonly previewRows: number) {}

  async accept(product: PlytixProduct): Promise<undefined> {
    this.products.push(product);
    if (this.preview.length < this.previewRows) {
      this.preview.push(product);
    }
    return undefined;
  }

  async finish(): Promise<ProductExportSinkResult> {
    return {
      products: this.products,
      preview: this.preview,
      rowCount: this.products.length,
      exportSha256: await sha256Hex(this.products.map(canonicalJsonLine).join('')),
    };
  }

  async abort(): Promise<void> {
    this.products.length = 0;
    this.preview.length = 0;
  }
}

export async function executeBatchExport(
  ops: ProductExportOperations,
  rawInput: unknown,
  options: ExecuteBatchExportOptions
): Promise<ProductBatchExportResult> {
  const startedAt = new Date().toISOString();
  const validation = await validateExportInput(rawInput, options);

  if (!validation.input) {
    return rejectedExport({
      requested: validation.requested,
      failures: validation.failures,
      startedAt,
      selectorMode: readSelectorMode(rawInput),
    });
  }

  const input = validation.input;
  const attributesRequested = getAttributesRequested(input);
  const sink = options.sink ?? new InlineProductExportSink(input.previewRows);
  const state: ExportState = {
    failures: [],
    pagesRead: 0,
    truncated: false,
    attributesObserved: new Set<string>(),
  };

  try {
    if (input.mode === 'search') {
      await exportBySearch(ops, input, sink, state, options);
    } else if (input.mode === 'skus') {
      await exportBySkus(ops, input, sink, state, options);
    } else {
      await exportByProductIds(ops, input, sink, state, options);
    }
  } catch (error) {
    await sink.abort();
    const limitReason = readLimitReason(error);
    return rejectedExport({
      requested: getRequested(input),
      matched: state.matched,
      failures: [
        ...state.failures,
        {
          key: input.mode === 'search' ? `search:page:${state.pagesRead + 1}` : input.mode,
          stage: limitReason ? 'limit' : input.mode === 'search' ? 'fetch' : 'write',
          errors: parsePlytixErrors(error),
        },
      ],
      startedAt,
      selectorMode: input.mode,
      querySha256: input.querySha256,
      pageSize: input.pageSize,
      pagesRead: state.pagesRead,
      attributesRequested,
      ...(limitReason ? { limitReason } : {}),
    });
  }

  let sinkResult: ProductExportSinkResult;
  try {
    sinkResult = await sink.finish();
  } catch (error) {
    await sink.abort();
    return rejectedExport({
      requested: getRequested(input),
      matched: state.matched,
      failures: [
        ...state.failures,
        {
          key: options.mode === 'file' ? 'output_path' : 'batch_export',
          stage: 'write',
          errors: parsePlytixErrors(error),
        },
      ],
      startedAt,
      selectorMode: input.mode,
      querySha256: input.querySha256,
      pageSize: input.pageSize,
      pagesRead: state.pagesRead,
      attributesRequested,
    });
  }
  const completedAt = new Date().toISOString();
  const metadata: ProductBatchExportMetadata = {
    selector_mode: input.mode,
    row_count: sinkResult.rowCount,
    page_size: input.pageSize,
    started_at: startedAt,
    completed_at: completedAt,
    query_sha256: input.querySha256,
    ...(sinkResult.exportSha256 ? { export_sha256: sinkResult.exportSha256 } : {}),
    ...(sinkResult.outputPath ? { output_path: sinkResult.outputPath } : {}),
    ...(sinkResult.format ? { format: sinkResult.format } : {}),
    ...(state.pagesRead ? { pages_read: state.pagesRead } : {}),
    ...(attributesRequested ? { attributes_requested: attributesRequested } : {}),
    ...(state.attributesObserved.size > 0
      ? { attributes_returned_observed: Array.from(state.attributesObserved).sort() }
      : {}),
    ...options.metadata,
  };
  const summary: ProductBatchExportSummary = {
    requested: getRequested(input),
    ...(state.matched !== undefined ? { matched: state.matched } : {}),
    exported: sinkResult.rowCount,
    failed: state.failures.length,
    truncated: state.truncated,
    ...(state.limitReason ? { limit_reason: state.limitReason } : {}),
  };

  const result: ProductBatchExportResult = {
    status: 'finished',
    mode: options.mode,
    ...(options.mode === 'inline' ? { products: sinkResult.products ?? [] } : {}),
    preview: sinkResult.preview,
    summary,
    failures: state.failures,
    metadata,
  };

  if (options.mode === 'inline' && options.maxResponseBytes !== undefined) {
    const responseBytes = measureSerializedBytes(result);
    if (responseBytes > options.maxResponseBytes) {
      await sink.abort();
      return rejectedExport({
        requested: getRequested(input),
        matched: state.matched,
        failures: [
          makeFailure(
            'batch_export',
            'limit',
            `inline response is ${responseBytes} bytes; max is ${options.maxResponseBytes}`
          ),
        ],
        startedAt,
        selectorMode: input.mode,
        querySha256: input.querySha256,
        pageSize: input.pageSize,
        pagesRead: state.pagesRead,
        attributesRequested,
        limitReason: 'inline_byte_cap',
      });
    }
  }

  return result;
}

async function exportBySearch(
  ops: ProductExportOperations,
  input: Extract<NormalizedInput, { mode: 'search' }>,
  sink: ProductExportSink,
  state: ExportState,
  options: ExecuteBatchExportOptions
): Promise<void> {
  let page = 1;
  let exported = 0;
  let stop = false;

  while (!stop && exported < input.maxRows) {
    const remaining = input.maxRows - exported;
    const result = await searchProductsWithRetry(ops, {
      ...(input.filters ? { filters: input.filters } : {}),
      ...(input.attributes ? { attributes: input.attributes } : {}),
      ...(input.sort !== undefined ? { sort: input.sort } : {}),
      pagination: { page, page_size: input.pageSize },
    });

    state.pagesRead += 1;
    observeReturnedAttributes(result, state.attributesObserved);
    if (result.pagination?.total !== undefined) {
      state.matched = result.pagination.total;
    }

    const products = result.data ?? [];
    const selected = products.slice(0, remaining);

    for (const product of selected) {
      const limitReason = await sink.accept(product);
      if (limitReason) {
        if (options.mode === 'file') {
          state.truncated = true;
          state.limitReason = limitReason;
          stop = true;
          break;
        }
        throw makeLimitError(limitReason, 'inline export exceeded its byte cap');
      }
      exported += 1;
    }

    const hasUnselectedRows = products.length > selected.length;
    const hasMorePages = hasMoreSearchPages(result, page, exported);
    if (hasUnselectedRows || (exported >= input.maxRows && hasMorePages)) {
      state.truncated = true;
      state.limitReason = 'max_rows';
      stop = true;
    } else if (!hasMorePages) {
      stop = true;
    } else {
      page += 1;
    }
  }

  if (
    options.mode === 'inline' &&
    !input.maxRowsExplicit &&
    state.truncated &&
    state.limitReason === 'max_rows'
  ) {
    await sink.abort();
    throw makeLimitError('inline_row_cap', 'inline search matched more rows than the inline cap');
  }
}

async function exportBySkus(
  ops: ProductExportOperations,
  input: Extract<NormalizedInput, { mode: 'skus' }>,
  sink: ProductExportSink,
  state: ExportState,
  options: ExecuteBatchExportOptions
): Promise<void> {
  const bySku = new Map<string, PlytixProduct[]>();
  const attributes = input.attributes ? Array.from(new Set(['sku', ...input.attributes])) : ['sku'];
  const chunkSize = input.pageSize;

  for (let i = 0; i < input.skus.length; i += chunkSize) {
    const batch = input.skus.slice(i, i + chunkSize);
    let page = 1;
    let totalPages = 1;

    do {
      const result = await searchProductsWithRetry(ops, {
        filters: [[{ field: 'sku', operator: 'in', value: batch }]],
        attributes,
        pagination: { page, page_size: chunkSize },
      });

      state.pagesRead += 1;
      observeReturnedAttributes(result, state.attributesObserved);
      for (const product of result.data ?? []) {
        if (typeof product.sku !== 'string') continue;
        bySku.set(product.sku, [...(bySku.get(product.sku) ?? []), product]);
      }

      totalPages = Math.max(result.pagination?.pages ?? 1, 1);
      page += 1;
    } while (page <= totalPages);
  }

  for (let index = 0; index < input.skus.length; index += 1) {
    const sku = input.skus[index];
    const matches = bySku.get(sku) ?? [];
    if (matches.length === 0) {
      state.failures.push(makeFailure(sku, 'resolve', `SKU not found: ${sku}`, 'sku', index));
      continue;
    }
    if (matches.length > 1) {
      state.failures.push(
        makeFailure(sku, 'resolve', `SKU resolved to multiple products: ${sku}`, 'sku', index)
      );
      continue;
    }

    await acceptDeterministicProduct(sink, matches[0], input.mode);
  }
}

async function exportByProductIds(
  ops: ProductExportOperations,
  input: Extract<NormalizedInput, { mode: 'product_ids' }>,
  sink: ProductExportSink,
  state: ExportState,
  options: ExecuteBatchExportOptions
): Promise<void> {
  const results = await runWithConcurrency(
    input.productIds.map((productId, index) => ({ productId, index })),
    {
      concurrency: options.concurrency ?? DEFAULT_BATCH_CONCURRENCY,
      requestDelayMs: options.requestDelayMs ?? DEFAULT_BATCH_REQUEST_DELAY_MS,
    },
    async ({ productId, index }) => {
      try {
        const result = await getProductWithRetry(ops, productId);
        const product = result.data?.[0];
        if (!product?.id) {
          return {
            product: undefined,
            failure: makeFailure(
              productId,
              'fetch',
              `Product not found: ${productId}`,
              'product_id',
              index
            ),
          };
        }
        return { product, failure: undefined };
      } catch (error) {
        return {
          product: undefined,
          failure: {
            key: productId,
            index,
            stage: 'fetch' as const,
            errors: parsePlytixErrors(error),
          },
        };
      }
    }
  );

  for (const result of results) {
    if (result.failure) {
      state.failures.push(result.failure);
      continue;
    }
    if (result.product) {
      await acceptDeterministicProduct(sink, result.product, input.mode);
    }
  }
}

async function acceptDeterministicProduct(
  sink: ProductExportSink,
  product: PlytixProduct,
  mode: 'skus' | 'product_ids'
): Promise<void> {
  const limitReason = await sink.accept(product);
  if (!limitReason) return;

  await sink.abort();
  throw makeLimitError(
    limitReason,
    `${mode} export exceeded a hard output limit before all requested products were written`
  );
}

async function getProductWithRetry(
  ops: ProductExportOperations,
  productId: string,
  retries = 2
): Promise<PlytixResult<PlytixProduct>> {
  return runTransientRetry(() => ops.getProduct(productId), retries);
}

async function searchProductsWithRetry(
  ops: ProductExportOperations,
  body: PlytixSearchBody,
  retries = 2
): Promise<PlytixResult<PlytixProduct>> {
  return runTransientRetry(() => ops.searchProducts(body), retries);
}

async function runTransientRetry<T>(fn: () => Promise<T>, retries = 2): Promise<T> {
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try {
      return await fn();
    } catch (error) {
      if (attempt < retries && isTransientError(error)) {
        await new Promise((resolve) => setTimeout(resolve, 500 * 2 ** attempt));
        continue;
      }
      throw error;
    }
  }
  throw new Error('Transient retry loop exited unexpectedly');
}

async function validateExportInput(
  rawInput: unknown,
  options: ExecuteBatchExportOptions
): Promise<ValidationResult> {
  const failures: ProductBatchExportFailure[] = [];
  if (!isPlainObject(rawInput)) {
    return {
      failures: [makeFailure('batch_export', 'validation', 'input must be an object')],
    };
  }

  const input = rawInput as Partial<ProductBatchExportInput> & Record<string, unknown>;
  const mode = input.mode;
  if (mode !== 'search' && mode !== 'skus' && mode !== 'product_ids') {
    return {
      failures: [
        makeFailure(
          'batch_export',
          'validation',
          'mode must be one of: search, skus, product_ids',
          'mode'
        ),
      ],
    };
  }

  const attributes = normalizeAttributes(input.attributes, failures);
  const previewRows = normalizePositiveInt(
    input.preview_rows,
    'preview_rows',
    DEFAULT_EXPORT_PREVIEW_ROWS,
    MAX_EXPORT_PREVIEW_ROWS,
    failures
  );
  const pageSize = normalizePositiveInt(
    input.page_size,
    'page_size',
    DEFAULT_EXPORT_PAGE_SIZE,
    MAX_EXPORT_PAGE_SIZE,
    failures
  );
  const maxRowsExplicit = input.max_rows !== undefined;
  const rawMaxRows = normalizePositiveInt(
    input.max_rows,
    'max_rows',
    undefined,
    options.maxRows,
    failures
  );

  if (mode !== 'search' && input.sort !== undefined) {
    failures.push(makeFailure(mode, 'validation', 'sort is only supported for search mode', 'sort'));
  }
  if (mode !== 'search' && input.filters !== undefined) {
    failures.push(
      makeFailure(mode, 'validation', 'filters are only supported for search mode', 'filters')
    );
  }
  if (mode !== 'search' && input.confirm_full_catalog !== undefined) {
    failures.push(
      makeFailure(
        mode,
        'validation',
        'confirm_full_catalog is only supported for search mode',
        'confirm_full_catalog'
      )
    );
  }
  if (mode === 'search' && input.skus !== undefined) {
    failures.push(makeFailure(mode, 'validation', 'skus are only supported for skus mode', 'skus'));
  }
  if (mode === 'search' && input.product_ids !== undefined) {
    failures.push(
      makeFailure(
        mode,
        'validation',
        'product_ids are only supported for product_ids mode',
        'product_ids'
      )
    );
  }
  if (mode === 'skus' && input.product_ids !== undefined) {
    failures.push(
      makeFailure(
        mode,
        'validation',
        'product_ids are only supported for product_ids mode',
        'product_ids'
      )
    );
  }
  if (mode === 'product_ids' && input.skus !== undefined) {
    failures.push(makeFailure(mode, 'validation', 'skus are only supported for skus mode', 'skus'));
  }
  if (mode === 'product_ids' && input.attributes !== undefined) {
    failures.push(
      makeFailure(
        mode,
        'validation',
        'attributes are not supported for product_ids mode',
        'attributes'
      )
    );
  }
  if (mode === 'product_ids' && input.page_size !== undefined) {
    failures.push(
      makeFailure(mode, 'validation', 'page_size is not supported for product_ids mode', 'page_size')
    );
  }

  if (mode === 'search') {
    const filters = normalizeFilters(input.filters, failures);
    if (isEmptySearch(filters) && input.confirm_full_catalog !== true) {
      failures.push(
        makeFailure(
          'search',
          'validation',
          'empty search requires confirm_full_catalog: true',
          'filters'
        )
      );
    }
    if (options.mode === 'file' && !maxRowsExplicit) {
      failures.push(
        makeFailure('search', 'validation', 'file search export requires max_rows', 'max_rows')
      );
    }

    const maxRows = rawMaxRows ?? options.maxRows;
    if (failures.length > 0) return { failures };

    const normalized: NormalizedInput = {
      mode,
      ...(filters ? { filters } : {}),
      ...(input.sort !== undefined ? { sort: input.sort } : {}),
      confirmFullCatalog: input.confirm_full_catalog === true,
      ...(attributes ? { attributes } : {}),
      maxRows,
      maxRowsExplicit,
      pageSize: pageSize ?? DEFAULT_EXPORT_PAGE_SIZE,
      previewRows: previewRows ?? DEFAULT_EXPORT_PREVIEW_ROWS,
    };
    normalized.querySha256 = await hashQuery(normalized);
    return { input: normalized, failures: [] };
  }

  const identifiers =
    mode === 'skus'
      ? normalizeIdentifierList(input.skus, 'skus', failures)
      : normalizeIdentifierList(input.product_ids, 'product_ids', failures);
  const requested = identifiers.length;
  if (requested === 0) {
    failures.push(
      makeFailure(mode, 'validation', `${mode === 'skus' ? 'skus' : 'product_ids'} must not be empty`)
    );
  }
  if (requested > options.maxRows) {
    failures.push(
      makeFailure(
        mode,
        'validation',
        `${mode} requested ${requested} products; max is ${options.maxRows}`,
        mode === 'skus' ? 'skus' : 'product_ids'
      )
    );
  }
  if (rawMaxRows !== undefined && rawMaxRows < requested) {
    failures.push(
      makeFailure(
        mode,
        'validation',
        `max_rows ${rawMaxRows} is lower than requested identifier count ${requested}`,
        'max_rows'
      )
    );
  }
  if (failures.length > 0) return { failures, requested };

  const normalized: NormalizedInput =
    mode === 'skus'
      ? {
          mode,
          skus: identifiers,
          ...(attributes ? { attributes } : {}),
          maxRows: rawMaxRows ?? requested,
          maxRowsExplicit,
          pageSize: pageSize ?? DEFAULT_EXPORT_PAGE_SIZE,
          previewRows: previewRows ?? DEFAULT_EXPORT_PREVIEW_ROWS,
        }
      : {
          mode,
          productIds: identifiers,
          maxRows: rawMaxRows ?? requested,
          maxRowsExplicit,
          pageSize: DEFAULT_EXPORT_PAGE_SIZE,
          previewRows: previewRows ?? DEFAULT_EXPORT_PREVIEW_ROWS,
        };
  normalized.querySha256 = await hashQuery(normalized);
  return { input: normalized, failures: [], requested };
}

function rejectedExport(args: {
  requested?: number;
  matched?: number;
  failures: ProductBatchExportFailure[];
  startedAt: string;
  selectorMode?: ProductBatchExportMetadata['selector_mode'];
  querySha256?: string;
  pageSize?: number;
  pagesRead?: number;
  attributesRequested?: string[];
  limitReason?: ProductBatchExportLimitReason;
}): ProductBatchExportResult {
  const summary: ProductBatchExportSummary = {
    ...(args.requested !== undefined ? { requested: args.requested } : {}),
    ...(args.matched !== undefined ? { matched: args.matched } : {}),
    exported: 0,
    failed: args.failures.length,
    truncated: false,
    ...(args.limitReason ? { limit_reason: args.limitReason } : {}),
  };
  const completedAt = new Date().toISOString();
  return {
    status: 'rejected',
    summary,
    failures: args.failures,
    ...(args.selectorMode
      ? {
          metadata: {
            selector_mode: args.selectorMode,
            row_count: 0,
            page_size: args.pageSize ?? DEFAULT_EXPORT_PAGE_SIZE,
            started_at: args.startedAt,
            completed_at: completedAt,
            ...(args.querySha256 ? { query_sha256: args.querySha256 } : {}),
            ...(args.pagesRead ? { pages_read: args.pagesRead } : {}),
            ...(args.attributesRequested ? { attributes_requested: args.attributesRequested } : {}),
          },
        }
      : {}),
  };
}

function makeFailure(
  key: string,
  stage: ProductBatchExportFailure['stage'],
  msg: string,
  field?: string,
  index?: number
): ProductBatchExportFailure {
  return {
    key,
    ...(index !== undefined ? { index } : {}),
    stage,
    errors: [{ ...(field ? { field } : {}), msg }],
  };
}

function makeLimitError(reason: ProductBatchExportLimitReason, message: string): Error & {
  limitReason?: ProductBatchExportLimitReason;
  errors?: BatchUpdateErrorDetail[];
} {
  const error = new Error(message) as Error & {
    limitReason?: ProductBatchExportLimitReason;
    errors?: BatchUpdateErrorDetail[];
  };
  error.limitReason = reason;
  error.errors = [{ msg: message }];
  return error;
}

function readLimitReason(error: unknown): ProductBatchExportLimitReason | undefined {
  if (!error || typeof error !== 'object' || !('limitReason' in error)) return undefined;
  const reason = (error as { limitReason?: unknown }).limitReason;
  return reason === 'max_rows' ||
    reason === 'file_byte_cap' ||
    reason === 'inline_row_cap' ||
    reason === 'inline_byte_cap' ||
    reason === 'api_window_limit'
    ? reason
    : undefined;
}

function readSelectorMode(rawInput: unknown): ProductBatchExportMetadata['selector_mode'] | undefined {
  if (!isPlainObject(rawInput)) return undefined;
  const mode = rawInput.mode;
  return mode === 'search' || mode === 'skus' || mode === 'product_ids' ? mode : undefined;
}

function normalizeAttributes(
  value: unknown,
  failures: ProductBatchExportFailure[]
): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) {
    failures.push(
      makeFailure('batch_export', 'validation', 'attributes must be an array', 'attributes')
    );
    return undefined;
  }

  const attributes: string[] = [];
  const seen = new Set<string>();
  value.forEach((attribute, index) => {
    if (typeof attribute !== 'string' || attribute.trim() === '') {
      failures.push(
        makeFailure(
          'batch_export',
          'validation',
          'attribute must be a non-empty string',
          `attributes.${index}`
        )
      );
      return;
    }
    if (seen.has(attribute)) {
      failures.push(
        makeFailure(
          'batch_export',
          'validation',
          `duplicate attribute: ${attribute}`,
          'attributes'
        )
      );
      return;
    }
    seen.add(attribute);
    attributes.push(attribute);
  });

  if (attributes.length > MAX_EXPORT_ATTRIBUTES) {
    failures.push(
      makeFailure(
        'batch_export',
        'validation',
        `attributes has ${attributes.length} entries; max is ${MAX_EXPORT_ATTRIBUTES}`,
        'attributes'
      )
    );
  }

  return attributes.length > 0 ? [...attributes].sort() : undefined;
}

function normalizeIdentifierList(
  value: unknown,
  field: 'skus' | 'product_ids',
  failures: ProductBatchExportFailure[]
): string[] {
  if (!Array.isArray(value)) {
    failures.push(makeFailure(field, 'validation', `${field} must be an array`, field));
    return [];
  }

  const identifiers: string[] = [];
  const seen = new Set<string>();
  value.forEach((identifier, index) => {
    if (typeof identifier !== 'string' || identifier.trim() === '') {
      failures.push(
        makeFailure(field, 'validation', `${field} entries must be non-empty strings`, field, index)
      );
      return;
    }
    if (seen.has(identifier)) {
      failures.push(
        makeFailure(identifier, 'validation', `duplicate ${field.slice(0, -1)}: ${identifier}`, field, index)
      );
      return;
    }
    seen.add(identifier);
    identifiers.push(identifier);
  });
  return identifiers;
}

function normalizePositiveInt(
  value: unknown,
  field: string,
  defaultValue: number | undefined,
  max: number,
  failures: ProductBatchExportFailure[]
): number | undefined {
  if (value === undefined) return defaultValue;
  if (!Number.isInteger(value) || (value as number) <= 0) {
    failures.push(makeFailure('batch_export', 'validation', `${field} must be a positive integer`, field));
    return defaultValue;
  }
  if ((value as number) > max) {
    failures.push(
      makeFailure('batch_export', 'validation', `${field} must be <= ${max}`, field)
    );
  }
  return value as number;
}

function normalizeFilters(
  value: unknown,
  failures: ProductBatchExportFailure[]
): PlytixSearchBody['filters'] | undefined {
  if (value === undefined || value === null) return undefined;
  if (!Array.isArray(value)) {
    failures.push(makeFailure('search', 'validation', 'filters must be an array', 'filters'));
    return undefined;
  }

  return value.map((group) => {
    if (!Array.isArray(group)) return group;
    return group.map((item) =>
      Array.isArray(item) && item.length >= 2 && typeof item[0] === 'string'
        ? { field: item[0], operator: item[1], value: item[2] }
        : item
    );
  }) as PlytixSearchBody['filters'];
}

function isEmptySearch(filters: PlytixSearchBody['filters'] | undefined): boolean {
  if (!filters || filters.length === 0) return true;
  return filters.every((group) => Array.isArray(group) && group.length === 0);
}

function observeReturnedAttributes(
  result: PlytixResult<PlytixProduct>,
  observed: Set<string>
): void {
  for (const attribute of result.attributes ?? []) {
    observed.add(attribute);
  }
}

function hasMoreSearchPages(
  result: PlytixResult<PlytixProduct>,
  currentPage: number,
  exported: number
): boolean {
  if (result.pagination?.total !== undefined && result.pagination.total > exported) {
    return true;
  }
  if (result.pagination?.pages !== undefined) {
    return currentPage < result.pagination.pages;
  }
  return (result.data ?? []).length > 0;
}

function getRequested(input: NormalizedInput): number | undefined {
  if (input.mode === 'skus') return input.skus.length;
  if (input.mode === 'product_ids') return input.productIds.length;
  return undefined;
}

function getAttributesRequested(input: NormalizedInput): string[] | undefined {
  if (input.mode === 'product_ids') return undefined;
  return input.attributes;
}

async function hashQuery(input: NormalizedInput): Promise<string> {
  const query =
    input.mode === 'search'
      ? {
          mode: input.mode,
          filters: input.filters ?? [],
          ...(input.sort !== undefined ? { sort: input.sort } : {}),
          attributes: input.attributes ?? [],
          max_rows: input.maxRows,
          page_size: input.pageSize,
        }
      : input.mode === 'skus'
        ? {
            mode: input.mode,
            skus: input.skus,
            attributes: input.attributes ?? [],
            max_rows: input.maxRows,
            page_size: input.pageSize,
          }
        : {
            mode: input.mode,
            product_ids: input.productIds,
            max_rows: input.maxRows,
          };
  return sha256Hex(canonicalJson(query));
}

export function canonicalJsonLine(value: unknown): string {
  return `${canonicalJson(value)}\n`;
}

export function canonicalJson(value: unknown): string {
  return JSON.stringify(toCanonicalValue(value));
}

function toCanonicalValue(value: unknown): unknown {
  if (value === undefined) return undefined;
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new Error('Cannot canonicalize non-finite number');
    }
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((item) => (item === undefined ? null : toCanonicalValue(item)));
  }
  if (typeof value === 'object') {
    const object = value as Record<string, unknown>;
    const output: Record<string, unknown> = {};
    for (const key of Object.keys(object).sort()) {
      const canonical = toCanonicalValue(object[key]);
      if (canonical !== undefined) {
        output[key] = canonical;
      }
    }
    return output;
  }
  throw new Error(`Cannot canonicalize value of type ${typeof value}`);
}

export async function sha256Hex(value: string | Uint8Array): Promise<string> {
  const bytes = typeof value === 'string' ? new TextEncoder().encode(value) : value;
  const digestInput = new Uint8Array(bytes.byteLength);
  digestInput.set(bytes);
  const digest = await globalThis.crypto.subtle.digest('SHA-256', digestInput.buffer);
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
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

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}
