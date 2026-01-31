// Plytix API Types

// ─────────────────────────────────────────────────────────────
// Search & Filters
// ─────────────────────────────────────────────────────────────

export type FilterOperator =
  | 'eq' | '!eq'
  | 'like'
  | 'in' | '!in'
  | 'gt' | 'gte' | 'lt' | 'lte'
  | 'exists' | '!exists'
  | 'text_search';

export interface PlytixSearchFilter {
  field: string | string[];
  operator: FilterOperator;
  value?: unknown;
}

export interface PlytixSearchBody {
  filters?: PlytixSearchFilter[][];
  attributes?: string[];
  pagination?: {
    page?: number;
    page_size?: number;
    order?: string;
  };
  sort?: unknown;
}

export interface PlytixPagination {
  page: number;
  page_size: number;
  total: number;
  pages: number;
}

export interface PlytixResult<T = unknown> {
  data: T[];
  pagination?: PlytixPagination;
  attributes?: string[];
}

// ─────────────────────────────────────────────────────────────
// Authentication
// ─────────────────────────────────────────────────────────────

export interface PlytixAuthToken {
  value: string;
  exp: number;
}

export interface PlytixAuthResponse {
  access_token: string;
  expires_in?: number;
}

// ─────────────────────────────────────────────────────────────
// Rate Limiting
// ─────────────────────────────────────────────────────────────

export interface RateLimitInfo {
  limit: number;
  remaining: number;
  reset: number; // Unix timestamp
}

// ─────────────────────────────────────────────────────────────
// Products
// ─────────────────────────────────────────────────────────────

export type ProductType = 'PARENT' | 'VARIANT' | 'STANDALONE';

export interface PlytixProduct {
  id: string;
  sku?: string;
  label?: string;
  gtin?: string;
  status?: string;
  created?: string;
  modified?: string;

  // Family/inheritance
  product_family_id?: string;
  product_family_model_id?: string;
  product_level?: number;
  product_type?: ProductType;

  // Inheritance tracking - attributes explicitly set (not inherited from family)
  overwritten_attributes?: string[];

  // Relationships
  relationships?: PlytixRelationship[];
  num_variations?: number;

  // Custom attributes
  attributes?: Record<string, unknown>;

  // Linked entities (when hydrated)
  variants?: PlytixProduct[];
  assets?: PlytixAsset[];
  categories?: PlytixCategory[];

  // Allow additional fields
  [key: string]: unknown;
}

export interface PlytixRelationship {
  relationship_id: string;
  relationship_label: string;
  related_products?: Array<{
    product_id: string;
    quantity?: number;
    last_modified?: string;
  }>;
}

// ─────────────────────────────────────────────────────────────
// Families
// ─────────────────────────────────────────────────────────────

export interface PlytixFamily {
  id: string;
  name: string;
  attributes?: string[];  // attribute labels linked to this family
  parent_id?: string;     // parent family for inheritance
  created?: string;
  modified?: string;
  [key: string]: unknown;
}

export interface PlytixFamilyAttribute {
  label: string;          // e.g., "head_material" (snake_case identifier)
  name: string;           // e.g., "Head Material" (human-readable)
  type?: string;          // e.g., "dropdown", "text", "number"
  group?: string;         // attribute group
  required?: boolean;
  inherited?: boolean;    // whether inherited from parent family
  default_value?: unknown;
  options?: unknown[];    // for dropdown/multiselect types
}

// ─────────────────────────────────────────────────────────────
// Assets
// ─────────────────────────────────────────────────────────────

export interface PlytixAsset {
  id: string;
  name: string;
  url: string;
  type: string;
  size?: number;
  categories?: string[];
  created?: string;
  modified?: string;
  [key: string]: unknown;
}

// ─────────────────────────────────────────────────────────────
// Categories
// ─────────────────────────────────────────────────────────────

export interface PlytixCategory {
  id?: string;
  name: string;
  path: string[];
  parent_id?: string;
  count?: number;
  [key: string]: unknown;
}

// ─────────────────────────────────────────────────────────────
// Attributes (metadata)
// ─────────────────────────────────────────────────────────────

export interface PlytixAttribute {
  key: string;            // e.g., "attributes.head_material" or "sku"
  label?: string;         // human-readable name
  type?: string;          // field type
  group?: string;         // attribute group
  required?: boolean;
  options?: unknown[];
}

/**
 * Full attribute detail from GET /attributes/product/{id}
 *
 * Note: Plytix API naming is confusing:
 * - API "label" = snake_case identifier (e.g., "head_material")
 * - API "name" = human-readable display name (e.g., "Head Material")
 */
export interface PlytixAttributeDetail {
  id: string;
  label: string;          // snake_case identifier (e.g., "head_material")
  name: string;           // display name (e.g., "Head Material")
  type_class: string;     // "DropdownAttribute", "MultiSelectAttribute", "TextAttribute", etc.
  options?: string[];     // allowed values for dropdown/multiselect
  groups?: string[];      // attribute groups this belongs to
  description?: string;
  required?: boolean;
  searchable?: boolean;
  filterable?: boolean;
  created?: string;
  modified?: string;
}

export interface PlytixFilterDefinition {
  field: string;
  type: string;
  label?: string;
  options?: unknown[];
}

// ─────────────────────────────────────────────────────────────
// Client Configuration
// ─────────────────────────────────────────────────────────────

export interface PlytixClientConfig {
  apiKey: string;
  apiPassword: string;
  baseUrl?: string;
  authUrl?: string;
  timeoutMs?: number;
}

// ─────────────────────────────────────────────────────────────
// Errors
// ─────────────────────────────────────────────────────────────

export class PlytixError extends Error {
  constructor(
    message: string,
    public status?: number,
    public response?: unknown,
    public rateLimitInfo?: RateLimitInfo
  ) {
    super(message);
    this.name = 'PlytixError';
  }
}
