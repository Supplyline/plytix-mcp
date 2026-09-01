/**
 * Plytix API Client for Cloudflare Workers
 *
 * This is a request-scoped version of PlytixClient designed for Workers.
 * Key differences from client.ts:
 * - No dotenv import (not available in Workers)
 * - Credentials are required parameters (BYOK model)
 * - No process.env access
 * - Fully compatible with Workers runtime
 */

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
  PlytixAttributeDetail,
  PlytixFilterDefinition,
  PlytixRelationshipDefinition,
  RateLimitConfig,
  RateLimitWindow,
  BatchUpdateMetadata,
  BatchUpdateResult,
  ProductBatchExportInput,
  ProductBatchExportResult,
} from './types.js';
import { ATTRIBUTE_CACHE_FIELDS, PlytixError } from './types.js';
import {
  DEFAULT_RATE_LIMIT,
  TokenBucket,
  decodeJwtRateLimits,
  fetchWithRetry,
  isValidRateLimitConfig,
  rateLimitConfigsFromWindows,
  type RetryLogger,
} from './rate-limit.js';
import {
  WORKER_INLINE_MAX_ITEMS,
  type BatchValidationOptions,
} from './batch/helpers.js';
import {
  executeBatchUpdate,
  type ExecuteBatchUpdateOptions,
  type ResolvedProductRef,
} from './batch/runner.js';
import {
  WORKER_EXPORT_INLINE_MAX_BYTES,
  WORKER_EXPORT_INLINE_MAX_ROWS,
  executeBatchExport,
  type ExecuteBatchExportOptions,
} from './batch/export.js';

const DEFAULT_CONFIG = {
  baseUrl: 'https://pim.plytix.com',
  authUrl: 'https://auth.plytix.com/auth/api/get-token',
  timeoutMs: 15000,
};

// Module-level JWT cache — survives across requests within the same CF Worker isolate.
// Keyed by a non-reversible digest of BOTH credentials so a cached token is only ever
// reused for the exact api_key + api_password pair that minted it.
const tokenCache = new Map<string, PlytixAuthToken>();

// One pacer per credential pair per isolate. The Worker builds a client per HTTP request,
// so a per-instance bucket would let N concurrent requests for the same account each burst
// the full window and ignore each other's 429 penalties. Tokens are already shared this way.
interface BucketEntry {
  bucket: TokenBucket;
  /** Requests currently pacing against this bucket; never evicted while > 0. */
  inFlight: number;
}
const bucketCache = new Map<string, BucketEntry>();
const MAX_CACHED_BUCKETS = 64;

// De-dupes concurrent token fetches for the same credentials so a cold isolate (or a
// post-expiry burst) fires a single auth request instead of one per in-flight call.
const tokenInFlight = new Map<string, Promise<string>>();

/**
 * Derives a non-reversible cache key from both credentials. Using a SHA-256 digest
 * avoids holding the plaintext api_password in a Map key while still scoping a cached
 * token to the exact credential pair.
 *
 * The pair is JSON-encoded (not joined with a delimiter) so the digest is unambiguous:
 * a naive `${apiKey}:${apiPassword}` would collide for pairs like ("a:b","c") and
 * ("a","b:c"), letting one credential pair reuse a token minted for another.
 */
