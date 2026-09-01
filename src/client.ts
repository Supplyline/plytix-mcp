/**
 * Enhanced Plytix API Client
 *
 * Features:
 * - Automatic token refresh with 60s safety margin
 * - Rate limit detection and backoff
 * - Configurable timeouts with AbortController
 * - Retry on 401/429
 * - Helper methods for common operations
 */

import 'dotenv/config';
import type {
  PlytixAuthToken,
  PlytixAuthResponse,
  PlytixClientConfig,
  PlytixResult,
  PlytixSearchBody,
  PlytixProduct,
  PlytixAsset,
  PlytixCategory,
  PlytixFamily,
  PlytixFamilyAttribute,
  PlytixFilterDefinition,
  PlytixAttributeDetail,
  PlytixRelationshipDefinition,
  RateLimitConfig,
  RateLimitWindow,
  BatchUpdateMetadata,
  BatchUpdateResult,
  ProductBatchExportInput,
  ProductBatchExportResult,
  ProductBatchExportToFileInput,
} from './types.js';
import { ATTRIBUTE_CACHE_FIELDS, OPTION_TYPE_CLASSES, PlytixError } from './types.js';
import {
  DEFAULT_RATE_LIMIT,
  TokenBucket,
  decodeJwtRateLimits,
  fetchWithRetry,
  isValidRateLimitConfig,
  parseRateLimitSpec,
  rateLimitConfigsFromWindows,
  type RetryLogger,
} from './rate-limit.js';
import {
  STDIO_INLINE_MAX_ITEMS,
  type BatchValidationOptions,
} from './batch/helpers.js';
import {
  executeBatchUpdate,
  type ExecuteBatchUpdateOptions,
  type ResolvedProductRef,
} from './batch/runner.js';
import {
  STDIO_EXPORT_INLINE_MAX_BYTES,
  STDIO_EXPORT_INLINE_MAX_ROWS,
  executeBatchExport,
  type ExecuteBatchExportOptions,
} from './batch/export.js';
import { exportProductsToFile } from './batch/export-file.js';

const DEFAULT_CONFIG = {
  baseUrl: 'https://pim.plytix.com',
  authUrl: 'https://auth.plytix.com/auth/api/get-token',
  timeoutMs: 15000,
};

// stdout is the MCP transport — every diagnostic line must go to stderr.
const logStructured: RetryLogger = (event, context) =>
  console.error(JSON.stringify({ event, ...context }));

export class PlytixClient {
  private token?: PlytixAuthToken;
  private config: Required<Omit<PlytixClientConfig, 'rateLimit'>>;
  private readonly bucket: TokenBucket;
  /** True when pacing came from config/env; JWT-advertised limits then don't override it. */
  private readonly explicitRateLimit: boolean;
  private rateLimits?: RateLimitWindow[];
  private attributeCache?: { byLabel: Map<string, PlytixAttributeDetail>; expires: number };
  private attributeCachePromise?: Promise<Map<string, PlytixAttributeDetail>>;

  constructor(config?: Partial<PlytixClientConfig>) {
    this.config = {
      apiKey: config?.apiKey ?? process.env.PLYTIX_API_KEY ?? '',
      apiPassword: config?.apiPassword ?? process.env.PLYTIX_API_PASSWORD ?? '',
      baseUrl: config?.baseUrl ?? process.env.PLYTIX_API_BASE ?? DEFAULT_CONFIG.baseUrl,
      authUrl: config?.authUrl ?? process.env.PLYTIX_AUTH_URL ?? DEFAULT_CONFIG.authUrl,
      timeoutMs: config?.timeoutMs ?? DEFAULT_CONFIG.timeoutMs,
    };

    if (!this.config.apiKey || !this.config.apiPassword) {
      throw new Error('Missing PLYTIX_API_KEY or PLYTIX_API_PASSWORD');
    }

    let rateLimit: RateLimitConfig | undefined =
      config?.rateLimit ?? parseRateLimitSpec(process.env.PLYTIX_RATE_LIMIT);
    if (rateLimit && !isValidRateLimitConfig(rateLimit)) {
      // An unusable override must not silently pin the default *and* block the JWT.
      logStructured('plytix.rate_limit_config_ignored', { rateLimit });
      rateLimit = undefined;
    }
    this.explicitRateLimit = rateLimit !== undefined;
    this.bucket = new TokenBucket(rateLimit ?? DEFAULT_RATE_LIMIT);
  }

