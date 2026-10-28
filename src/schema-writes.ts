/**
 * Schema Writes — shared logic for the tools that change the catalog's *shape*
 * (attribute definitions, the category tree) and for product deletion.
 *
 * The stdio tools (`src/tools/*.ts`) and the Worker (`src/worker.ts`) both import
 * from here so the two surfaces validate inputs and build previews identically.
 * Everything in this module is pure: no client, no I/O.
 *
 * Endpoint facts these helpers encode (apidocs.plytix.com, verified 2026-10-28):
 *
 * - `POST /api/v1/attributes/product` needs `name` + `type_class`; `options`,
 *   `manual_sorting` and `sort_ascending` apply only to dropdown/multiselect,
 *   `attributes` only to a completeness attribute.
 * - `PATCH /api/v1/attributes/product/:id` can change `name` and `description`
 *   on any attribute; on dropdown/multiselect `options` **replaces** the full
 *   list, and `renamed_options` (old → new) keeps product values attached
 *   through a rename. A renamed option must still appear in `options` under
 *   its new name.
 * - `PATCH /api/v1/categories/product/:id` accepts `name`, `parent_id` (empty
 *   string = make root) and `sort_children` (every child id, in order), but
 *   never `parent_id` and `sort_children` together.
 * - `DELETE /api/v1/categories/product/:id` removes the whole subtree.
 * - `DELETE /api/v2/products/:id` removes a parent's variants with it unless
 *   they are unlinked first.
 */

import type { PlytixAttributeDetail, PlytixCategory, PlytixProduct } from './types.js';
import { OPTION_TYPE_CLASSES } from './types.js';

export { OPTION_TYPE_CLASSES };

// ─────────────────────────────────────────────────────────────
// Attribute definitions
// ─────────────────────────────────────────────────────────────

/**
 * Attribute types Plytix accepts on create. `MultilineAttribute` is deliberately
 * absent: Plytix now creates it as `TextAttribute` (see docs/solutions/api-quirks).
 */
export const ATTRIBUTE_TYPE_CLASSES = [
  'TextAttribute',
  'HtmlAttribute',
  'IntAttribute',
  'DecimalAttribute',
  'DropdownAttribute',
  'MultiSelectAttribute',
  'DateAttribute',
  'UrlAttribute',
  'BooleanAttribute',
  'MediaAttribute',
  'MediaGalleryAttribute',
  'CompletenessAttribute',
] as const;

export type AttributeTypeClass = (typeof ATTRIBUTE_TYPE_CLASSES)[number];

/** Where an attribute sits in a family when it is created with `product_families`. */
export const ATTRIBUTE_LEVELS = ['no_level', 'parent_level', 'variant_level'] as const;
export type AttributeLevel = (typeof ATTRIBUTE_LEVELS)[number];

export interface AttributeCreateInput {
  name: string;
  type_class: string;
  description?: string;
  options?: string[];
  manual_sorting?: boolean;
  sort_ascending?: boolean;
  product_families?: Array<{ id: string; attribute_level?: AttributeLevel }>;
  /** Completeness attributes only: the attributes they track. */
  attributes?: Array<{ id: string | null; label: string }>;
}

/**
 * Validate a create request before it is sent. Returns the problems found;
 * an empty list means the request is well-formed for its `type_class`.
 */
