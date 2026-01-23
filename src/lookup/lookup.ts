/**
 * Smart Product Lookup
 *
 * Multi-stage search with confidence scoring and caching.
 * Automatically detects identifier types and uses appropriate search strategies.
 */

import type { PlytixClient } from '../client.js';
import type { PlytixSearchBody, PlytixProduct } from '../types.js';
import {
  detectIdentifierType,
  type IdentifierType,
  normalize,
  calculateSimilarity,
} from './identifier.js';

// ─────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────

/**
 * Default search fields for vanilla Plytix.
 * Override with PLYTIX_SEARCH_FIELDS env var or config.
 */
export const DEFAULT_SEARCH_FIELDS = ['sku', 'label', 'gtin'];

const sanitizeSearchFields = (fields: unknown): string[] => {
  if (!Array.isArray(fields)) return [];
  return fields
    .filter((field): field is string => typeof field === 'string')
    .map((field) => field.trim())
    .filter((field) => field.length > 0);
};

export interface LookupConfig {
  /**
   * Fields to search when looking up products.
   * Defaults to PLYTIX_SEARCH_FIELDS env var or DEFAULT_SEARCH_FIELDS.
   * Use "attributes.mpn" format for custom attributes.
   */
  searchFields?: string[];
  pageSize?: number;
  cacheEnabled?: boolean;
  cacheTtlMs?: number;
}

export interface Match {
  id: string;
  sku?: string;
  label?: string;
  gtin?: string;
  matchedField: string;
  confidence: number;
  reason: string;
  raw: PlytixProduct;
}

export interface LookupResult {
  selected?: Match;
  matches: Match[];
  plan: string[];
}

interface CacheEntry {
  result: LookupResult;
  timestamp: number;
  ttl: number;
}

// ─────────────────────────────────────────────────────────────
// PlytixLookup Class
// ─────────────────────────────────────────────────────────────

export class PlytixLookup {
  private cache = new Map<string, CacheEntry>();
  private readonly searchFields: string[];

  constructor(
    private client: PlytixClient,
    private cfg: LookupConfig = {}
  ) {
    this.cfg = {
      pageSize: 5,
      cacheEnabled: true,
      cacheTtlMs: 60_000, // 1 minute
      ...cfg,
    };

    // Initialize search fields from config, env var, or defaults
    this.searchFields = this.initSearchFields();
  }

  /**
   * Initialize search fields from config, PLYTIX_SEARCH_FIELDS env var, or defaults.
   */
  private initSearchFields(): string[] {
    // 1. Use config if provided
    const configFields = sanitizeSearchFields(this.cfg.searchFields);
    if (configFields.length > 0) {
      return configFields;
    }

    // 2. Try PLYTIX_SEARCH_FIELDS env var (JSON array)
    const envFields = process.env.PLYTIX_SEARCH_FIELDS;
    if (envFields) {
      try {
        const parsed = JSON.parse(envFields);
        const envFieldsParsed = sanitizeSearchFields(parsed);
        if (envFieldsParsed.length > 0) {
          return envFieldsParsed;
        }
      } catch {
        // Ignore parse errors, fall through to defaults
      }
    }

    // 3. Use defaults
    return DEFAULT_SEARCH_FIELDS;
  }

  // ─────────────────────────────────────────────────────────────
  // Cache Management
  // ─────────────────────────────────────────────────────────────

  private getCacheKey(identifier: string, explicit?: IdentifierType, limit?: number): string {
    return `lookup:${identifier}:${explicit ?? 'auto'}:${limit ?? this.cfg.pageSize}`;
  }

  private getFromCache(key: string): LookupResult | undefined {
    if (!this.cfg.cacheEnabled) return undefined;

    const entry = this.cache.get(key);
    if (!entry) return undefined;

    if (Date.now() > entry.timestamp + entry.ttl) {
      this.cache.delete(key);
      return undefined;
    }

    return entry.result;
  }

  private setCache(key: string, result: LookupResult): void {
    if (!this.cfg.cacheEnabled) return;

    this.cache.set(key, {
      result,
      timestamp: Date.now(),
      ttl: this.cfg.cacheTtlMs!,
    });

    // Simple cleanup when cache grows too large
    if (this.cache.size > 100) {
      const now = Date.now();
      for (const [k, entry] of this.cache.entries()) {
        if (now > entry.timestamp + entry.ttl) {
          this.cache.delete(k);
        }
      }
    }
  }

  // ─────────────────────────────────────────────────────────────
  // Scoring
  // ─────────────────────────────────────────────────────────────

  private getFieldValue(obj: Record<string, unknown>, key: string): string | undefined {
    // Supports dotted keys like "attributes.mpn"
    const parts = key.split('.');
    let current: unknown = obj;

    for (const part of parts) {
      if (current == null || typeof current !== 'object') return undefined;
      current = (current as Record<string, unknown>)[part];
    }

    // Some APIs flatten custom attributes; try direct access as fallback
    const value = current ?? obj[key];
    return typeof value === 'string' ? value : undefined;
  }