  /** Account windows advertised in the auth JWT (known after the first request). */
  getRateLimits(): RateLimitWindow[] | undefined {
    return this.rateLimits;
  }

  private applyAdvertisedRateLimits(jwt: string): void {
    const windows = decodeJwtRateLimits(jwt);
    if (!windows) return;
    this.rateLimits = windows;
    if (this.explicitRateLimit) return;
    this.bucket.reconfigure(rateLimitConfigsFromWindows(windows));
  }

  // ─────────────────────────────────────────────────────────────
  // Authentication
  // ─────────────────────────────────────────────────────────────

  private async getToken(): Promise<string> {
    const now = Date.now();

    // Refresh 60s before expiration for safety
    if (this.token && now < this.token.exp - 60_000) {
      return this.token.value;
    }

    let response: Response;
    try {
      // Auth lives on a different host with its own limiter: retried on 429/5xx (the mint is
      // idempotent) but not counted against our bucket.
      response = await fetchWithRetry({
        url: this.config.authUrl,
        init: {
          method: 'POST',
          body: JSON.stringify({
            api_key: this.config.apiKey,
            api_password: this.config.apiPassword,
          }),
        },
        method: 'POST',
        path: '/auth/api/get-token',
        bucket: this.bucket,
        timeoutMs: this.config.timeoutMs,
        log: logStructured,
        countsAgainstBucket: false,
        retryServerErrors: true,
      });
    } catch (error) {
      if (error instanceof PlytixError) throw error;
      throw new PlytixError(`Auth request failed: ${error}`, undefined, error);
    }

    if (!response.ok) {
      const body = await response.text();
      throw new PlytixError(
        `Authentication failed: ${response.status} - ${body}`,
        response.status,
        body
      );
    }

    const result = (await response.json()) as PlytixResult<PlytixAuthResponse>;
    const tokenData = result.data?.[0];

    if (!tokenData?.access_token) {
      throw new PlytixError('Invalid auth response: missing access_token', undefined, result);
    }

    // Default to 15 minutes if expires_in not provided
    const expiresIn = (tokenData.expires_in ?? 900) * 1000;
    this.token = {
      value: tokenData.access_token,
      exp: now + expiresIn,
    };
    this.applyAdvertisedRateLimits(tokenData.access_token);

    return this.token.value;
  }

  // ─────────────────────────────────────────────────────────────
  // Core Request Method
  // ─────────────────────────────────────────────────────────────

  private async request<T = unknown>(
    endpoint: string,
    options: RequestInit = {}
  ): Promise<PlytixResult<T>> {
    // Ensure no trailing slash (causes redirect that drops Authorization header)
    const url = `${this.config.baseUrl}${endpoint}`.replace(/\/+$/, '');
    const method = (options.method ?? 'GET').toUpperCase();

    let response: Response;
    try {
      response = await fetchWithRetry({
        url,
        init: options,
        method,
        path: endpoint,
        bucket: this.bucket,
        timeoutMs: this.config.timeoutMs,
        log: logStructured,
        getToken: () => this.getToken(),
        onUnauthorized: () => {
          this.token = undefined;
        },
      });
    } catch (error) {
      if (error instanceof PlytixError) throw error;
      throw new PlytixError(`Request failed: ${error}`, undefined, error);
    }

    // Handle 204 No Content
    if (response.status === 204) {
      return { data: [] } as PlytixResult<T>;
    }

    if (!response.ok) {
      const body = await response.text();
      throw new PlytixError(`Request failed: ${response.status} - ${body}`, response.status, body);
    }

    return (await response.json()) as PlytixResult<T>;
  }

