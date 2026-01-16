/**
 * Channel Parser
 *
 * Utilities for parsing and normalizing Plytix Channel JSON exports.
 * Handles the quirks of Channel output (duplicate _1 fields, SKU Level parsing, etc.)
 */

import {
  type ChannelProduct,
  type NormalizedProduct,
  type ChannelParseOptions,
  parseSkuLevel,
  computeChecksum,
  parseDate,
  isDuplicateField,
  getBaseFieldName,
} from './types.js';

// ─────────────────────────────────────────────────────────────
// Channel Parser
// ─────────────────────────────────────────────────────────────

/**
 * Default fields to extract to top level (case-insensitive matching).
 */
const DEFAULT_EXTRACT_FIELDS = [
  'Product ID',
  'SKU',
  'Label',
  'MPN',
  'MNO',
  'GTIN',
  'SKU Level',
  'Group ID',
  'Family',
  'Variants',
  'Created',
  'Last modified',
  'Status',
  'Main Image',
  'Thumbnail',
  'Alt Images',
  'Categories',
];

/**
 * Known MPN field variations.
 */
const DEFAULT_MPN_FIELDS = ['MPN', 'Manufacturer Part Number', 'Part Number'];

/**
 * Known MNO field variations.
 */
const DEFAULT_MNO_FIELDS = ['MNO', 'Manufacturer Number', 'Model Number'];

/**
 * Parse a raw channel product to normalized format.
 */
export function normalizeProduct(
  raw: ChannelProduct,
  options: ChannelParseOptions = {}
): NormalizedProduct {
  const {
    deduplicate = true,
    mpnFields = DEFAULT_MPN_FIELDS,
    mnoFields = DEFAULT_MNO_FIELDS,
  } = options;

  // Build raw_attributes, excluding duplicates if requested
  const rawAttributes: Record<string, unknown> = {};
  const seenFields = new Set<string>();

  for (const [key, value] of Object.entries(raw)) {
    // Skip duplicate fields if deduplication is enabled
    if (deduplicate && isDuplicateField(key)) {
      const baseKey = getBaseFieldName(key);
      // Only skip if we already have the base field
      if (seenFields.has(baseKey)) {
        continue;
      }
    }

    // Track field names (normalize to handle case variations)
    const normalizedKey = deduplicate ? getBaseFieldName(key) : key;
    seenFields.add(normalizedKey);

    rawAttributes[normalizedKey] = value;
  }

  // Extract core identifiers
  const productId = getString(raw, 'Product ID');
  if (!productId) {
    throw new Error('Product missing required "Product ID" field');
  }

  const sku = getString(raw, 'SKU');
  const label = getString(raw, 'Label');
  const gtin = getString(raw, 'GTIN');

  // Find MPN from known field names
  const mpn = findFirstString(raw, mpnFields);

  // Find MNO from known field names
  const mno = findFirstString(raw, mnoFields);

  // Parse hierarchy
  const skuLevelRaw = getString(raw, 'SKU Level');
  const { level: skuLevel, label: skuLevelLabel } = parseSkuLevel(skuLevelRaw);
  const groupId = getString(raw, 'Group ID');
  const familyLabel = getString(raw, 'Family');

  // Get variants array
  const variants = getStringArray(raw, 'Variants');

  // Get categories
  const categories = getStringArray(raw, 'Categories');

  // Parse timestamps
  const plytixCreatedAt = parseDate(getString(raw, 'Created'));
  const plytixModifiedAt = parseDate(getString(raw, 'Last modified'));

  // Get status and images
  const status = getString(raw, 'Status');
  const mainImage = getString(raw, 'Main Image');
  const thumbnail = getString(raw, 'Thumbnail');

  // Build normalized product
  const normalized: NormalizedProduct = {
    id: productId,
    sku,
    label,
    gtin,
    mpn,
    mno,
    sku_level: skuLevel,
    sku_level_label: skuLevelLabel,
    group_id: groupId,
    family_label: familyLabel,
    family_id: null, // Resolved via API
    parent_id: null, // Resolved via group_id mapping
    product_type: null, // From API
    product_level: null, // From API
    overwritten_attributes: null, // Fetched on-demand
    inheritance_fetched_at: null,
    raw_attributes: rawAttributes,
    status,
    main_image: mainImage,
    thumbnail,
    categories,
    variant_skus: variants,
    plytix_created_at: plytixCreatedAt,
    plytix_modified_at: plytixModifiedAt,
    checksum: computeChecksum(rawAttributes),
    channel_synced_at: new Date().toISOString(),
  };

  return normalized;
}

