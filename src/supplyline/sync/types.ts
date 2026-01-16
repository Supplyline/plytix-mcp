/**
 * Types for Plytix Channel Sync
 *
 * These types represent the data structures used for syncing
 * Plytix Channel exports to Supabase.
 */

import { createHash } from 'crypto';

// ─────────────────────────────────────────────────────────────
// Channel Export Types (from Plytix JSON export)
// ─────────────────────────────────────────────────────────────

/**
 * Raw product from Plytix Channel JSON export.
 * Note: Fields with _1 suffix are duplicates from Parent/Variant fill settings.
 */
export interface ChannelProduct {
  // Core identifiers
  'Product ID'?: string;
  SKU?: string;
  Label?: string;
  MPN?: string;
  MNO?: string;
  GTIN?: string;

  // Hierarchy
  'SKU Level'?: string; // "1 | Family", "2 | Parent", "3 | Child"
  'Group ID'?: string;
  Family?: string;
  Variants?: string[]; // Array of child SKUs

  // Timestamps
  Created?: string;
  'Last modified'?: string;

  // Status
  Status?: string;

  // Images
  'Main Image'?: string;
  Thumbnail?: string;
  'Alt Images'?: string[];

  // Categories
  Categories?: string[];

  // All other attributes
  [key: string]: unknown;
}

// ─────────────────────────────────────────────────────────────
// Normalized Types (for Supabase)
// ─────────────────────────────────────────────────────────────

/**
 * Normalized product ready for Supabase upsert.
 */
export interface NormalizedProduct {
  id: string;
  sku: string | null;
  label: string | null;
  gtin: string | null;
  mpn: string | null;
  mno: string | null;

  // Hierarchy
  sku_level: number | null;
  sku_level_label: string | null;
  group_id: string | null;

  // Family
  family_label: string | null;
  family_id: string | null; // Resolved via API lookup

  // Parent/Variant
  parent_id: string | null; // Resolved via group_id mapping
  product_type: string | null;
  product_level: number | null;

  // Inheritance (null until fetched via API)
  overwritten_attributes: string[] | null;
  inheritance_fetched_at: string | null;

  // All attributes (deduplicated)
  raw_attributes: Record<string, unknown>;

  // Key fields
  status: string | null;
  main_image: string | null;
  thumbnail: string | null;

  // Arrays
  categories: string[] | null;
  variant_skus: string[] | null;

  // Plytix timestamps
  plytix_created_at: string | null;
  plytix_modified_at: string | null;

  // Sync metadata
  checksum: string;
  channel_synced_at: string;
}

/**
 * Sync operation result.
 */
export interface SyncResult {
  sync_type: 'channel' | 'families' | 'attributes' | 'inheritance';
  started_at: string;
  completed_at: string | null;
  status: 'running' | 'completed' | 'failed';
  records_processed: number;
  records_created: number;
  records_updated: number;
  records_skipped: number;
  error_message: string | null;
  error_details: unknown | null;
}

/**
 * Channel parse options.
 */
export interface ChannelParseOptions {
  /** Remove _1 suffix duplicate fields */
  deduplicate?: boolean;
  /** List of fields to extract to top level */
  extractFields?: string[];
  /** Custom MPN field names */
  mpnFields?: string[];
  /** Custom MNO field names */
  mnoFields?: string[];
}

// ─────────────────────────────────────────────────────────────
// Helper Functions
// ─────────────────────────────────────────────────────────────

/**
 * Parse SKU Level string to number and label.
 * Input: "2 | Parent"
 * Output: { level: 2, label: "Parent" }
 */
export function parseSkuLevel(value: string | null | undefined): {
  level: number | null;
  label: string | null;
} {
  if (!value || typeof value !== 'string') {
    return { level: null, label: null };
  }

  const match = value.match(/^(\d+)\s*\|\s*(.+)$/);
  if (match) {
    return {
      level: parseInt(match[1], 10),
      label: match[2].trim(),
    };
  }

  return { level: null, label: null };
}

/**
 * Compute MD5 checksum for change detection.
 */
export function computeChecksum(data: Record<string, unknown>): string {
  // Sort keys for consistent hashing
  const normalized = JSON.stringify(data, Object.keys(data).sort());
  return createHash('md5').update(normalized).digest('hex');
}

/**
 * Parse ISO date string, handling various formats.
 */
export function parseDate(value: string | null | undefined): string | null {
  if (!value) return null;

  // Handle YYYY-MM-DD format
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return new Date(value).toISOString();
  }

  // Handle ISO format
  const date = new Date(value);
  if (!isNaN(date.getTime())) {
    return date.toISOString();
  }

  return null;
}

/**
 * Check if a field name is a _1 suffix duplicate.
 */
export function isDuplicateField(key: string): boolean {
  return /_1$/.test(key);
}

/**
 * Get the base field name without _1 suffix.
 */
export function getBaseFieldName(key: string): string {
  return key.replace(/_1$/, '');
}