  // ─────────────────────────────────────────────────────────────
  // Products (v2 API)
  // ─────────────────────────────────────────────────────────────

  async searchProducts(body: PlytixSearchBody): Promise<PlytixResult<PlytixProduct>> {
    // v2 allows up to 50 attributes
    if (body.attributes && body.attributes.length > 50) {
      console.warn(`Plytix v2 search limited to 50 attributes, got ${body.attributes.length}`);
      body = { ...body, attributes: body.attributes.slice(0, 50) };
    }

    return this.request<PlytixProduct>('/api/v2/products/search', {
      method: 'POST',
      body: JSON.stringify(body),
    });
  }

  async resolveProductIdsBySku(skus: string[]): Promise<Map<string, ResolvedProductRef[]>> {
    const resolved = new Map<string, ResolvedProductRef[]>();
    const uniqueSkus = Array.from(new Set(skus.filter(Boolean)));
    const pageSize = 100;

    for (let i = 0; i < uniqueSkus.length; i += pageSize) {
      const batch = uniqueSkus.slice(i, i + pageSize);
      let page = 1;
      let totalPages = 1;

      do {
        const result = await this.searchProducts({
          filters: [[{ field: 'sku', operator: 'in', value: batch }]],
          attributes: ['sku'],
          pagination: { page, page_size: pageSize },
        });

        for (const product of result.data ?? []) {
          if (!product.sku) continue;
          resolved.set(product.sku, [
            ...(resolved.get(product.sku) ?? []),
            { id: product.id, sku: product.sku },
          ]);
        }

        totalPages = Math.max(result.pagination?.pages ?? 1, 1);
        page += 1;
      } while (page <= totalPages);
    }

    return resolved;
  }

  async batchUpdateProducts(
    items: unknown,
    options: Partial<ExecuteBatchUpdateOptions> & {
      metadata?: BatchUpdateMetadata;
      maxItems?: BatchValidationOptions['maxItems'];
    } = {}
  ): Promise<BatchUpdateResult> {
    return executeBatchUpdate(this, items, {
      maxItems: options.maxItems ?? STDIO_INLINE_MAX_ITEMS,
      maxBytes: options.maxBytes,
      dryRun: options.dryRun,
      metadata: options.metadata,
      concurrency: options.concurrency,
      requestDelayMs: options.requestDelayMs,
      returnSuccesses: options.returnSuccesses,
    });
  }

  async batchExportProducts(
    input: ProductBatchExportInput,
    options: Partial<ExecuteBatchExportOptions> = {}
  ): Promise<ProductBatchExportResult> {
    return executeBatchExport(this, input, {
      mode: 'inline',
      maxRows: options.maxRows ?? STDIO_EXPORT_INLINE_MAX_ROWS,
      maxResponseBytes: options.maxResponseBytes ?? STDIO_EXPORT_INLINE_MAX_BYTES,
      concurrency: options.concurrency,
      requestDelayMs: options.requestDelayMs,
      metadata: options.metadata,
    });
  }

  async batchExportProductsToFile(
    input: ProductBatchExportToFileInput
  ): Promise<ProductBatchExportResult> {
    return exportProductsToFile(this, input);
  }

  async getProduct(id: string): Promise<PlytixResult<PlytixProduct>> {
    return this.request<PlytixProduct>(`/api/v2/products/${encodeURIComponent(id)}`);
  }

  async getProductAssets(productId: string): Promise<PlytixResult<PlytixAsset>> {
    return this.request<PlytixAsset>(`/api/v2/products/${encodeURIComponent(productId)}/assets`);
  }

  async getProductCategories(productId: string): Promise<PlytixResult<PlytixCategory>> {
    return this.request<PlytixCategory>(
      `/api/v2/products/${encodeURIComponent(productId)}/categories`
    );
  }

  async getProductVariants(productId: string): Promise<PlytixResult<PlytixProduct>> {
    return this.request<PlytixProduct>(`/api/v2/products/${encodeURIComponent(productId)}/variants`);
  }

