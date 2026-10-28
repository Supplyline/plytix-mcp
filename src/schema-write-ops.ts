/**
 * Schema Write Operations — the tool handlers behind attribute definition
 * writes, category-tree writes and product deletion.
 *
 * Each exported function is one MCP tool's behaviour, written once against the
 * method surface both clients share (`SchemaWriteClient`). `src/tools/*.ts`
 * (stdio, Zod schemas) and `src/worker.ts` (Worker, JSON schemas) are thin
 * wrappers around these, so the two surfaces cannot drift, and tests exercise
 * the real flow with a fake client.
 *
 * The three delete tools go through the safety gate in `src/safety.ts`:
 * `dry_run: true` resolves the target and returns a preview plus a
 * `confirm_token`; the execute call must carry that token and the same
 * side-effect options (`unlink_variants`, `move_children_to`) the preview was
 * issued for. If the target changed between the two calls (a variant or child
 * appeared or vanished) the execute call refuses and asks for a fresh dry run.
 */

import type {
  PlytixAttributeDetail,
  PlytixCategory,
  PlytixProduct,
  PlytixResult,
} from './types.js';
import type { PlytixError } from './types.js';
import {
  authorizeDelete,
  getSessionDeleteCount,
  makeDryRunResult,
  recordDelete,
} from './safety.js';
import {
  attributeCreateBody,
  attributeUpdateBody,
  buildCategoryDeletePreview,
  buildProductDeletePreview,
  categoryUpdateBody,
  checkSortChildren,
  summarizeCategory,
  summarizeProduct,
  validateAttributeCreate,
  type AttributeCreateInput,
  type AttributeUpdateInput,
  type CategoryUpdateInput,
} from './schema-writes.js';

export interface ToolResult {
  content: Array<{ type: string; text: string }>;
  isError?: boolean;
}

/** The client methods these operations need; both PlytixClient and WorkerPlytixClient satisfy it. */
export interface SchemaWriteClient {
  getAttributeByLabel(label: string): Promise<PlytixAttributeDetail | null>;
  createAttribute(body: Record<string, unknown>): Promise<PlytixResult<PlytixAttributeDetail>>;
  updateAttribute(
    attributeId: string,
    body: Record<string, unknown>
  ): Promise<PlytixResult<PlytixAttributeDetail>>;
  deleteAttribute(attributeId: string): Promise<boolean>;

  getProduct(productId: string): Promise<PlytixResult<PlytixProduct>>;
  getProductVariants(productId: string): Promise<PlytixResult<PlytixProduct>>;
  unlinkVariant(parentProductId: string, variantProductId: string): Promise<PlytixResult<void>>;
  deleteProduct(productId: string): Promise<boolean>;

  getCategoryById(categoryId: string): Promise<PlytixCategory | null>;
  getCategoryChildren(parentId: string): Promise<PlytixCategory[]>;
  createCategory(data: { name: string; parent_id?: string }): Promise<PlytixResult<PlytixCategory>>;
  updateCategory(categoryId: string, body: Record<string, unknown>): Promise<PlytixResult<PlytixCategory>>;
  sortRootCategories(categoryIds: string[]): Promise<PlytixResult<PlytixCategory>>;
  deleteCategory(categoryId: string): Promise<boolean>;
}

function ok(payload: unknown): ToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }] };
}

function fail(message: string): ToolResult {
  return { content: [{ type: 'text', text: message }], isError: true };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'Unknown error';
}

/**
 * Plytix's 409 on a delete carries a usage report; keep it readable. Duck-typed
 * on `status` rather than `instanceof PlytixError` so it survives a second copy
 * of the types module (bundlers, vitest module resets).
 */