export function validateAttributeCreate(input: AttributeCreateInput): string[] {
  const errors: string[] = [];
  const name = input.name?.trim();
  if (!name) errors.push('name is required');

  if (!(ATTRIBUTE_TYPE_CLASSES as readonly string[]).includes(input.type_class)) {
    errors.push(
      `type_class must be one of ${ATTRIBUTE_TYPE_CLASSES.join(', ')} (got "${input.type_class}")`
    );
  }

  const isOptionType = OPTION_TYPE_CLASSES.has(input.type_class);
  if (!isOptionType) {
    for (const field of ['options', 'manual_sorting', 'sort_ascending'] as const) {
      if (input[field] !== undefined) {
        errors.push(`${field} applies only to DropdownAttribute and MultiSelectAttribute`);
      }
    }
  }
  if (input.options !== undefined) {
    const dupes = duplicates(input.options);
    if (dupes.length > 0) errors.push(`options contains duplicates: ${dupes.join(', ')}`);
    if (input.options.some((o) => o.trim() === '')) errors.push('options cannot contain empty values');
  }

  if (input.type_class === 'CompletenessAttribute') {
    if (!input.attributes || input.attributes.length === 0) {
      errors.push('attributes (the tracked attributes) is required for CompletenessAttribute');
    }
  } else if (input.attributes !== undefined) {
    errors.push('attributes applies only to CompletenessAttribute');
  }

  for (const family of input.product_families ?? []) {
    if (!family.id) errors.push('product_families entries need an id');
    if (
      family.attribute_level !== undefined &&
      !(ATTRIBUTE_LEVELS as readonly string[]).includes(family.attribute_level)
    ) {
      errors.push(
        `product_families attribute_level must be one of ${ATTRIBUTE_LEVELS.join(', ')} (got "${family.attribute_level}")`
      );
    }
  }

  return errors;
}

/** The body `POST /api/v1/attributes/product` receives, with undefined fields dropped. */
export function attributeCreateBody(input: AttributeCreateInput): Record<string, unknown> {
  const body: Record<string, unknown> = {
    name: input.name.trim(),
    type_class: input.type_class,
  };
  if (input.description !== undefined) body.description = input.description;
  if (input.options !== undefined) body.options = input.options;
  if (input.manual_sorting !== undefined) body.manual_sorting = input.manual_sorting;
  if (input.sort_ascending !== undefined) body.sort_ascending = input.sort_ascending;
  if (input.product_families !== undefined) {
    body.product_families = input.product_families.map((f) => ({
      id: f.id,
      attribute_level: f.attribute_level ?? 'no_level',
    }));
  }
  if (input.attributes !== undefined) body.attributes = input.attributes;
  return body;
}

/**
 * How a caller may edit an option list. `options` is the raw API form (the full
 * replacement list). The other three are conveniences resolved against the
 * attribute's current options so the caller never has to resend the whole list.
 */
export interface OptionEdit {
  options?: string[];
  add_options?: string[];
  remove_options?: string[];
  renamed_options?: Record<string, string>;
}

export type OptionEditResult =
  | {
      ok: true;
      /** Full list to send as `options`, or undefined when nothing about the options changes. */
      options?: string[];
      renamed_options?: Record<string, string>;
      added: string[];
      removed: string[];
      renamed: Record<string, string>;
      /** Values in add_options that already existed (skipped, not an error). */
      already_present: string[];
    }
  | { ok: false; reason: string };

export function hasOptionEdit(edit: OptionEdit): boolean {
  return (
    edit.options !== undefined ||
    edit.add_options !== undefined ||
    edit.remove_options !== undefined ||
    edit.renamed_options !== undefined
  );
}

/**
 * Resolve an option edit into the exact `options` / `renamed_options` the PATCH
 * endpoint expects. Order of application: remove, rename, add. Enforces the
 * documented rename restrictions up front so the caller gets a clear message
 * instead of a 422.
 */