  // ─────────────────────────────────────────────────────────────
  // Families (v1 API)
  // ─────────────────────────────────────────────────────────────

  async searchFamilies(body?: PlytixSearchBody): Promise<PlytixResult<PlytixFamily>> {
    return this.request<PlytixFamily>('/api/v1/product_families/search', {
      method: 'POST',
      body: JSON.stringify(body ?? {}),
    });
  }

  async getFamily(familyId: string): Promise<PlytixResult<PlytixFamily>> {
    return this.request<PlytixFamily>(
      `/api/v1/product_families/${encodeURIComponent(familyId)}`
    );
  }

  async createFamily(data: {
    name: string;
    parent_id?: string;
  }): Promise<PlytixResult<PlytixFamily>> {
    return this.request<PlytixFamily>('/api/v1/product_families', {
      method: 'POST',
      body: JSON.stringify(data),
    });
  }

  async linkFamilyAttributes(
    familyId: string,
    attributeLabels: string[]
  ): Promise<PlytixResult<void>> {
    return this.request<void>(
      `/api/v1/product_families/${encodeURIComponent(familyId)}/attributes/link`,
      {
        method: 'POST',
        body: JSON.stringify({ attributes: attributeLabels }),
      }
    );
  }

  async unlinkFamilyAttributes(
    familyId: string,
    attributeLabels: string[]
  ): Promise<PlytixResult<void>> {
    return this.request<void>(
      `/api/v1/product_families/${encodeURIComponent(familyId)}/attributes/unlink`,
      {
        method: 'POST',
        body: JSON.stringify({ attributes: attributeLabels }),
      }
    );
  }

  async getFamilyAttributes(familyId: string): Promise<PlytixResult<PlytixFamilyAttribute>> {
    return this.request<PlytixFamilyAttribute>(
      `/api/v1/product_families/${encodeURIComponent(familyId)}/attributes`
    );
  }

  async getFamilyAllAttributes(familyId: string): Promise<PlytixResult<PlytixFamilyAttribute>> {
    return this.request<PlytixFamilyAttribute>(
      `/api/v1/product_families/${encodeURIComponent(familyId)}/all_attributes`
    );
  }

  // ─────────────────────────────────────────────────────────────
  // Attributes & Filters
  // ─────────────────────────────────────────────────────────────

  async getAvailableFilters(): Promise<PlytixResult<PlytixFilterDefinition>> {
    return this.request<PlytixFilterDefinition>('/api/v1/filters/product');
  }

  async getAssetFilters(): Promise<PlytixResult<PlytixFilterDefinition>> {
    return this.request<PlytixFilterDefinition>('/api/v1/filters/asset');
  }

  async getRelationshipFilters(): Promise<PlytixResult<PlytixFilterDefinition>> {
    return this.request<PlytixFilterDefinition>('/api/v1/filters/relationships');
  }

  /**
   * Get all product attributes organized by type
   */
  async getProductAttributes(): Promise<{ system: string[]; custom: PlytixFilterDefinition[] }> {
    try {
      const filtersResult = await this.getAvailableFilters();

      const system: string[] = [];
      const custom: PlytixFilterDefinition[] = [];

      // Plytix (observed 2026-08) wraps the filter list in a single
      // { attributes: [...] } object inside data; older accounts returned the
      // filter definitions directly in data. Accept both shapes.
      const raw = (filtersResult.data ?? []) as Array<
        PlytixFilterDefinition & { attributes?: PlytixFilterDefinition[] }
      >;
      const filterList = Array.isArray(raw[0]?.attributes) ? raw[0].attributes! : raw;

      if (filterList) {
        for (const filter of filterList) {
          const field = filter.key ?? filter.field;
          if (field) {
            if (field.startsWith('attributes.')) {
              custom.push(filter);
            } else {
              system.push(field);
            }
          }
        }
      }

      return { system, custom };
    } catch {
      // Fallback to known system attributes
      return {
        system: ['id', 'sku', 'label', 'gtin', 'created', 'modified', 'status'],
        custom: [],
      };
    }
  }

