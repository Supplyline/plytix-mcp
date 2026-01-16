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
  DEFAULT_MPN_LABELS,
  DEFAULT_MNO_LABELS,
} from './identifier.js';

// ─────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────

export interface LookupConfig {
  mpnLabels?: string[];
  mnoLabels?: string[];
  extraSearchFields?: string[];
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
  private discoveredLabels?: { mpn: string[]; mno: string[] };
  private discoveredAt?: number;
  private readonly discoveryTtl = 10 * 60 * 1000; // 10 minutes

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
  // Label Discovery
  // ─────────────────────────────────────────────────────────────

  private async discoverCustomLabels(): Promise<{ mpn: string[]; mno: string[] }> {
    const now = Date.now();

    // Return cached discovery if still valid
    if (this.discoveredLabels && this.discoveredAt && now - this.discoveredAt < this.discoveryTtl) {
      return this.discoveredLabels;
    }

    // Use configured labels if provided
    if (this.cfg.mpnLabels || this.cfg.mnoLabels) {
      const result = {
        mpn: this.cfg.mpnLabels ?? DEFAULT_MPN_LABELS,
        mno: this.cfg.mnoLabels ?? DEFAULT_MNO_LABELS,
      };
      this.discoveredLabels = result;
      this.discoveredAt = now;
      return result;
    }

    // Try environment variables
    try {
      const envMpn = process.env.PLYTIX_MPN_LABELS;
      const envMno = process.env.PLYTIX_MNO_LABELS;

      if (envMpn || envMno) {
        const result = {
          mpn: envMpn ? JSON.parse(envMpn) : DEFAULT_MPN_LABELS,
          mno: envMno ? JSON.parse(envMno) : DEFAULT_MNO_LABELS,
        };
        this.discoveredLabels = result;
        this.discoveredAt = now;
        return result;
      }
    } catch {
      // Ignore parse errors
    }

    // Fallback: inspect available filters to find attribute synonyms
    try {
      const filters = await this.client.getAvailableFilters();
      const attrs: string[] = [];

      if (filters.data) {
        for (const filter of filters.data) {
          if (filter.field?.startsWith('attributes.')) {
            attrs.push(filter.field);
          }
        }
      }

      const findMatchingFields = (patterns: RegExp[]) => {
        return attrs.filter((key) => patterns.some((pattern) => pattern.test(key)));
      };

      const mpnPatterns = [/\bmpn\b/i, /manufacturer.*part/i, /mfr.*part/i, /part_number/i, /part[-_. ]?no/i];
      const mnoPatterns = [/\bmodel\b/i, /model_?no/i, /\bmno\b/i, /item_?number/i];

      const result = {
        mpn: findMatchingFields(mpnPatterns),
        mno: findMatchingFields(mnoPatterns),
      };

      // Use defaults if nothing discovered
      if (!result.mpn.length) result.mpn = DEFAULT_MPN_LABELS;
      if (!result.mno.length) result.mno = DEFAULT_MNO_LABELS;

      this.discoveredLabels = result;
      this.discoveredAt = now;
      return result;
    } catch {
      // Final fallback
      const result = { mpn: DEFAULT_MPN_LABELS, mno: DEFAULT_MNO_LABELS };
      this.discoveredLabels = result;
      this.discoveredAt = now;
      return result;
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

    const { mpn, mno } = await this.discoverCustomLabels();
    plan.push(`labels:mpn(${mpn.length}),mno(${mno.length})`);

    // Helper to execute search
    const executeSearch = async (body: PlytixSearchBody, tag: string): Promise<Match[]> => {
      plan.push(tag);

      // Ensure standard + discovered attributes are requested
      const attributes = [
        ...new Set(['sku', 'label', 'gtin', ...mpn, ...mno, ...(this.cfg.extraSearchFields ?? [])]),
      ].slice(0, 50);

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

    // Strategy 2: Exact field matches
    const exactSearches: Array<{ body: PlytixSearchBody; tag: string }> = [];

    if (type === 'sku' || type === 'unknown') {
      exactSearches.push({
        body: { filters: [[{ field: 'sku', operator: 'eq', value: identifier }]] },
        tag: 'sku_eq',
      });
    }

    if (type === 'gtin') {
      exactSearches.push({
        body: { filters: [[{ field: 'gtin', operator: 'eq', value: identifier }]] },
        tag: 'gtin_eq',
      });
    }

    if (type === 'label') {
      const tokens = identifier.split(/[^A-Za-z0-9]+/).filter(Boolean);
      exactSearches.push({
        body: { filters: [tokens.map((token) => ({ field: 'label', operator: 'like' as const, value: token }))] },
        tag: 'label_like_tokens',
      });
    }

    if (type === 'mpn' || type === 'unknown') {
      for (const field of mpn) {
        exactSearches.push({
          body: { filters: [[{ field, operator: 'eq', value: identifier }]] },
          tag: `${field}_eq`,
        });
      }
    }

    if (type === 'mno' || type === 'unknown') {
      for (const field of mno) {
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

    // Strategy 3: Text search across multiple fields
    if (matches.length === 0) {
      try {
        const searchFields = ['sku', 'label', 'gtin', ...mpn, ...mno, ...(this.cfg.extraSearchFields ?? [])];
        const textSearchResults = await executeSearch(
          { filters: [[{ field: searchFields, operator: 'text_search', value: identifier }]] },
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

        const broadFilters = [
          { field: 'sku', operator: 'like' as const, value: firstToken },
          { field: 'label', operator: 'like' as const, value: firstToken },
        ];

        if (mpn[0]) {
          broadFilters.push({ field: mpn[0], operator: 'like' as const, value: firstToken });
        }

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

    const { mpn, mno } = await this.discoverCustomLabels();
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
    if (criteria.mpn && mpn[0]) {
      filters.push([{ field: mpn[0], operator: 'eq', value: criteria.mpn }]);
    }
    if (criteria.mno && mno[0]) {
      filters.push([{ field: mno[0], operator: 'eq', value: criteria.mno }]);
    }
    if (criteria.fuzzySearch) {
      const searchFields = ['sku', 'label', 'gtin', ...mpn, ...mno];
      filters.push([{ field: searchFields, operator: 'text_search', value: criteria.fuzzySearch }]);
    }

    const attributes = [...new Set(['sku', 'label', 'gtin', ...mpn, ...mno, ...returnFields])].slice(0, 50);

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