export function resolveOptionEdit(current: string[] | undefined, edit: OptionEdit): OptionEditResult {
  if (!hasOptionEdit(edit)) {
    return { ok: true, added: [], removed: [], renamed: {}, already_present: [] };
  }

  const usesIncremental =
    edit.add_options !== undefined || edit.remove_options !== undefined;
  if (edit.options !== undefined && usesIncremental) {
    return {
      ok: false,
      reason: 'Pass either options (full replacement list) or add_options/remove_options, not both.',
    };
  }

  const renames = edit.renamed_options ?? {};
  const renameEntries = Object.entries(renames);

  // Full replacement: trust the caller's list, but still check the rename map.
  if (edit.options !== undefined) {
    const dupes = duplicates(edit.options);
    if (dupes.length > 0) return { ok: false, reason: `options contains duplicates: ${dupes.join(', ')}` };
    if (edit.options.some((o) => o.trim() === '')) {
      return { ok: false, reason: 'options cannot contain empty values' };
    }
    for (const [from, to] of renameEntries) {
      if (!edit.options.includes(to)) {
        return {
          ok: false,
          reason: `renamed_options maps "${from}" to "${to}" but "${to}" is not in options; a renamed option must appear in options under its new name.`,
        };
      }
      if (current && !current.includes(from)) {
        return { ok: false, reason: `renamed_options: "${from}" is not a current option.` };
      }
    }
    const targetDupes = duplicates(renameEntries.map(([, to]) => to));
    if (targetDupes.length > 0) {
      return { ok: false, reason: `renamed_options maps two options to the same name: ${targetDupes.join(', ')}` };
    }
    const unchanged = current !== undefined && sameList(current, edit.options) && renameEntries.length === 0;
    return {
      ok: true,
      ...(unchanged ? {} : { options: edit.options }),
      ...(renameEntries.length > 0 ? { renamed_options: renames } : {}),
      added: current ? edit.options.filter((o) => !current.includes(o) && !renameEntries.some(([, to]) => to === o)) : edit.options,
      removed: current ? current.filter((o) => !edit.options!.includes(o) && !(o in renames)) : [],
      renamed: renames,
      already_present: [],
    };
  }

  // Incremental: we need the current list to build the replacement from.
  if (current === undefined) {
    return {
      ok: false,
      reason: 'add_options, remove_options and renamed_options need the attribute to have an options list (DropdownAttribute or MultiSelectAttribute).',
    };
  }

  let list = [...current];
  const removed: string[] = [];
  for (const value of edit.remove_options ?? []) {
    if (value in renames) {
      return { ok: false, reason: `"${value}" cannot be both removed and renamed in one request.` };
    }
    const idx = list.indexOf(value);
    if (idx === -1) {
      return { ok: false, reason: `remove_options: "${value}" is not a current option.` };
    }
    list.splice(idx, 1);
    removed.push(value);
  }

  const targetDupes = duplicates(renameEntries.map(([, to]) => to));
  if (targetDupes.length > 0) {
    return { ok: false, reason: `renamed_options maps two options to the same name: ${targetDupes.join(', ')}` };
  }
  for (const [from, to] of renameEntries) {
    if (!to.trim()) return { ok: false, reason: `renamed_options: "${from}" cannot be renamed to an empty value.` };
    if (from === to) return { ok: false, reason: `renamed_options: "${from}" is renamed to itself.` };
    const idx = list.indexOf(from);
    if (idx === -1) return { ok: false, reason: `renamed_options: "${from}" is not a current option.` };
    if (current.includes(to)) {
      return {
        ok: false,
        reason: `renamed_options: "${to}" is already an option. Plytix refuses a rename onto an existing name; rename that option away first in a separate request.`,
      };
    }
    list[idx] = to;
  }

  const added: string[] = [];
  const alreadyPresent: string[] = [];
  for (const value of edit.add_options ?? []) {
    if (!value.trim()) return { ok: false, reason: 'add_options cannot contain empty values' };
    if (list.includes(value)) {
      alreadyPresent.push(value);
      continue;
    }
    list.push(value);
    added.push(value);
  }

  const unchanged = sameList(current, list) && renameEntries.length === 0;
  return {
    ok: true,
    ...(unchanged ? {} : { options: list }),
    ...(renameEntries.length > 0 ? { renamed_options: renames } : {}),
    added,
    removed,
    renamed: renames,
    already_present: alreadyPresent,
  };
}

export interface AttributeUpdateInput extends OptionEdit {
  name?: string;
  description?: string;
  /** Completeness attributes only. */
  attributes?: Array<{ id: string | null; label: string }>;
}

/**
 * Turn an update request into the PATCH body, given the attribute as it is now.
 * Returns `{ body: undefined }` when there is nothing to send.
 */