/**
 * Parse an array of channel products.
 */
export function parseChannelExport(
  products: ChannelProduct[],
  options: ChannelParseOptions = {}
): {
  products: NormalizedProduct[];
  errors: Array<{ index: number; error: string; raw?: ChannelProduct }>;
  stats: {
    total: number;
    parsed: number;
    failed: number;
    bySkuLevel: Record<number, number>;
  };
} {
  const normalized: NormalizedProduct[] = [];
  const errors: Array<{ index: number; error: string; raw?: ChannelProduct }> = [];
  const bySkuLevel: Record<number, number> = {};

  for (let i = 0; i < products.length; i++) {
    try {
      const product = normalizeProduct(products[i], options);
      normalized.push(product);

      // Track SKU level stats
      if (product.sku_level !== null) {
        bySkuLevel[product.sku_level] = (bySkuLevel[product.sku_level] || 0) + 1;
      }
    } catch (error) {
      errors.push({
        index: i,
        error: error instanceof Error ? error.message : 'Unknown error',
        raw: products[i],
      });
    }
  }

  return {
    products: normalized,
    errors,
    stats: {
      total: products.length,
      parsed: normalized.length,
      failed: errors.length,
      bySkuLevel,
    },
  };
}

/**
 * Build parent_id mappings from group_id relationships.
 *
 * Logic:
 * - SKU Level 1 (Family): No parent
 * - SKU Level 2 (Parent): Parent is SKU Level 1 with same Group ID prefix
 * - SKU Level 3 (Child): Parent is SKU Level 2 in same Group ID
 */
export function resolveParentIds(
  products: NormalizedProduct[]
): Map<string, string> {
  const parentMap = new Map<string, string>();

  // Build lookup by group_id and sku_level
  const byGroupAndLevel = new Map<string, Map<number, NormalizedProduct[]>>();

  for (const product of products) {
    if (!product.group_id) continue;

    if (!byGroupAndLevel.has(product.group_id)) {
      byGroupAndLevel.set(product.group_id, new Map());
    }

    const levelMap = byGroupAndLevel.get(product.group_id)!;
    const level = product.sku_level ?? 0;

    if (!levelMap.has(level)) {
      levelMap.set(level, []);
    }
    levelMap.get(level)!.push(product);
  }

  // Resolve parents
  for (const product of products) {
    if (!product.group_id || !product.sku_level) continue;

    // Level 2 products: parent is the level 1 family
    if (product.sku_level === 2) {
      // Family group_id is typically the family_label
      const familyProducts = products.filter(
        (p) => p.sku_level === 1 && p.family_label === product.family_label
      );
      if (familyProducts.length === 1) {
        parentMap.set(product.id, familyProducts[0].id);
      }
    }

    // Level 3 products: parent is level 2 in same group
    if (product.sku_level === 3) {
      const levelMap = byGroupAndLevel.get(product.group_id);
      if (levelMap) {
        const parentCandidates = levelMap.get(2);
        if (parentCandidates?.length === 1) {
          parentMap.set(product.id, parentCandidates[0].id);
        }
      }
    }
  }

  return parentMap;
}

/**
 * Build family label to ID mapping from families API response.
 */
export function buildFamilyLabelMap(
  families: Array<{ id: string; label?: string; name?: string }>
): Map<string, string> {
  const map = new Map<string, string>();

  for (const family of families) {
    // Map both label and name to ID
    if (family.label) {
      map.set(family.label, family.id);
    }
    if (family.name) {
      map.set(family.name, family.id);
    }
  }

  return map;
}

// ─────────────────────────────────────────────────────────────
// Helper Functions
// ─────────────────────────────────────────────────────────────

/**
 * Safely get a string value from an object.
 */
function getString(obj: Record<string, unknown>, key: string): string | null {
  const value = obj[key];
  if (typeof value === 'string') {
    return value || null;
  }
  if (typeof value === 'number') {
    return String(value);
  }
  return null;
}

/**
 * Find the first non-null string value from a list of possible keys.
 */
function findFirstString(
  obj: Record<string, unknown>,
  keys: string[]
): string | null {
  for (const key of keys) {
    const value = getString(obj, key);
    if (value !== null) {
      return value;
    }
  }
  return null;
}

/**
 * Safely get a string array from an object.
 */
function getStringArray(
  obj: Record<string, unknown>,
  key: string
): string[] | null {
  const value = obj[key];
  if (Array.isArray(value)) {
    return value.filter((v) => typeof v === 'string') as string[];
  }
  return null;
}
