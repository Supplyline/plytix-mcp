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
  PlytixFilterDefinition,
  PlytixAttributeDetail,
  RateLimitInfo,
} from './types.js';
import { PlytixError } from './types.js';

const DEFAULT_CONFIG = {
  baseUrl: 'https://pim.plytix.com',
  authUrl: 'https://auth.plytix.com/auth/api/get-token',
  timeoutMs: 15000,
};

export class PlytixClient {
  private token?: PlytixAuthToken;
  private config: Required<PlytixClientConfig>;
  private attributeCache?: { byLabel: Map<string, PlytixAttributeDetail>; expires: number };

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

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.config.timeoutMs);

    try {
      const response = await fetch(this.config.authUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          api_key: this.config.apiKey,
          api_password: this.config.apiPassword,
        }),
        signal: controller.signal,
      });

      clearTimeout(timeout);

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

      return this.token.value;
    } catch (error) {
      clearTimeout(timeout);
      if (error instanceof PlytixError) throw error;
      throw new PlytixError(`Auth request failed: ${error}`, undefined, error);
    }
  }

  // ─────────────────────────────────────────────────────────────
  // Rate Limiting
  // ─────────────────────────────────────────────────────────────

  private parseRateLimitHeaders(headers: Headers): RateLimitInfo | undefined {
    const limit = headers.get('x-ratelimit-limit');
    const remaining = headers.get('x-ratelimit-remaining');
    const reset = headers.get('x-ratelimit-reset');

    if (limit && remaining && reset) {
      return {
        limit: parseInt(limit, 10),
        remaining: parseInt(remaining, 10),
        reset: parseInt(reset, 10),
      };
    }
    return undefined;
  }

  private async backoffOnRateLimit(rateLimitInfo?: RateLimitInfo): Promise<void> {
    if (!rateLimitInfo || rateLimitInfo.remaining > 0) return;

    const now = Date.now();
    const resetTime = rateLimitInfo.reset * 1000; // Convert to milliseconds
    const delay = Math.max(1000, resetTime - now + 100); // Add small buffer

    await new Promise((resolve) => setTimeout(resolve, delay));
  }

  // ─────────────────────────────────────────────────────────────
  // Core Request Method
  // ─────────────────────────────────────────────────────────────

  private async request<T = unknown>(
    endpoint: string,
    options: RequestInit = {},
    retries = 1
  ): Promise<PlytixResult<T>> {
    const token = await this.getToken();

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.config.timeoutMs);

    // Ensure no trailing slash (causes redirect that drops Authorization header)
    const url = `${this.config.baseUrl}${endpoint}`.replace(/\/+$/, '');

    try {
      const response = await fetch(url, {
        ...options,
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
          ...options.headers,
        },
        signal: controller.signal,
      });

      clearTimeout(timeout);

      const rateLimitInfo = this.parseRateLimitHeaders(response.headers);

      // Rate limited - backoff and retry
      if (response.status === 429 && retries > 0) {
        await this.backoffOnRateLimit(rateLimitInfo);
        return this.request(endpoint, options, retries - 1);
      }

      // Token expired - clear and retry
      if (response.status === 401 && retries > 0) {
        this.token = undefined;
        return this.request(endpoint, options, retries - 1);
      }

      // Handle 204 No Content
      if (response.status === 204) {
        return { data: [] } as PlytixResult<T>;
      }

      if (!response.ok) {
        const body = await response.text();
        throw new PlytixError(
          `Request failed: ${response.status} - ${body}`,
          response.status,
          body,
          rateLimitInfo
        );
      }

      return (await response.json()) as PlytixResult<T>;
    } catch (error) {
      clearTimeout(timeout);
      if (error instanceof PlytixError) throw error;
      throw new PlytixError(`Request failed: ${error}`, undefined, error);
    }
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

  // ─────────────────────────────────────────────────────────────
  // Attributes & Filters
  // ─────────────────────────────────────────────────────────────

  async getAvailableFilters(): Promise<PlytixResult<PlytixFilterDefinition>> {
    return this.request<PlytixFilterDefinition>('/api/v1/products/search/filters');
  }

  /**
   * Get all product attributes organized by type
   */
  async getProductAttributes(): Promise<{ system: string[]; custom: PlytixFilterDefinition[] }> {
    try {
      const filtersResult = await this.getAvailableFilters();

      const system: string[] = [];
      const custom: PlytixFilterDefinition[] = [];

      if (filtersResult.data) {
        for (const filter of filtersResult.data) {
          if (filter.field) {
            if (filter.field.startsWith('attributes.')) {
              custom.push(filter);
            } else {
              system.push(filter.field);
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
  async searchAttributeIds(pageSize = 100): Promise<string[]> {
    const attrIds: string[] = [];
    let page = 1;

    while (true) {
      const result = await this.request<{ id: string; filter_type?: string }>(
        '/api/v1/attributes/product/search',
        {
          method: 'POST',
          body: JSON.stringify({
            pagination: { page, page_size: pageSize },
          }),
        }
      );

      if (!result.data || result.data.length === 0) break;
      attrIds.push(...result.data.map((a) => a.id));
      if (result.data.length < pageSize) break;
      page++;
    }

    return attrIds;
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
   */
  private async buildAttributeCache(): Promise<Map<string, PlytixAttributeDetail>> {
    const now = Date.now();
    const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

    // Return cached if still valid
    if (this.attributeCache && now < this.attributeCache.expires) {
      return this.attributeCache.byLabel;
    }

    // Fetch all attribute IDs, then details in parallel (graceful partial failure)
    const attrIds = await this.searchAttributeIds();
    const results = await Promise.allSettled(attrIds.map((id) => this.getAttributeById(id)));

    const byLabel = new Map<string, PlytixAttributeDetail>();
    for (const result of results) {
      if (result.status === 'fulfilled' && result.value?.label) {
        byLabel.set(result.value.label, result.value);
      }
    }

    this.attributeCache = { byLabel, expires: now + CACHE_TTL_MS };
    return byLabel;
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
  // Attributes - Write Operations (v1 API)
  // ─────────────────────────────────────────────────────────────

  /**
   * Create a new product attribute on the org.
   *
   * type_class options (per Plytix docs):
   *   TextAttribute            (Short Text)
   *   MultilineAttribute       (Paragraph)
   *   HtmlAttribute            (HTML)
   *   IntAttribute             (Integer)
   *   DecimalAttribute         (Decimal)
   *   DropdownAttribute        (Dropdown — requires options)
   *   MultiSelectAttribute     (Multiselect — requires options)
   *   DateAttribute            (Date)
   *   UrlAttribute             (URL)
   *   BooleanAttribute         (Boolean)
   *   MediaAttribute           (Media Single)
   *   MediaGalleryAttribute    (Media Gallery)
   *   CompletenessAttribute    (Completeness — requires `attributes` list of contributing attrs)
   *
   * `product_families`: optional list of family bindings. Each entry needs
   *   `id` (family ID) and `attribute_level` ('no_level' | 'parent_level' | 'variant_level').
   *
   * Invalidates the attribute cache on success so subsequent
   * getAttributeByLabel() lookups see the new attribute.
   */
  async createAttribute(data: {
    name: string;
    type_class: string;
    description?: string;
    product_families?: Array<{ id: string; attribute_level: string }>;
    options?: string[];
    manual_sorting?: boolean;
    sort_ascending?: boolean;
    attributes?: Array<{ id: string; label: string }>;
  }): Promise<PlytixResult<PlytixAttributeDetail>> {
    const result = await this.request<PlytixAttributeDetail>('/api/v1/attributes/product', {
      method: 'POST',
      body: JSON.stringify(data),
    });
    this.attributeCache = undefined;
    return result;
  }

  /**
   * Update a product attribute's display name. Plytix's PATCH endpoint
   * only supports renaming — type, options, etc. can't be changed once
   * created (you'd delete+recreate). Pass the attribute ID, not label.
   */
  async updateAttribute(
    attributeId: string,
    data: { name: string }
  ): Promise<PlytixResult<PlytixAttributeDetail>> {
    const result = await this.request<PlytixAttributeDetail>(
      `/api/v1/attributes/product/${encodeURIComponent(attributeId)}`,
      {
        method: 'PATCH',
        body: JSON.stringify(data),
      }
    );
    this.attributeCache = undefined;
    return result;
  }

  /**
   * Delete a product attribute by ID. Returns true if the attribute was
   * deleted, false if it didn't exist (HTTP 404 is treated as a no-op).
   * Any products using the attribute will lose those values.
   */
  async deleteAttribute(attributeId: string): Promise<boolean> {
    try {
      await this.request<void>(
        `/api/v1/attributes/product/${encodeURIComponent(attributeId)}`,
        { method: 'DELETE' }
      );
      this.attributeCache = undefined;
      return true;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes('404') || msg.toLowerCase().includes('not found')) {
        return false;
      }
      throw err;
    }
  }

  // ─────────────────────────────────────────────────────────────
  // Assets (v2 API)
  // ─────────────────────────────────────────────────────────────

  async searchAssets(body?: PlytixSearchBody): Promise<PlytixResult<PlytixAsset>> {
    return this.request<PlytixAsset>('/api/v2/assets/search', {
      method: 'POST',
      body: JSON.stringify(body ?? {}),
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

  // ─────────────────────────────────────────────────────────────
  // Variants (v1 API - write operations)
  // ─────────────────────────────────────────────────────────────

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
      `/api/v1/products/${encodeURIComponent(parentProductId)}/variants/resync`,
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
  // Families — Write Operations (v1 API)
  // ─────────────────────────────────────────────────────────────

  /**
   * Create a new product family. attribute_ids and parent_attribute_ids
   * are optional — pass empty arrays for an empty family.
   */
  async createFamily(data: {
    name: string;
    attribute_ids?: string[];
    parent_attribute_ids?: string[];
  }): Promise<PlytixResult<PlytixFamily>> {
    return this.request<PlytixFamily>('/api/v1/product_families', {
      method: 'POST',
      body: JSON.stringify({
        name: data.name,
        attribute_ids: data.attribute_ids ?? [],
        parent_attribute_ids: data.parent_attribute_ids ?? [],
      }),
    });
  }

  /**
   * Rename a family. Plytix only supports renaming via PATCH at the family level.
   */
  async updateFamily(
    familyId: string,
    data: { name: string }
  ): Promise<PlytixResult<PlytixFamily>> {
    return this.request<PlytixFamily>(
      `/api/v1/product_families/${encodeURIComponent(familyId)}`,
      { method: 'PATCH', body: JSON.stringify(data) }
    );
  }

  /**
   * Delete a family. Returns true if deleted, false if it didn't exist (404).
   * Products in the family become family-less (per the orphan recovery flow).
   */
  async deleteFamily(familyId: string): Promise<boolean> {
    try {
      await this.request<void>(
        `/api/v1/product_families/${encodeURIComponent(familyId)}`,
        { method: 'DELETE' }
      );
      return true;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes('404') || msg.toLowerCase().includes('not found')) return false;
      throw err;
    }
  }

  /**
   * Link attributes to a family. Attributes must already exist at the org level.
   * `attributes_level` controls inheritance: 'no_level' (no model linking), 'parent_level', or 'variant_level'.
   * This is how to fix "orphan" attributes that exist but aren't visible in a family's UI.
   */
  async linkAttributesToFamily(
    familyId: string,
    attributeIds: string[],
    attributesLevel: string = 'no_level'
  ): Promise<PlytixResult<unknown>> {
    return this.request<unknown>(
      `/api/v1/product_families/${encodeURIComponent(familyId)}/attributes/link`,
      {
        method: 'POST',
        body: JSON.stringify({
          attributes: attributeIds,
          attributes_level: attributesLevel,
        }),
      }
    );
  }

  /**
   * Unlink attributes from a family. The attributes themselves aren't deleted —
   * they just stop being part of this family's attribute set.
   */
  async unlinkAttributesFromFamily(
    familyId: string,
    attributeIds: string[]
  ): Promise<PlytixResult<unknown>> {
    return this.request<unknown>(
      `/api/v1/product_families/${encodeURIComponent(familyId)}/attributes/unlink`,
      {
        method: 'POST',
        body: JSON.stringify({ attributes: attributeIds }),
      }
    );
  }

  // ─────────────────────────────────────────────────────────────
  // Attribute Groups — Full CRUD (v1 API)
  // Used to organize attributes within a family for UI display
  // and (eventually) per-role permissions.
  // ─────────────────────────────────────────────────────────────

  async searchAttributeGroups(body?: PlytixSearchBody): Promise<PlytixResult<PlytixAttributeGroup>> {
    return this.request<PlytixAttributeGroup>('/api/v1/attribute-groups/product/search', {
      method: 'POST',
      body: JSON.stringify(body ?? {}),
    });
  }

  async getAttributeGroup(groupId: string): Promise<PlytixAttributeGroup | null> {
    const result = await this.request<PlytixAttributeGroup>(
      `/api/v1/attribute-groups/product/${encodeURIComponent(groupId)}`
    );
    return result.data?.[0] ?? null;
  }

  async createAttributeGroup(data: {
    name: string;
    attribute_labels?: string[];
    order?: number;
  }): Promise<PlytixResult<PlytixAttributeGroup>> {
    const payload: Record<string, unknown> = { name: data.name };
    if (data.attribute_labels && data.attribute_labels.length) {
      payload.attribute_labels = data.attribute_labels;
    }
    if (data.order !== undefined) payload.order = data.order;
    const result = await this.request<PlytixAttributeGroup>('/api/v1/attribute-groups/product', {
      method: 'POST',
      body: JSON.stringify(payload),
    });
    this.attributeCache = undefined;
    return result;
  }

  async updateAttributeGroup(
    groupId: string,
    data: { name?: string; attribute_labels?: string[]; order?: number }
  ): Promise<PlytixResult<PlytixAttributeGroup>> {
    const result = await this.request<PlytixAttributeGroup>(
      `/api/v1/attribute-groups/product/${encodeURIComponent(groupId)}`,
      { method: 'PATCH', body: JSON.stringify(data) }
    );
    this.attributeCache = undefined;
    return result;
  }

  async deleteAttributeGroup(groupId: string): Promise<boolean> {
    try {
      await this.request<void>(
        `/api/v1/attribute-groups/product/${encodeURIComponent(groupId)}`,
        { method: 'DELETE' }
      );
      this.attributeCache = undefined;
      return true;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes('404') || msg.toLowerCase().includes('not found')) return false;
      throw err;
    }
  }

  // ─────────────────────────────────────────────────────────────
  // Assets — Full CRUD + Product Linking (v1 API)
  // ─────────────────────────────────────────────────────────────

  /**
   * Get a single asset by ID, including its download URL and metadata.
   */
  async getAsset(assetId: string): Promise<PlytixAsset | null> {
    const result = await this.request<PlytixAsset>(
      `/api/v1/assets/${encodeURIComponent(assetId)}`
    );
    return result.data?.[0] ?? null;
  }

  /**
   * Create an asset by giving Plytix a public URL to download from.
   * (Local-file upload via base64 is also supported by the API but is
   * known to be flaky per the Python client; URL-based is preferred.)
   */
  async createAssetFromUrl(data: {
    url: string;
    filename?: string;
  }): Promise<PlytixResult<PlytixAsset>> {
    const payload: Record<string, unknown> = { url: data.url };
    if (data.filename) payload.filename = data.filename;
    return this.request<PlytixAsset>('/api/v1/assets', {
      method: 'POST',
      body: JSON.stringify(payload),
    });
  }

  /**
   * Update an asset's filename, public flag, or file-category folders.
   */
  async updateAsset(
    assetId: string,
    data: { filename?: string; public?: boolean; category_ids?: string[] }
  ): Promise<PlytixResult<PlytixAsset>> {
    const payload: Record<string, unknown> = {};
    if (data.filename !== undefined) payload.filename = data.filename;
    if (data.public !== undefined) payload.public = data.public;
    if (data.category_ids !== undefined) payload.categories = data.category_ids;
    return this.request<PlytixAsset>(
      `/api/v1/assets/${encodeURIComponent(assetId)}`,
      { method: 'PATCH', body: JSON.stringify(payload) }
    );
  }

  async deleteAsset(assetId: string): Promise<boolean> {
    try {
      await this.request<void>(
        `/api/v1/assets/${encodeURIComponent(assetId)}`,
        { method: 'DELETE' }
      );
      return true;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes('404') || msg.toLowerCase().includes('not found')) return false;
      throw err;
    }
  }

  /**
   * Link an existing asset to a product, attaching it to a specific media attribute
   * (e.g., "thumbnail", "additional_images", "material_swatch_image").
   */
  async linkAssetToProduct(
    productId: string,
    assetId: string,
    attributeLabel: string
  ): Promise<PlytixResult<unknown>> {
    return this.request<unknown>(
      `/api/v1/products/${encodeURIComponent(productId)}/assets`,
      {
        method: 'POST',
        body: JSON.stringify({
          id: assetId,
          attribute_label: attributeLabel,
        }),
      }
    );
  }

  /**
   * Unlink an asset from a product. The asset itself stays in Plytix —
   * just removed from this product's media attribute.
   */
  async unlinkAssetFromProduct(
    productId: string,
    productAssetId: string
  ): Promise<PlytixResult<unknown>> {
    return this.request<unknown>(
      `/api/v1/products/${encodeURIComponent(productId)}/assets/${encodeURIComponent(productAssetId)}`,
      { method: 'DELETE' }
    );
  }

  // ─────────────────────────────────────────────────────────────
  // File Categories — Asset Folder Organization (v1 API)
  // Distinct from product categories (which use /api/v1/categories/product).
  // ─────────────────────────────────────────────────────────────

  async searchFileCategories(body?: PlytixSearchBody): Promise<PlytixResult<PlytixCategory>> {
    return this.request<PlytixCategory>('/api/v1/categories/file/search', {
      method: 'POST',
      body: JSON.stringify(body ?? {}),
    });
  }

  async createFileCategory(data: {
    name: string;
    parent_id?: string;
  }): Promise<PlytixResult<PlytixCategory>> {
    const payload: Record<string, unknown> = { name: data.name };
    if (data.parent_id) payload.parent_id = data.parent_id;
    return this.request<PlytixCategory>('/api/v1/categories/file', {
      method: 'POST',
      body: JSON.stringify(payload),
    });
  }

  async updateFileCategory(
    categoryId: string,
    data: { name?: string; parent_id?: string }
  ): Promise<PlytixResult<PlytixCategory>> {
    return this.request<PlytixCategory>(
      `/api/v1/categories/file/${encodeURIComponent(categoryId)}`,
      { method: 'PATCH', body: JSON.stringify(data) }
    );
  }

  async deleteFileCategory(categoryId: string): Promise<boolean> {
    try {
      await this.request<void>(
        `/api/v1/categories/file/${encodeURIComponent(categoryId)}`,
        { method: 'DELETE' }
      );
      return true;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes('404') || msg.toLowerCase().includes('not found')) return false;
      throw err;
    }
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

// Minimal type for an attribute group (matches Plytix API shape)
export interface PlytixAttributeGroup {
  id?: string;
  name?: string;
  attribute_labels?: string[];
  order?: number;
}