  /**
   * Search for attribute IDs. Returns minimal data (id + filter_type).
   * Use getAttribute() to get full details including options.
   */
  /**
   * Page through every product attribute, fully populated.
   *
   * Requesting the cache's field set up front means the whole catalogue arrives in
   * ceil(N/100) requests. The previous walk fetched ids here and then one GET per id —
   * 216 requests on a 215-attribute account, which reliably tripped the 50 req/10 s
   * window and left the cache missing whatever 429'd.
   */
  async searchAttributeDetails(pageSize = 100): Promise<PlytixAttributeDetail[]> {
    const MAX_PAGES = 50; // Safety cap — 5,000 attributes max
    const rows: PlytixAttributeDetail[] = [];
    let page = 1;
    let expected: number | undefined;

    while (page <= MAX_PAGES) {
      const result = await this.request<PlytixAttributeDetail>(
        '/api/v1/attributes/product/search',
        {
          method: 'POST',
          body: JSON.stringify({
            attributes: ATTRIBUTE_CACHE_FIELDS,
            pagination: { page, page_size: pageSize },
          }),
        }
      );

      if (!result.data || result.data.length === 0) break;
      rows.push(...result.data);
      // `count` is how many attributes the search matched. Stopping on it also avoids the
      // redundant empty request when the final page happens to be exactly full.
      expected = result.pagination?.count ?? expected;
      if (expected !== undefined && rows.length >= expected) break;
      if (result.data.length < pageSize) break;
      page++;
    }

    // Silently caching a partial catalogue would make real attributes look nonexistent for
    // the life of the cache, so refuse it. Unchanged when the API reports no count.
    if (expected !== undefined && rows.length < expected) {
      throw new PlytixError(
        `Attribute search truncated at ${rows.length}/${expected} attributes ` +
          `(MAX_PAGES=${MAX_PAGES} at page_size ${pageSize})`
      );
    }

    return rows;
  }

  /** Ids only. Prefer `searchAttributeDetails` — same request count, full rows. */
  async searchAttributeIds(pageSize = 100): Promise<string[]> {
    const rows = await this.searchAttributeDetails(pageSize);
    return rows.map((row) => row.id);
  }

  /**
   * Get full attribute details by ID.
   * Use this to get options for dropdown/multiselect attributes.
   */
  async getAttributeById(attrId: string): Promise<PlytixAttributeDetail | null> {
    const result = await this.request<PlytixAttributeDetail>(
      `/api/v1/attributes/product/${encodeURIComponent(attrId)}`
    );
    return result.data?.[0] ?? null;
  }

  /**
   * Build attribute cache indexed by label. Fetches all attributes once,
   * then caches for 5 minutes to avoid N+1 queries on repeated lookups.
   * Deduplicates concurrent callers via shared promise.
   */
  private async buildAttributeCache(): Promise<Map<string, PlytixAttributeDetail>> {
    // Return cached if still valid
    if (this.attributeCache && Date.now() < this.attributeCache.expires) {
      return this.attributeCache.byLabel;
    }
    if (this.attributeCachePromise) return this.attributeCachePromise;

    this.attributeCachePromise = this.doBuildAttributeCache();
    try {
      return await this.attributeCachePromise;
    } finally {
      this.attributeCachePromise = undefined;
    }
  }

  private async doBuildAttributeCache(): Promise<Map<string, PlytixAttributeDetail>> {
    const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

    const rows = await this.searchAttributeDetails();

    if (rows.length === 0) {
      throw new PlytixError(
        'Attribute cache build failed: no attributes found. Check API credentials and account configuration.'
      );
    }

    const byLabel = new Map<string, PlytixAttributeDetail>();
    let unusable = 0;
    for (const row of rows) {
      if (row?.label) byLabel.set(row.label, row);
      else unusable++;
    }

    // A label is what the cache is keyed by. If more than 20% of rows arrive without one
    // the response shape is wrong; surface that instead of caching a cripple.
    if (unusable > rows.length * 0.2) {
      throw new PlytixError(
        `Attribute cache build failed: ${unusable}/${rows.length} attributes returned without a label`
      );
    }

    await this.backfillMissingOptions(byLabel);

    this.attributeCache = { byLabel, expires: Date.now() + CACHE_TTL_MS };
    return byLabel;
  }

