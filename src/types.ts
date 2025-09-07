export type RelationshipName =
  | "replaces"
  | "includes"
  | "modules"
  | "has_optional_accessory";

export type HydratedRef = {
  id: string;
  sku: string | null;
  mpn: string | null;
  label: string | null;
  listPrice: number | null;
};

export type Product = {
  id: string;
  sku?: string;
  attributes?: Record<string, unknown>;
  replaces?: (string | HydratedRef)[];
  includes?: (string | HydratedRef)[];
  modules?: (string | HydratedRef)[];
  has_optional_accessory?: (string | HydratedRef)[];
  hierarchy?: HierarchyRefs;
};

export type HierarchyName = "brand" | "family" | "parent" | "variant";

export type HierarchyRefs = {
  level: 0 | 1 | 2 | 3 | 4;
  brand?: HydratedRef | null;
  family?: HydratedRef | null;
  parent?: HydratedRef | null;
  variant?: HydratedRef | null;
};

export type ResolveMode =
  | "none"
  | "relationships"
  | "hierarchy"
  | "all";

export interface Env {
  PLYTIX_MPN_ATTR_SLUG?: string;
  PLYTIX_LABEL_ATTR_SLUG?: string;
  PLYTIX_LIST_PRICE_ATTR_SLUG?: string;
  SKU_LEVEL_ATTR_SLUG?: string;
  FAMILY_SKU_ATTR_SLUG?: string;
  PARENT_SKU_ATTR_SLUG?: string;
  VARIANT_SKU_ATTR_SLUG?: string;
  BRAND_SKU_ATTR_SLUG?: string;
  FAMILY_SKU_REGEX?: string;
  PARENT_SKU_REGEX?: string;
  VARIANT_SKU_REGEX?: string;
}
