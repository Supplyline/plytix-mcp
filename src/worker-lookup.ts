/**
 * Smart Product Lookup for Cloudflare Workers
 *
 * Multi-stage search with confidence scoring.
 * This is a Workers-compatible version that doesn't use process.env.
 */

import type { WorkerPlytixClient } from './worker-client.js';
import type { PlytixSearchBody, PlytixProduct } from './types.js';
import {
  detectIdentifierType,
  type IdentifierType,
  normalize,
  calculateSimilarity,
} from './lookup/identifier.js';

// ─────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────

/**
 * Default search fields for vanilla Plytix.
 * Override with config.searchFields.
 */
export const DEFAULT_SEARCH_FIELDS = ['sku', 'label', 'gtin'];

/**
 * Default MPN/MNO labels for exact match searches.
 * Override with config.mpnLabels / config.mnoLabels.
 */
export const DEFAULT_MPN_LABELS = ['attributes.mpn'];
export const DEFAULT_MNO_LABELS = ['attributes.model_no'];

const normalizeAttributeLabel = (label: string): string | null => {
  const trimmed = label.trim();
  if (!trimmed) return null;
  return trimmed.startsWith('attributes.') ? trimmed : `attributes.${trimmed}`;
};

const normalizeAttributeLabels = (labels?: string[]): string[] => {
  if (!labels) return [];
  const normalized = labels
    .map((label) => (typeof label === 'string' ? normalizeAttributeLabel(label) : null))
    .filter((label): label is string => Boolean(label));
  return [...new Set(normalized)];
};

const sanitizeSearchFields = (fields: unknown): string[] => {
  if (!Array.isArray(fields)) return [];
  const cleaned = fields
    .filter((field): field is string => typeof field === 'string')
    .map((field) => field.trim())
    .filter((field) => field.length > 0);
  return [...new Set(cleaned)]; // Deduplicate to avoid redundant API calls
};

export interface WorkerLookupConfig {
  /**
   * Fields to search when looking up products.
   * Use "attributes.mpn" format for custom attributes.
   * Defaults to DEFAULT_SEARCH_FIELDS.
   */
  searchFields?: string[];
  /**
   * Attribute labels for MPN/MNO exact match searches.
   * Accepts labels (e.g., "mpn") or field paths (e.g., "attributes.mpn").
   * Defaults to DEFAULT_*_LABELS.
   */
  mpnLabels?: string[];
  mnoLabels?: string[];
  pageSize?: number;
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

// ─────────────────────────────────────────────────────────────
// WorkerPlytixLookup Class
// ─────────────────────────────────────────────────────────────

export class WorkerPlytixLookup {
  private readonly searchFields: string[];
  private readonly mpnFields: string[];
  private readonly mnoFields: string[];

  constructor(
    private client: WorkerPlytixClient,
    private cfg: WorkerLookupConfig = {}
  ) {
    this.cfg = {
      pageSize: 5,
      ...cfg,
    };

    // Initialize search fields from config or defaults
    const configFields = sanitizeSearchFields(cfg.searchFields);
    this.searchFields = configFields.length > 0 ? configFields : DEFAULT_SEARCH_FIELDS;
    this.mpnFields = this.initMpnFields();
    this.mnoFields = this.initMnoFields();
  }

  private initMpnFields(): string[] {
    const configLabels = normalizeAttributeLabels(this.cfg.mpnLabels);
    if (configLabels.length > 0) return configLabels;
    return normalizeAttributeLabels(DEFAULT_MPN_LABELS);
  }

  private initMnoFields(): string[] {
    const configLabels = normalizeAttributeLabels(this.cfg.mnoLabels);
    if (configLabels.length > 0) return configLabels;
    return normalizeAttributeLabels(DEFAULT_MNO_LABELS);
  }

  // ─────────────────────────────────────────────────────────────
  // Scoring
  // ─────────────────────────────────────────────────────────────