  /**
   * Search omits empty or absent fields, so an option-typed attribute could in principle
   * arrive without its `options`. That would be invisible but harmful: `validateAttributeValue`
   * reads "no options" as "no constraint", so an invalid value would sail through to Plytix on
   * `products_set_attribute`. Fetch those few by id instead.
   *
   * On a live 215-attribute account this fetches nothing — all 42 option-typed rows carry
   * their options — so it costs a comparison per build in the normal case.
   */
  private async backfillMissingOptions(
    byLabel: Map<string, PlytixAttributeDetail>
  ): Promise<void> {
    const incomplete = [...byLabel.values()].filter(
      (attr) => OPTION_TYPE_CLASSES.has(attr.type_class) && attr.options === undefined
    );
    if (incomplete.length === 0) return;

    const BATCH_SIZE = 10;
    for (let i = 0; i < incomplete.length; i += BATCH_SIZE) {
      const batch = incomplete.slice(i, i + BATCH_SIZE);
      const details = await Promise.allSettled(
        batch.map((attr) => this.getAttributeById(attr.id))
      );
      details.forEach((result, index) => {
        const attr = batch[index];
        if (result.status === 'fulfilled' && result.value) {
          byLabel.set(attr.label, { ...attr, options: result.value.options ?? [] });
        } else {
          // Leave the row as it came; the next build retries. Logged because a value written
          // against this attribute in the meantime is not validated against its option list.
          logStructured('plytix.attribute_options_backfill_failed', {
            label: attr.label,
            id: attr.id,
            type_class: attr.type_class,
          });
        }
      });
    }
  }

  /**
   * Get full attribute details by label (snake_case identifier like "head_material").
   * Uses cached attribute lookup to avoid N+1 queries.
   */
  async getAttributeByLabel(label: string): Promise<PlytixAttributeDetail | null> {
    const cache = await this.buildAttributeCache();
    return cache.get(label) ?? null;
  }

  /**
   * Get options for a dropdown/multiselect attribute by label.
   * Returns null if attribute not found, empty array if attribute exists but has no options.
   */
  async getAttributeOptions(label: string): Promise<string[] | null> {
    const attr = await this.getAttributeByLabel(label);
    if (!attr) return null;
    return attr.options ?? [];
  }

  // ─────────────────────────────────────────────────────────────
  // Assets (v1 API for account-level asset discovery and metadata)
  // ─────────────────────────────────────────────────────────────

  async searchAssets(body?: PlytixSearchBody): Promise<PlytixResult<PlytixAsset>> {
    return this.request<PlytixAsset>('/api/v1/assets/search', {
      method: 'POST',
      body: JSON.stringify(body ?? {}),
    });
  }

  async getAsset(assetId: string): Promise<PlytixResult<PlytixAsset>> {
    return this.request<PlytixAsset>(`/api/v1/assets/${encodeURIComponent(assetId)}`);
  }

  async updateAsset(
    assetId: string,
    data: { filename?: string; categories?: string[] }
  ): Promise<PlytixResult<PlytixAsset>> {
    const body: {
      filename?: string;
      categories?: Array<{ id: string }>;
    } = {};

    if (data.filename !== undefined) {
      body.filename = data.filename;
    }

    if (data.categories !== undefined) {
      body.categories = data.categories.map((id) => ({ id }));
    }

    return this.request<PlytixAsset>(`/api/v1/assets/${encodeURIComponent(assetId)}`, {
      method: 'PATCH',
      body: JSON.stringify(body),
    });
  }

  // ─────────────────────────────────────────────────────────────
  // Products - Write Operations (v2 API)
  // ─────────────────────────────────────────────────────────────