function conflictMessage(what: string, error: unknown): string | null {
  const err = error as Partial<PlytixError> | null;
  if (!err || typeof err !== 'object' || err.status !== 409) return null;
  let detail = typeof err.response === 'string' ? err.response : JSON.stringify(err.response ?? err.message);
  try {
    const parsed = JSON.parse(detail) as { error?: { msg?: string; errors?: unknown } };
    if (parsed.error) detail = JSON.stringify(parsed.error);
  } catch {
    // not JSON; keep the raw text
  }
  return `${what} is still in use, Plytix refused the delete (409). Remove it from the catalogs/channels listed first: ${detail}`;
}

function attributeView(attr: PlytixAttributeDetail): Record<string, unknown> {
  return {
    id: attr.id,
    label: attr.label,
    name: attr.name,
    type_class: attr.type_class,
    ...(attr.options !== undefined ? { options: attr.options } : {}),
    groups: attr.groups ?? [],
    ...(attr.description !== undefined ? { description: attr.description } : {}),
  };
}

// ─────────────────────────────────────────────────────────────
// Attributes
// ─────────────────────────────────────────────────────────────

export async function attributesCreate(
  client: SchemaWriteClient,
  input: AttributeCreateInput
): Promise<ToolResult> {
  const problems = validateAttributeCreate(input);
  if (problems.length > 0) {
    return fail(`Cannot create attribute: ${problems.join('; ')}`);
  }
  try {
    const result = await client.createAttribute(attributeCreateBody(input));
    const created = result.data?.[0];
    if (!created?.id) {
      return fail(`Attribute creation failed: Plytix returned no attribute for "${input.name}"`);
    }
    return ok({
      success: true,
      action: 'created',
      attribute: attributeView(created),
      ...(created.type_class !== input.type_class
        ? {
            note: `Plytix created this as ${created.type_class} (requested ${input.type_class}).`,
          }
        : {}),
    });
  } catch (error) {
    return fail(`Error creating attribute: ${errorMessage(error)}`);
  }
}

export interface AttributesUpdateArgs extends AttributeUpdateInput {
  label: string;
}

export async function attributesUpdate(
  client: SchemaWriteClient,
  input: AttributesUpdateArgs
): Promise<ToolResult> {
  try {
    const current = await client.getAttributeByLabel(input.label);
    if (!current) return fail(`Attribute not found: ${input.label}`);

    const { label: _label, ...edit } = input;
    const prepared = attributeUpdateBody(current, edit);
    if (!prepared.ok) return fail(`Cannot update ${input.label}: ${prepared.reason}`);

    const changes: Record<string, unknown> = {};
    if (prepared.body?.name !== undefined) changes.name = { from: current.name, to: prepared.body.name };
    if (prepared.body?.description !== undefined) {
      changes.description = { from: current.description ?? null, to: prepared.body.description };
    }
    if (prepared.body?.attributes !== undefined) changes.attributes = prepared.body.attributes;
    if (prepared.body?.options !== undefined) {
      changes.options = {
        added: prepared.options.added,
        removed: prepared.options.removed,
        renamed: prepared.options.renamed,
        ...(prepared.options.already_present.length > 0
          ? { already_present: prepared.options.already_present }
          : {}),
        count: { from: current.options?.length ?? 0, to: (prepared.body.options as string[]).length },
      };
    }

    if (prepared.body === undefined) {
      return ok({
        success: true,
        action: 'unchanged',
        attribute: attributeView(current),
        ...(prepared.options.already_present.length > 0
          ? { already_present: prepared.options.already_present }
          : {}),
      });
    }

    const result = await client.updateAttribute(current.id, prepared.body);
    const updated = result.data?.[0] ?? { ...current, ...prepared.body };
    return ok({
      success: true,
      action: 'updated',
      attribute: attributeView(updated as PlytixAttributeDetail),
      changes,
    });
  } catch (error) {
    return fail(`Error updating attribute: ${errorMessage(error)}`);
  }
}

export interface AttributesDeleteArgs {
  label: string;
  dry_run?: boolean;
  confirm_token?: string;
}

const ATTRIBUTES_DELETE = 'attributes_delete';