export function attributeUpdateBody(
  current: PlytixAttributeDetail,
  input: AttributeUpdateInput
):
  | { ok: true; body: Record<string, unknown> | undefined; options: OptionEditResult & { ok: true } }
  | { ok: false; reason: string } {
  const body: Record<string, unknown> = {};
  if (input.name !== undefined) {
    if (!input.name.trim()) return { ok: false, reason: 'name cannot be empty' };
    body.name = input.name.trim();
  }
  if (input.description !== undefined) body.description = input.description;

  if (input.attributes !== undefined) {
    if (current.type_class !== 'CompletenessAttribute') {
      return { ok: false, reason: 'attributes can only be patched on a CompletenessAttribute' };
    }
    body.attributes = input.attributes;
  }

  if (hasOptionEdit(input) && !OPTION_TYPE_CLASSES.has(current.type_class)) {
    return {
      ok: false,
      reason: `${current.label} is a ${current.type_class}; options can only be edited on DropdownAttribute and MultiSelectAttribute.`,
    };
  }
  const options = resolveOptionEdit(current.options, input);
  if (!options.ok) return options;
  if (options.options !== undefined) body.options = options.options;
  if (options.renamed_options !== undefined) {
    // Plytix needs the full final list alongside the rename map.
    body.options = options.options ?? applyRenames(current.options ?? [], options.renamed_options);
    body.renamed_options = options.renamed_options;
  }

  return { ok: true, body: Object.keys(body).length > 0 ? body : undefined, options };
}

function applyRenames(list: string[], renames: Record<string, string>): string[] {
  return list.map((o) => (o in renames ? renames[o]! : o));
}

// ─────────────────────────────────────────────────────────────
// Category tree
// ─────────────────────────────────────────────────────────────

export interface CategoryUpdateInput {
  name?: string;
  /** New parent id, or empty string to make the category a root. */
  parent_id?: string;
  /** Every direct child id in the desired order. */
  sort_children?: string[];
}

/** Validate a category PATCH and return its body, or the reason it cannot be sent. */
export function categoryUpdateBody(
  input: CategoryUpdateInput
): { ok: true; body: Record<string, unknown> } | { ok: false; reason: string } {
  const body: Record<string, unknown> = {};
  if (input.name !== undefined) {
    if (!input.name.trim()) return { ok: false, reason: 'name cannot be empty' };
    body.name = input.name.trim();
  }
  if (input.parent_id !== undefined) body.parent_id = input.parent_id;
  if (input.sort_children !== undefined) {
    const dupes = duplicates(input.sort_children);
    if (dupes.length > 0) {
      return { ok: false, reason: `sort_children contains duplicates: ${dupes.join(', ')}` };
    }
    body.sort_children = input.sort_children;
  }
  if (input.parent_id !== undefined && input.sort_children !== undefined) {
    return {
      ok: false,
      reason: 'Plytix does not accept parent_id and sort_children in the same request. Move the category first, then sort.',
    };
  }
  if (Object.keys(body).length === 0) {
    return { ok: false, reason: 'Nothing to update: pass name, parent_id, or sort_children.' };
  }
  return { ok: true, body };
}

/**
 * Check a requested child order against the children that actually exist.
 * Plytix returns 422 for a partial or stale list; this catches it earlier
 * and says which ids are off.
 */
export function checkSortChildren(
  requested: string[],
  actual: PlytixCategory[]
): { ok: true } | { ok: false; reason: string } {
  const actualIds = new Set(actual.map((c) => c.id).filter((id): id is string => !!id));
  const missing = [...actualIds].filter((id) => !requested.includes(id));
  const unknown = requested.filter((id) => !actualIds.has(id));
  if (missing.length === 0 && unknown.length === 0) return { ok: true };
  const parts: string[] = [];
  if (missing.length > 0) parts.push(`missing current children: ${missing.join(', ')}`);
  if (unknown.length > 0) parts.push(`not children of this category: ${unknown.join(', ')}`);
  return {
    ok: false,
    reason: `sort_children must list every direct child exactly once (${parts.join('; ')}).`,
  };
}

export interface CategorySummary {
  id?: string;
  name: string;
  path: string[];
  n_children?: number;
}