  /**
   * Create a new product. Only `sku` is mandatory.
   * Cannot create new attributes, categories, or assets - must link existing ones.
   */
  async createProduct(data: {
    sku: string;
    label?: string;
    status?: string;
    attributes?: Record<string, unknown>;
    categories?: Array<{ id: string }>;
    assets?: Array<{ id: string }>;
  }): Promise<PlytixResult<PlytixProduct>> {
    return this.request<PlytixProduct>('/api/v2/products', {
      method: 'POST',
      body: JSON.stringify(data),
    });
  }

  /**
   * Update a product's attributes. Partial update - only specified fields are changed.
   * Set an attribute to null to clear it.
   */
  async updateProduct(
    productId: string,
    data: {
      label?: string;
      status?: string;
      attributes?: Record<string, unknown>;
    }
  ): Promise<PlytixResult<PlytixProduct>> {
    return this.request<PlytixProduct>(`/api/v2/products/${encodeURIComponent(productId)}`, {
      method: 'PATCH',
      body: JSON.stringify(data),
    });
  }

  /**
   * Link an existing asset to a product.
   * Optionally attach it to a media attribute label.
   */
  async linkProductAsset(
    productId: string,
    assetId: string,
    attributeLabel?: string
  ): Promise<PlytixResult<PlytixAsset>> {
    const body: { id: string; attribute_label?: string } = { id: assetId };
    if (attributeLabel !== undefined) {
      body.attribute_label = attributeLabel;
    }

    return this.request<PlytixAsset>(`/api/v2/products/${encodeURIComponent(productId)}/assets`, {
      method: 'POST',
      body: JSON.stringify(body),
    });
  }

  /**
   * Unlink an asset from a product. Asset is not deleted from the account.
   */
  async unlinkProductAsset(
    productId: string,
    assetId: string
  ): Promise<PlytixResult<void>> {
    return this.request<void>(
      `/api/v2/products/${encodeURIComponent(productId)}/assets/${encodeURIComponent(assetId)}`,
      { method: 'DELETE' }
    );
  }

  /**
   * Assign or unassign a family to a product.
   * Pass empty string to unassign.
   * Warning: Changing family may cause data loss. Cannot assign to variant products.
   */
  async assignProductFamily(
    productId: string,
    familyId: string
  ): Promise<PlytixResult<PlytixProduct>> {
    return this.request<PlytixProduct>(
      `/api/v2/products/${encodeURIComponent(productId)}/family`,
      {
        method: 'POST',
        body: JSON.stringify({ product_family_id: familyId }),
      }
    );
  }

  /**
   * Link an existing category to a product.
   */
  async linkProductCategory(
    productId: string,
    categoryId: string
  ): Promise<PlytixResult<PlytixCategory>> {
    return this.request<PlytixCategory>(
      `/api/v2/products/${encodeURIComponent(productId)}/categories`,
      {
        method: 'POST',
        body: JSON.stringify({ id: categoryId }),
      }
    );
  }

  /**
   * Unlink a category from a product. Category is not deleted.
   */
  async unlinkProductCategory(
    productId: string,
    categoryId: string
  ): Promise<PlytixResult<void>> {
    return this.request<void>(
      `/api/v2/products/${encodeURIComponent(productId)}/categories/${encodeURIComponent(categoryId)}`,
      { method: 'DELETE' }
    );
  }

  async searchCategories(body?: PlytixSearchBody): Promise<PlytixResult<PlytixCategory>> {
    return this.request<PlytixCategory>('/api/v1/categories/product/search', {
      method: 'POST',
      body: JSON.stringify(body ?? {}),
    });
  }

  async getRelationship(
    relationshipId: string
  ): Promise<PlytixResult<PlytixRelationshipDefinition>> {
    return this.request<PlytixRelationshipDefinition>(
      `/api/v1/relationships/${encodeURIComponent(relationshipId)}`
    );
  }

  async searchRelationships(
    body?: PlytixSearchBody
  ): Promise<PlytixResult<PlytixRelationshipDefinition>> {
    return this.request<PlytixRelationshipDefinition>('/api/v1/relationships/search', {
      method: 'POST',
      body: JSON.stringify(body ?? {}),
    });
  }

