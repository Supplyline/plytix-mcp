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
  PlytixFilterDefinition,
  RateLimitInfo,
} from './types.js';
import { PlytixError } from './types.js';

const DEFAULT_CONFIG = {
  baseUrl: 'https://pim.plytix.com',
  authUrl: 'https://auth.plytix.com/auth/api/get-token',
  timeoutMs: 15000,
};

export interface WorkerClientConfig {
  apiKey: string;
  apiPassword: string;
  baseUrl?: string;
  authUrl?: string;
  timeoutMs?: number;
}

export class WorkerPlytixClient {
  private token?: PlytixAuthToken;
  private config: Required<PlytixClientConfig>;

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
  // Variants (v1 API - write operations)
  // ─────────────────────────────────────────────────────────────

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
  // Generic Request (for custom endpoints)
  // ─────────────────────────────────────────────────────────────

  async call<T = unknown>(path: string, init: RequestInit = {}): Promise<PlytixResult<T>> {
    return this.request<T>(path, init);
  }
}