  private getFieldValue(obj: Record<string, unknown>, key: string): string | undefined {
    const parts = key.split('.');
    let current: unknown = obj;

    for (const part of parts) {
      if (current == null || typeof current !== 'object') return undefined;
      current = (current as Record<string, unknown>)[part];
    }

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

    for (const field of ['sku', 'label', 'gtin']) {
      const value = this.getFieldValue(record, field);
      if (value) candidates.push({ value, field });
    }

    if (matchedField) {
      const value = this.getFieldValue(record, matchedField);
      if (value) candidates.push({ value, field: matchedField });
    }

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

      if (valueNorm === idNorm) {
        return { confidence: 1.0, reason: 'normalized_exact_match' };
      }

      if (valueNorm.startsWith(idNorm) || idNorm.startsWith(valueNorm)) {
        if (0.9 > bestScore) {
          bestScore = 0.9;
          bestReason = 'prefix_match';
        }
      }

      if (valueNorm.includes(idNorm) || idNorm.includes(valueNorm)) {
        if (0.75 > bestScore) {
          bestScore = 0.75;
          bestReason = 'substring_match';
        }
      }

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
    const detection = detectIdentifierType(identifier);
    const type = explicitType ?? detection.type;
    const plan: string[] = [`detected_type:${type}(${detection.confidence})`];
    plan.push(`search_fields:${this.searchFields.join(',')}`);

    const executeSearch = async (
      body: PlytixSearchBody,
      tag: string,
      extraAttributes: string[] = []
    ): Promise<Match[]> => {
      plan.push(tag);

      const attributes = [...new Set([...this.searchFields, ...extraAttributes])].slice(0, 50);

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

          return { selected: match, matches: [match], plan };
        }
      } catch {
        plan.push('direct_id_lookup_failed');
      }
    }

    // Strategy 2: Exact field matches based on detected type
    const exactSearches: Array<{
      body: PlytixSearchBody;
      tag: string;
      extraAttributes?: string[];
    }> = [];
    const attributeExactFields = new Set<string>();

    for (const field of this.searchFields) {
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
        attributeExactFields.add(field);
      }
    }

    if (type === 'mpn' || type === 'unknown') {
      for (const field of this.mpnFields) {
        attributeExactFields.add(field);
      }
    }
    if (type === 'mno' || type === 'unknown') {
      for (const field of this.mnoFields) {
        attributeExactFields.add(field);
      }
    }

    for (const field of attributeExactFields) {
      exactSearches.push({
        body: { filters: [[{ field, operator: 'eq', value: identifier }]] },
        tag: `${field}_eq`,
        extraAttributes: [field],
      });
    }

    for (const search of exactSearches) {
      try {
        const results = await executeSearch(search.body, search.tag, search.extraAttributes ?? []);
        matches.push(...results);

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

    matches.sort((a, b) => b.confidence - a.confidence);

    const selected =
      matches[0] && (matches.length === 1 || matches[0].confidence - (matches[1]?.confidence ?? 0) >= 0.15)
        ? matches[0]
        : undefined;

    return { selected, matches, plan };
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
    // For MPN/MNO, search configured attribute labels
    if (criteria.mpn && this.mpnFields.length > 0) {
      filters.push(
        this.mpnFields.map((field) => ({ field, operator: 'eq', value: criteria.mpn }))
      );
    }
    if (criteria.mno && this.mnoFields.length > 0) {
      filters.push(
        this.mnoFields.map((field) => ({ field, operator: 'eq', value: criteria.mno }))
      );
    }
    if (criteria.fuzzySearch) {
      filters.push([{ field: this.searchFields, operator: 'text_search', value: criteria.fuzzySearch }]);
    }

    const extraAttributes: string[] = [];
    if (criteria.mpn) extraAttributes.push(...this.mpnFields);
    if (criteria.mno) extraAttributes.push(...this.mnoFields);
    const attributes = [...new Set([...this.searchFields, ...returnFields, ...extraAttributes])].slice(0, 50);

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