async function deriveCacheKey(apiKey: string, apiPassword: string): Promise<string> {
  const data = new TextEncoder().encode(JSON.stringify([apiKey, apiPassword]));
  const digest = await crypto.subtle.digest('SHA-256', data);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

export interface WorkerClientConfig {
  apiKey: string;
  apiPassword: string;
  baseUrl?: string;
  authUrl?: string;
  timeoutMs?: number;
  /** Explicit pacing override; when set, the JWT-advertised limits are not applied. */
  rateLimit?: RateLimitConfig;
}

// Surfaces in `wrangler tail`; there is no structured logger on the Worker yet.
const logRetry: RetryLogger = (event, context) =>
  console.warn(JSON.stringify({ event, ...context }));

export class WorkerPlytixClient {
  private token?: PlytixAuthToken;
  private config: Required<Omit<PlytixClientConfig, 'rateLimit'>>;
  /** Set only when the caller passed an explicit `rateLimit`; otherwise pacing is shared per account. */
  private readonly bucketOverride?: BucketEntry;
  private rateLimits?: RateLimitWindow[];
  private attributeCache?: Map<string, PlytixAttributeDetail>;
  private attributeCachePromise?: Promise<Map<string, PlytixAttributeDetail>>;
  private cacheKeyPromise?: Promise<string>;

  constructor(config: WorkerClientConfig) {
    if (!config.apiKey || !config.apiPassword) {
      throw new Error('Missing Plytix API key or password');
    }

    this.config = {
      apiKey: config.apiKey,
      apiPassword: config.apiPassword,
      baseUrl: config.baseUrl ?? DEFAULT_CONFIG.baseUrl,
      authUrl: config.authUrl ?? DEFAULT_CONFIG.authUrl,
      timeoutMs: config.timeoutMs ?? DEFAULT_CONFIG.timeoutMs,
    };

    if (config.rateLimit) {
      if (isValidRateLimitConfig(config.rateLimit)) {
        this.bucketOverride = { bucket: new TokenBucket(config.rateLimit), inFlight: 0 };
      } else {
        logRetry('plytix.rate_limit_config_ignored', { rateLimit: config.rateLimit });
      }
    }
  }

  /**
   * Explicit override if configured, else the isolate-wide bucket for these credentials.
   * With `pin`, the in-flight count is incremented in the same synchronous span as the
   * lookup — an `await` between the two would leave a microtask in which another pair's
   * eviction pass could drop a still-idle entry and split this account across two limiters.
   */
  private async getBucketEntry(pin = false): Promise<BucketEntry> {
    if (this.bucketOverride) {
      if (pin) this.bucketOverride.inFlight++;
      return this.bucketOverride;
    }
    const cacheKey = await this.getCacheKey();
    // Everything below runs without yielding.
    const existing = bucketCache.get(cacheKey);
    if (existing) {
      // LRU touch: re-insert so eviction below prefers the least recently used pair.
      bucketCache.delete(cacheKey);
      bucketCache.set(cacheKey, existing);
      if (pin) existing.inFlight++;
      return existing;
    }
    // Bound the map: a long-lived isolate serving many distinct credential pairs must not
    // grow without limit. Evict the least recently used *idle* entry — a bucket with live
    // callers is never dropped, or the same account would end up with two limiters.
    if (bucketCache.size >= MAX_CACHED_BUCKETS) {
      for (const [key, entry] of bucketCache) {
        if (entry.inFlight === 0) {
          bucketCache.delete(key);
          break;
        }
      }
    }
    const created: BucketEntry = {
      bucket: new TokenBucket(DEFAULT_RATE_LIMIT),
      inFlight: pin ? 1 : 0,
    };
    bucketCache.set(cacheKey, created);
    return created;
  }

  /** Run `fn` with the bucket pinned against eviction for its duration. */
  private async withBucket<T>(fn: (bucket: TokenBucket) => Promise<T>): Promise<T> {
    const entry = await this.getBucketEntry(true);
    try {
      return await fn(entry.bucket);
    } finally {
      entry.inFlight--;
    }
  }

  /** Account windows advertised in the auth JWT (known after the first request). */
  getRateLimits(): RateLimitWindow[] | undefined {
    return this.rateLimits;
  }

  private async applyAdvertisedRateLimits(jwt: string): Promise<void> {
    const windows = decodeJwtRateLimits(jwt);
    if (!windows) return;
    this.rateLimits = windows;
    if (this.bucketOverride) return;
    (await this.getBucketEntry()).bucket.reconfigure(rateLimitConfigsFromWindows(windows));
  }

  // ─────────────────────────────────────────────────────────────
  // Authentication
  // ─────────────────────────────────────────────────────────────

  private getCacheKey(): Promise<string> {
    if (!this.cacheKeyPromise) {
      this.cacheKeyPromise = deriveCacheKey(this.config.apiKey, this.config.apiPassword);
    }
    return this.cacheKeyPromise;
  }

  private async getToken(): Promise<string> {
    const now = Date.now();

    // Instance-level cache fast-path (no async key derivation needed)
    if (this.token && now < this.token.exp - 60_000) {
      return this.token.value;
    }

    const cacheKey = await this.getCacheKey();

    // Module-level cache (survives across requests in same isolate)
    const cached = tokenCache.get(cacheKey);
    if (cached && now < cached.exp - 60_000) {
      this.token = cached;
      await this.applyAdvertisedRateLimits(cached.value);
      return cached.value;
    }

    // De-dupe concurrent fetches for the same credentials: if an auth request for this
    // exact credential pair is already in flight, await it instead of starting another —
    // and adopt its result the same way the minting instance does.
    const inFlight = tokenInFlight.get(cacheKey);
    if (inFlight) {
      const value = await inFlight;
      this.token = tokenCache.get(cacheKey);
      await this.applyAdvertisedRateLimits(value);
      return value;
    }

    const fetchPromise = this.fetchToken(cacheKey);
    tokenInFlight.set(cacheKey, fetchPromise);
    try {
      return await fetchPromise;
    } finally {
      tokenInFlight.delete(cacheKey);
    }
  }

  private async fetchToken(cacheKey: string): Promise<string> {
    let response: Response;
    try {
      // Auth lives on a different host with its own limiter: retried on 429/5xx (the mint is
      // idempotent) but not counted against our bucket.
      response = await this.withBucket((bucket) =>
        fetchWithRetry({
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
          bucket,
          timeoutMs: this.config.timeoutMs,
          log: logRetry,
          countsAgainstBucket: false,
          retryServerErrors: true,
        })
      );
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
      exp: Date.now() + expiresIn,
    };

    // Persist to module-level cache, keyed by the credential-pair digest.
    tokenCache.set(cacheKey, this.token);
    await this.applyAdvertisedRateLimits(tokenData.access_token);

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
      response = await this.withBucket((bucket) =>
        fetchWithRetry({
          url,
          init: options,
          method,
          path: endpoint,
          bucket,
          timeoutMs: this.config.timeoutMs,
          log: logRetry,
          getToken: () => this.getToken(),
          onUnauthorized: async () => {
            // Token expired - clear both caches so the next attempt re-mints
            tokenCache.delete(await this.getCacheKey());
            this.token = undefined;
          },
        })
      );
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
      maxItems: options.maxItems ?? WORKER_INLINE_MAX_ITEMS,
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
      maxRows: options.maxRows ?? WORKER_EXPORT_INLINE_MAX_ROWS,
      maxResponseBytes: options.maxResponseBytes ?? WORKER_EXPORT_INLINE_MAX_BYTES,
      concurrency: options.concurrency,
      requestDelayMs: options.requestDelayMs,
      metadata: options.metadata,
    });
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

  async unlinkProductCategory(
    productId: string,
    categoryId: string
  ): Promise<PlytixResult<void>> {
    return this.request<void>(
      `/api/v2/products/${encodeURIComponent(productId)}/categories/${encodeURIComponent(categoryId)}`,
      { method: 'DELETE' }
    );
  }

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

  async unlinkProductAsset(productId: string, assetId: string): Promise<PlytixResult<void>> {
    return this.request<void>(
      `/api/v2/products/${encodeURIComponent(productId)}/assets/${encodeURIComponent(assetId)}`,
      { method: 'DELETE' }
    );
  }

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

  async getProductAttributes(): Promise<{ system: string[]; custom: PlytixFilterDefinition[] }> {
    try {
      const filtersResult = await this.getAvailableFilters();

      const system: string[] = [];
      const custom: PlytixFilterDefinition[] = [];

      if (filtersResult.data) {
        for (const filter of filtersResult.data) {
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
   * Paginate all attribute IDs from the v1 search endpoint.
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
      if (result.data.length < pageSize) break;
      page++;
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
   */
  async getAttributeById(attrId: string): Promise<PlytixAttributeDetail | null> {
    const result = await this.request<PlytixAttributeDetail>(
      `/api/v1/attributes/product/${encodeURIComponent(attrId)}`
    );
    return result.data?.[0] ?? null;
  }

  /**
   * Build attribute cache indexed by label.
   * Per-request scope — no TTL needed (stateless worker).
   * Deduplicates concurrent callers via shared promise.
   */
  private async buildAttributeCache(): Promise<Map<string, PlytixAttributeDetail>> {
    if (this.attributeCache) return this.attributeCache;
    if (this.attributeCachePromise) return this.attributeCachePromise;

    this.attributeCachePromise = this.doBuildAttributeCache();
    try {
      return await this.attributeCachePromise;
    } finally {
      this.attributeCachePromise = undefined;
    }
  }

  private async doBuildAttributeCache(): Promise<Map<string, PlytixAttributeDetail>> {
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

    this.attributeCache = byLabel;
    return byLabel;
  }

  /**
   * Get full attribute details by label (snake_case identifier).
   */
  async getAttributeByLabel(label: string): Promise<PlytixAttributeDetail | null> {
    const cache = await this.buildAttributeCache();
    return cache.get(label) ?? null;
  }

  /**
   * Get options for a dropdown/multiselect attribute by label.
   * Returns null if attribute not found, empty array if no options.
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

  async call<T = unknown>(path: string, init: RequestInit = {}): Promise<PlytixResult<T>> {
    return this.request<T>(path, init);
  }
}