export async function attributesDelete(
  client: SchemaWriteClient,
  { label, dry_run, confirm_token }: AttributesDeleteArgs
): Promise<ToolResult> {
  try {
    const attr = await client.getAttributeByLabel(label);
    if (!attr) return fail(`Attribute not found: ${label}`);

    const preview: Record<string, unknown> = {
      attribute: attributeView(attr),
      options_count: attr.options?.length ?? 0,
      warning: `Deleting "${label}" removes the attribute definition and every product's value for it. Plytix refuses (409) while an e-catalog, channel or PDF catalog still uses it.`,
    };

    if (dry_run) {
      const issued = makeDryRunResult(ATTRIBUTES_DELETE, label, preview);
      return issued.ok ? ok(issued.result) : fail(issued.reason);
    }

    const auth = authorizeDelete(ATTRIBUTES_DELETE, label, confirm_token);
    if (!auth.ok) return fail(auth.reason);

    let removed: boolean;
    try {
      removed = await client.deleteAttribute(attr.id);
    } catch (error) {
      return fail(conflictMessage(`Attribute "${label}"`, error) ?? `Error deleting attribute: ${errorMessage(error)}`);
    }
    if (!removed) {
      return ok({ success: true, action: 'not_found', label, note: 'Attribute was already gone; nothing deleted.' });
    }
    const count = recordDelete();
    return ok({
      success: true,
      action: 'deleted',
      attribute: attributeView(attr),
      session_deletes_performed: count,
    });
  } catch (error) {
    return fail(`Error deleting attribute: ${errorMessage(error)}`);
  }
}

// ─────────────────────────────────────────────────────────────
// Products
// ─────────────────────────────────────────────────────────────

export interface ProductsDeleteArgs {
  product_id: string;
  dry_run?: boolean;
  confirm_token?: string;
  /** Unlink every variant first so they survive as standalone products. */
  unlink_variants?: boolean;
}

const PRODUCTS_DELETE = 'products_delete';

function idsOf(rows: Array<{ id?: string }>): string[] {
  return rows.map((r) => r.id).filter((id): id is string => !!id).sort();
}

function sameIds(a: unknown, b: string[]): boolean {
  return Array.isArray(a) && a.length === b.length && a.every((id, i) => id === b[i]);
}

export async function productsDelete(
  client: SchemaWriteClient,
  { product_id, dry_run, confirm_token, unlink_variants = false }: ProductsDeleteArgs
): Promise<ToolResult> {
  try {
    const found = await client.getProduct(product_id);
    const product = found.data?.[0];
    if (!product) return fail(`Product not found: ${product_id}`);

    const variants = (await client.getProductVariants(product_id)).data ?? [];
    const preview = {
      ...buildProductDeletePreview(product, variants, unlink_variants),
      unlink_variants,
      variant_ids: idsOf(variants),
    };

    if (dry_run) {
      const issued = makeDryRunResult(PRODUCTS_DELETE, product_id, preview);
      return issued.ok ? ok(issued.result) : fail(issued.reason);
    }

    const auth = authorizeDelete(PRODUCTS_DELETE, product_id, confirm_token);
    if (!auth.ok) return fail(auth.reason);

    if (auth.preview.unlink_variants !== unlink_variants) {
      return fail(
        `The confirm_token was issued for unlink_variants: ${String(auth.preview.unlink_variants)} but this call passed ${String(unlink_variants)}. Re-run with dry_run: true using the options you intend to execute.`
      );
    }
    if (!sameIds(auth.preview.variant_ids, preview.variant_ids)) {
      return fail(
        `The variants of ${product_id} changed since the dry run (${(auth.preview.variant_ids as string[]).length} then, ${preview.variant_ids.length} now). Re-run with dry_run: true to review the current state.`
      );
    }

    const unlinked: string[] = [];
    if (unlink_variants) {
      for (const variant of variants) {
        if (!variant.id) continue;
        await client.unlinkVariant(product_id, variant.id);
        unlinked.push(variant.id);
      }
    }

    const removed = await client.deleteProduct(product_id);
    if (!removed) {
      return ok({
        success: true,
        action: 'not_found',
        product_id,
        ...(unlinked.length > 0 ? { unlinked_variants: unlinked } : {}),
        note: 'Product was already gone; nothing deleted.',
      });
    }
    const count = recordDelete();
    return ok({
      success: true,
      action: 'deleted',
      product: summarizeProduct(product),
      ...(unlink_variants
        ? { unlinked_variants: unlinked, note: 'Variants were unlinked first and remain as standalone products.' }
        : variants.length > 0
          ? { deleted_variants: idsOf(variants) }
          : {}),
      session_deletes_performed: count,
    });
  } catch (error) {
    return fail(`Error deleting product: ${errorMessage(error)}`);
  }
}