  /**
   * Add related products to a relationship for a product.
   */
  async linkProductRelationship(
    productId: string,
    relationshipId: string,
    productRelationships: Array<{ product_id: string; quantity?: number }>
  ): Promise<PlytixResult<PlytixProduct>> {
    return this.request<PlytixProduct>(
      `/api/v2/products/${encodeURIComponent(productId)}/relationships/${encodeURIComponent(relationshipId)}`,
      {
        method: 'POST',
        body: JSON.stringify({
          product_relationships: productRelationships,
        }),
      }
    );
  }

  /**
   * Remove related products from a relationship for a product.
   */
  async unlinkProductRelationship(
    productId: string,
    relationshipId: string,
    relatedProductIds: string[]
  ): Promise<PlytixResult<void>> {
    return this.request<void>(
      `/api/v2/products/${encodeURIComponent(productId)}/relationships/${encodeURIComponent(relationshipId)}`,
      {
        method: 'DELETE',
        body: JSON.stringify({
          product_relationships: relatedProductIds,
        }),
      }
    );
  }

  /**
   * Update relationship attributes for related products (e.g., quantity).
   */
  async updateProductRelationship(
    productId: string,
    relationshipId: string,
    productRelationships: Array<{ product_id: string; quantity?: number }>
  ): Promise<PlytixResult<PlytixProduct>> {
    return this.request<PlytixProduct>(
      `/api/v2/products/${encodeURIComponent(productId)}/relationships/${encodeURIComponent(relationshipId)}`,
      {
        method: 'PATCH',
        body: JSON.stringify({
          product_relationships: productRelationships,
        }),
      }
    );
  }

  // ─────────────────────────────────────────────────────────────
  // Variants
  // ─────────────────────────────────────────────────────────────

  async createVariant(
    parentProductId: string,
    data: { sku: string; label?: string; attributes?: Record<string, unknown> }
  ): Promise<PlytixResult<PlytixProduct>> {
    return this.request<PlytixProduct>(
      `/api/v2/products/${encodeURIComponent(parentProductId)}/variants`,
      {
        method: 'POST',
        body: JSON.stringify(data),
      }
    );
  }

  async linkVariant(
    parentProductId: string,
    variantProductId: string
  ): Promise<PlytixResult<PlytixProduct>> {
    return this.request<PlytixProduct>(
      `/api/v2/products/${encodeURIComponent(parentProductId)}/variant/${encodeURIComponent(variantProductId)}`,
      { method: 'POST' }
    );
  }

  async unlinkVariant(
    parentProductId: string,
    variantProductId: string
  ): Promise<PlytixResult<void>> {
    return this.request<void>(
      `/api/v2/products/${encodeURIComponent(parentProductId)}/variant/${encodeURIComponent(variantProductId)}`,
      { method: 'DELETE' }
    );
  }

  /**
   * Resync variant attributes to inherit values from the parent product.
   * Restores overwritten attributes on specified variants to use the parent's value instead.
   *
   * @param parentProductId - The parent product ID containing the variants
   * @param attributeLabels - List of attribute labels to reset (must be attributes at parent level)
   * @param variantIds - List of variant product IDs to resync (must be variants of the specified parent)
   */
  async resyncVariants(
    parentProductId: string,
    attributeLabels: string[],
    variantIds: string[]
  ): Promise<PlytixResult<void>> {
    return this.request<void>(
      `/api/v2/products/${encodeURIComponent(parentProductId)}/variants/resync`,
      {
        method: 'POST',
        body: JSON.stringify({
          attribute_labels: attributeLabels,
          variant_ids: variantIds,
        }),
      }
    );
  }

  // ─────────────────────────────────────────────────────────────
  // Generic Request (for custom endpoints)
  // ─────────────────────────────────────────────────────────────

  /**
   * Make a generic API request. Use for endpoints not covered by helper methods.
   */
  async call<T = unknown>(path: string, init: RequestInit = {}): Promise<PlytixResult<T>> {
    return this.request<T>(path, init);
  }
}