  private scoreMatch(
    identifier: string,
    record: PlytixProduct,
    matchedField?: string
  ): { confidence: number; reason: string } {
    const idNorm = normalize(identifier);
    const candidates: Array<{ value: string; field: string }> = [];

    // Add standard fields
    for (const field of ['sku', 'label', 'gtin']) {
      const value = this.getFieldValue(record, field);
      if (value) candidates.push({ value, field });
    }

    // Add matched field if specified
    if (matchedField) {
      const value = this.getFieldValue(record, matchedField);
      if (value) candidates.push({ value, field: matchedField });
    }

    // Add custom attributes
    if (record.attributes && typeof record.attributes === 'object') {
      for (const [key, value] of Object.entries(record.attributes)) {
        if (typeof value === 'string') {
          candidates.push({ value, field: `attributes.${key}` });
        }
      }
    }

    let bestScore = 0;
    let bestReason = 'no_match';

    for (const { value } of candidates) {
      const valueNorm = normalize(value);

      // Exact match
      if (valueNorm === idNorm) {
        return { confidence: 1.0, reason: 'normalized_exact_match' };
      }

      // Prefix match
      if (valueNorm.startsWith(idNorm) || idNorm.startsWith(valueNorm)) {
        if (0.9 > bestScore) {
          bestScore = 0.9;
          bestReason = 'prefix_match';
        }
      }

      // Substring match
      if (valueNorm.includes(idNorm) || idNorm.includes(valueNorm)) {
        if (0.75 > bestScore) {
          bestScore = 0.75;
          bestReason = 'substring_match';
        }
      }

      // Similarity-based match
      const similarity = calculateSimilarity(identifier, value);
      if (similarity > bestScore && similarity > 0.6) {
        bestScore = similarity;
        bestReason = 'similarity_match';
      }
    }

    return { confidence: bestScore || 0.1, reason: bestReason };
  }

  // ─────────────────────────────────────────────────────────────
  // Main Lookup Method
  // ─────────────────────────────────────────────────────────────

  async findByIdentifier(
    identifier: string,
    explicitType?: IdentifierType,
    limit = 5
  ): Promise<LookupResult> {
    const cacheKey = this.getCacheKey(identifier, explicitType, limit);
    const cached = this.getFromCache(cacheKey);
    if (cached) return cached;

    const detection = detectIdentifierType(identifier);
    const type = explicitType ?? detection.type;
    const plan: string[] = [`detected_type:${type}(${detection.confidence})`];
    plan.push(`search_fields:${this.searchFields.join(',')}`);

    // Helper to execute search
    const executeSearch = async (body: PlytixSearchBody, tag: string): Promise<Match[]> => {
      plan.push(tag);

      // Request all configured search fields (up to API limit of 50)
      const attributes = [...new Set(this.searchFields)].slice(0, 50);

      const searchBody: PlytixSearchBody = {
        ...body,
        attributes,
        pagination: { page: 1, page_size: limit },
      };

      const result = await this.client.searchProducts(searchBody);
      const rows = result.data ?? [];

      return rows.map((record) => {
        const score = this.scoreMatch(identifier, record, tag);
        return {
          id: record.id,
          sku: record.sku,
          label: record.label,
          gtin: this.getFieldValue(record, 'gtin'),
          matchedField: tag,
          confidence: score.confidence,
          reason: score.reason,
          raw: record,
        };
      });
    };

    let matches: Match[] = [];

    // Strategy 1: Direct ID lookup
    if (type === 'id') {
      try {
        plan.push('direct_id_lookup');
        const productResult = await this.client.getProduct(identifier);
        if (productResult.data?.[0]) {
          const record = productResult.data[0];
          const match: Match = {
            id: record.id,
            sku: record.sku,
            label: record.label,
            gtin: this.getFieldValue(record, 'gtin'),
            matchedField: 'id',
            confidence: 1.0,
            reason: 'direct_id_lookup',
            raw: record,
          };

          const lookupResult: LookupResult = { selected: match, matches: [match], plan };
          this.setCache(cacheKey, lookupResult);
          return lookupResult;
        }
      } catch {
        plan.push('direct_id_lookup_failed');
      }
    }

    // Strategy 2: Exact field matches based on detected type
    const exactSearches: Array<{ body: PlytixSearchBody; tag: string }> = [];

    // For each configured search field, try exact match if type is compatible
    for (const field of this.searchFields) {
      // Always try standard fields for sku/gtin/unknown types
      if (field === 'sku' && (type === 'sku' || type === 'unknown')) {
        exactSearches.push({
          body: { filters: [[{ field: 'sku', operator: 'eq', value: identifier }]] },
          tag: 'sku_eq',
        });
      } else if (field === 'gtin' && type === 'gtin') {
        exactSearches.push({
          body: { filters: [[{ field: 'gtin', operator: 'eq', value: identifier }]] },
          tag: 'gtin_eq',
        });
      } else if (field === 'label' && type === 'label') {
        const tokens = identifier.split(/[^A-Za-z0-9]+/).filter(Boolean);
        exactSearches.push({
          body: { filters: [tokens.map((token) => ({ field: 'label', operator: 'like' as const, value: token }))] },
          tag: 'label_like_tokens',
        });
      } else if (field.startsWith('attributes.') && (type === 'mpn' || type === 'mno' || type === 'unknown')) {
        // Custom attribute fields - try exact match for MPN/MNO/unknown types
        exactSearches.push({
          body: { filters: [[{ field, operator: 'eq', value: identifier }]] },
          tag: `${field}_eq`,
        });
      }
    }

    // Execute exact searches
    for (const search of exactSearches) {
      try {
        const results = await executeSearch(search.body, search.tag);
        matches.push(...results);

        // Early exit on high-confidence match
        if (results.some((m) => m.confidence >= 0.99)) break;
      } catch {
        plan.push(`${search.tag}_failed`);
      }
    }

    // Strategy 3: Text search across all configured fields
    if (matches.length === 0) {
      try {
        const textSearchResults = await executeSearch(
          { filters: [[{ field: this.searchFields, operator: 'text_search', value: identifier }]] },
          'text_search_multi'
        );
        matches.push(...textSearchResults);
      } catch {
        plan.push('text_search_multi_failed');
      }
    }

    // Strategy 4: Broad LIKE search as last resort
    if (matches.length === 0) {
      try {
        const tokens = identifier.split(/[^A-Za-z0-9]+/).filter(Boolean);
        const firstToken = tokens[0] ?? identifier;

        // Build LIKE filters for first few search fields
        const broadFilters = this.searchFields.slice(0, 3).map((field) => ({
          field,
          operator: 'like' as const,
          value: firstToken,
        }));

        const broadResults = await executeSearch({ filters: [broadFilters] }, 'broad_like_search');
        matches.push(...broadResults);
      } catch {
        plan.push('broad_like_search_failed');
      }
    }

    // Sort by confidence and select best
    matches.sort((a, b) => b.confidence - a.confidence);

    const selected =
      matches[0] && (matches.length === 1 || matches[0].confidence - (matches[1]?.confidence ?? 0) >= 0.15)
        ? matches[0]
        : undefined;

    const result: LookupResult = { selected, matches, plan };
    this.setCache(cacheKey, result);
    return result;
  }