// ─────────────────────────────────────────────────────────────
// Categories
// ─────────────────────────────────────────────────────────────

export interface CategoriesCreateArgs {
  name: string;
  parent_id?: string;
}

export async function categoriesCreate(
  client: SchemaWriteClient,
  { name, parent_id }: CategoriesCreateArgs
): Promise<ToolResult> {
  if (!name.trim()) return fail('Cannot create category: name cannot be empty');
  try {
    const result = await client.createCategory({
      name: name.trim(),
      ...(parent_id ? { parent_id } : {}),
    });
    const created = result.data?.[0];
    if (!created?.id) return fail(`Category creation failed: Plytix returned no category for "${name}"`);
    return ok({
      success: true,
      action: 'created',
      category: summarizeCategory(created),
      ...(parent_id ? { parent_id } : { level: 'root' }),
    });
  } catch (error) {
    return fail(`Error creating category: ${errorMessage(error)}`);
  }
}

export interface CategoriesUpdateArgs extends CategoryUpdateInput {
  category_id: string;
}

export async function categoriesUpdate(
  client: SchemaWriteClient,
  { category_id, ...edit }: CategoriesUpdateArgs
): Promise<ToolResult> {
  const prepared = categoryUpdateBody(edit);
  if (!prepared.ok) return fail(`Cannot update category: ${prepared.reason}`);
  try {
    const current = await client.getCategoryById(category_id);
    if (!current) return fail(`Category not found: ${category_id}`);

    if (edit.parent_id) {
      if (edit.parent_id === category_id) return fail('Cannot move a category under itself.');
      const target = await client.getCategoryById(edit.parent_id);
      if (!target) return fail(`New parent category not found: ${edit.parent_id}`);
      if (target.parents_ids?.includes(category_id)) {
        return fail(`Cannot move "${current.name}" under "${target.name}": it is inside the subtree being moved.`);
      }
    }
    if (edit.sort_children) {
      const children = await client.getCategoryChildren(category_id);
      const check = checkSortChildren(edit.sort_children, children);
      if (!check.ok) return fail(`Cannot sort children of "${current.name}": ${check.reason}`);
    }

    const result = await client.updateCategory(category_id, prepared.body);
    const updated = result.data?.[0] ?? current;
    const actions: string[] = [];
    if (edit.name !== undefined) actions.push('renamed');
    if (edit.parent_id !== undefined) actions.push(edit.parent_id === '' ? 'moved_to_root' : 'moved');
    if (edit.sort_children !== undefined) actions.push('children_sorted');
    return ok({
      success: true,
      action: actions.join('+'),
      category: summarizeCategory(updated),
      ...(edit.parent_id !== undefined ? { parent_id: edit.parent_id === '' ? null : edit.parent_id } : {}),
    });
  } catch (error) {
    return fail(`Error updating category: ${errorMessage(error)}`);
  }
}

export interface CategoriesSortRootArgs {
  category_ids: string[];
}