export function summarizeCategory(category: PlytixCategory): CategorySummary {
  return {
    id: category.id,
    name: category.name,
    path: category.path ?? [],
    ...(typeof category.n_children === 'number' ? { n_children: category.n_children } : {}),
  };
}

/** Preview shown on a category delete dry run. */
export function buildCategoryDeletePreview(
  category: PlytixCategory,
  children: PlytixCategory[],
  moveChildrenTo: string | undefined
): Record<string, unknown> {
  const nChildren = typeof category.n_children === 'number' ? category.n_children : children.length;
  const preview: Record<string, unknown> = {
    category: summarizeCategory(category),
    direct_children: children.map(summarizeCategory),
  };
  if (moveChildrenTo !== undefined) {
    preview.children_moved_to = moveChildrenTo === '' ? 'root' : moveChildrenTo;
    preview.warning =
      children.length > 0
        ? `The ${children.length} direct children (and their subtrees) will first be moved under ${moveChildrenTo === '' ? 'the root level' : moveChildrenTo}, then "${category.name}" will be deleted.`
        : `"${category.name}" has no children; it will be deleted.`;
  } else if (nChildren > 0) {
    preview.warning = `Deleting "${category.name}" removes its entire subtree (${nChildren} direct children, plus their descendants). Pass move_children_to (a category id, or "" for root) to keep them.`;
  } else {
    preview.warning = `"${category.name}" has no children; it will be deleted.`;
  }
  return preview;
}

// ─────────────────────────────────────────────────────────────
// Product deletion
// ─────────────────────────────────────────────────────────────

/** How many variants to list in a delete preview before summarising. */
export const PRODUCT_DELETE_PREVIEW_VARIANTS = 25;

export interface ProductSummary {
  id?: string;
  sku?: string;
  label?: string;
  product_type?: string;
}

export function summarizeProduct(product: PlytixProduct): ProductSummary {
  return {
    id: product.id,
    sku: product.sku,
    label: product.label,
    ...(product.product_type ? { product_type: product.product_type } : {}),
  };
}

/** Preview shown on a product delete dry run. */
export function buildProductDeletePreview(
  product: PlytixProduct,
  variants: PlytixProduct[],
  unlinkVariants: boolean
): Record<string, unknown> {
  const preview: Record<string, unknown> = {
    product: summarizeProduct(product),
    variant_count: variants.length,
  };
  // The parent's own counter is updated separately from the variants listing; when
  // they disagree Plytix is mid-propagation and the preview should say so.
  if (typeof product.num_variations === 'number' && product.num_variations !== variants.length) {
    preview.variant_count_reported_by_parent = product.num_variations;
    preview.note = `The parent reports num_variations=${product.num_variations} but the variants listing returned ${variants.length}; Plytix may still be propagating a recent link/unlink. Re-check before deleting.`;
  }
  if (variants.length > 0) {
    preview.variants = variants.slice(0, PRODUCT_DELETE_PREVIEW_VARIANTS).map(summarizeProduct);
    if (variants.length > PRODUCT_DELETE_PREVIEW_VARIANTS) {
      preview.variants_truncated = variants.length - PRODUCT_DELETE_PREVIEW_VARIANTS;
    }
    preview.warning = unlinkVariants
      ? `The ${variants.length} variants will first be unlinked (they become standalone products and keep their data), then "${product.sku}" will be deleted.`
      : `Deleting "${product.sku}" also deletes its ${variants.length} variants. Pass unlink_variants: true to keep them as standalone products.`;
  } else if (product.product_type === 'VARIANT') {
    preview.warning = `"${product.sku}" is a variant; only this product is deleted, its parent is untouched.`;
  }
  return preview;
}

// ─────────────────────────────────────────────────────────────
// Small utilities
// ─────────────────────────────────────────────────────────────

function duplicates(values: string[]): string[] {
  const seen = new Set<string>();
  const dupes = new Set<string>();
  for (const value of values) {
    if (seen.has(value)) dupes.add(value);
    seen.add(value);
  }
  return [...dupes];
}

function sameList(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((value, i) => value === b[i]);
}