  // ─────────────────────────────────────────────────────────────
  // Multi-Criteria Search
  // ─────────────────────────────────────────────────────────────

  async findProducts(criteria: {
    sku?: string;
    mpn?: string;
    mno?: string;
    label?: string;
    gtin?: string;
    fuzzySearch?: string;
    limit?: number;
    returnFields?: string[];
  }): Promise<LookupResult> {
    const { limit = 5, returnFields = [] } = criteria;
    const plan: string[] = ['multi_criteria_search'];

    const filters: PlytixSearchBody['filters'] = [];

    if (criteria.sku) {
      filters.push([{ field: 'sku', operator: 'eq', value: criteria.sku }]);
    }
    if (criteria.gtin) {
      filters.push([{ field: 'gtin', operator: 'eq', value: criteria.gtin }]);
    }
    if (criteria.label) {
      const tokens = criteria.label.split(/[^A-Za-z0-9]+/).filter(Boolean);
      filters.push(tokens.map((token) => ({ field: 'label', operator: 'like' as const, value: token })));
    }
    // For MPN/MNO, search any custom attribute fields in searchFields
    const customAttrFields = this.searchFields.filter((f) => f.startsWith('attributes.'));
    if (criteria.mpn && customAttrFields.length > 0) {
      // Try the first custom attribute field for MPN
      filters.push([{ field: customAttrFields[0], operator: 'eq', value: criteria.mpn }]);
    }
    if (criteria.mno && customAttrFields.length > 1) {
      // Try the second custom attribute field for MNO if available
      filters.push([{ field: customAttrFields[1], operator: 'eq', value: criteria.mno }]);
    }
    if (criteria.fuzzySearch) {
      filters.push([{ field: this.searchFields, operator: 'text_search', value: criteria.fuzzySearch }]);
    }

    const attributes = [...new Set([...this.searchFields, ...returnFields])].slice(0, 50);

    try {
      const result = await this.client.searchProducts({
        filters: filters.length > 0 ? filters : undefined,
        attributes,
        pagination: { page: 1, page_size: limit },
      });

      const matches: Match[] = (result.data ?? []).map((record) => {
        let confidence = 0.5;
        const reason = 'multi_criteria_match';

        if (criteria.sku && record.sku === criteria.sku) confidence = Math.max(confidence, 0.9);
        if (criteria.gtin && this.getFieldValue(record, 'gtin') === criteria.gtin) {
          confidence = Math.max(confidence, 0.9);
        }

        return {
          id: record.id,
          sku: record.sku,
          label: record.label,
          gtin: this.getFieldValue(record, 'gtin'),
          matchedField: 'multi_criteria',
          confidence,
          reason,
          raw: record,
        };
      });

      matches.sort((a, b) => b.confidence - a.confidence);
      return { selected: matches[0], matches, plan };
    } catch {
      plan.push('multi_criteria_search_failed');
      return { matches: [], plan };
    }
  }
}