export async function categoriesSortRoot(
  client: SchemaWriteClient,
  { category_ids }: CategoriesSortRootArgs
): Promise<ToolResult> {
  try {
    const roots = await client.getCategoryChildren('');
    const check = checkSortChildren(category_ids, roots);
    if (!check.ok) return fail(`Cannot sort root categories: ${check.reason}`);
    await client.sortRootCategories(category_ids);
    return ok({ success: true, action: 'root_sorted', order: category_ids });
  } catch (error) {
    return fail(`Error sorting root categories: ${errorMessage(error)}`);
  }
}

export interface CategoriesDeleteArgs {
  category_id: string;
  dry_run?: boolean;
  confirm_token?: string;
  /** Move direct children here first (a category id, or "" for root) so only this node is deleted. */
  move_children_to?: string;
}

const CATEGORIES_DELETE = 'categories_delete';

export async function categoriesDelete(
  client: SchemaWriteClient,
  { category_id, dry_run, confirm_token, move_children_to }: CategoriesDeleteArgs
): Promise<ToolResult> {
  try {
    const category = await client.getCategoryById(category_id);
    if (!category) return fail(`Category not found: ${category_id}`);

    if (move_children_to !== undefined && move_children_to !== '') {
      if (move_children_to === category_id) return fail('move_children_to cannot be the category being deleted.');
      const target = await client.getCategoryById(move_children_to);
      if (!target) return fail(`move_children_to category not found: ${move_children_to}`);
      if (target.parents_ids?.includes(category_id)) {
        return fail(`move_children_to "${target.name}" is inside "${category.name}" and would be deleted with it.`);
      }
    }

    const children = await client.getCategoryChildren(category_id);
    const preview = {
      ...buildCategoryDeletePreview(category, children, move_children_to),
      move_children_to: move_children_to ?? null,
      child_ids: idsOf(children),
    };

    if (dry_run) {
      const issued = makeDryRunResult(CATEGORIES_DELETE, category_id, preview);
      return issued.ok ? ok(issued.result) : fail(issued.reason);
    }

    const auth = authorizeDelete(CATEGORIES_DELETE, category_id, confirm_token);
    if (!auth.ok) return fail(auth.reason);

    if ((auth.preview.move_children_to ?? null) !== (move_children_to ?? null)) {
      return fail(
        `The confirm_token was issued for move_children_to: ${JSON.stringify(auth.preview.move_children_to)} but this call passed ${JSON.stringify(move_children_to ?? null)}. Re-run with dry_run: true using the options you intend to execute.`
      );
    }
    if (!sameIds(auth.preview.child_ids, preview.child_ids)) {
      return fail(
        `The children of ${category_id} changed since the dry run. Re-run with dry_run: true to review the current state.`
      );
    }

    const moved: string[] = [];
    if (move_children_to !== undefined) {
      for (const child of children) {
        if (!child.id) continue;
        await client.updateCategory(child.id, { parent_id: move_children_to });
        moved.push(child.id);
      }
    }

    let removed: boolean;
    try {
      removed = await client.deleteCategory(category_id);
    } catch (error) {
      const conflict = conflictMessage(`Category "${category.name}"`, error);
      if (conflict) {
        return fail(moved.length > 0 ? `${conflict} (its ${moved.length} children were already moved)` : conflict);
      }
      throw error;
    }
    if (!removed) {
      return ok({
        success: true,
        action: 'not_found',
        category_id,
        ...(moved.length > 0 ? { moved_children: moved } : {}),
        note: 'Category was already gone; nothing deleted.',
      });
    }
    const count = recordDelete();
    return ok({
      success: true,
      action: 'deleted',
      category: summarizeCategory(category),
      ...(move_children_to !== undefined
        ? { moved_children: moved, moved_to: move_children_to === '' ? 'root' : move_children_to }
        : children.length > 0
          ? { deleted_subtree_roots: idsOf(children) }
          : {}),
      session_deletes_performed: count,
    });
  } catch (error) {
    return fail(`Error deleting category: ${errorMessage(error)}`);
  }
}

export { getSessionDeleteCount };
