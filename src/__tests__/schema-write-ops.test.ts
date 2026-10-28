import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PlytixAttributeDetail, PlytixCategory, PlytixProduct } from '../types.js';
import { PlytixError } from '../types.js';

type Ops = typeof import('../schema-write-ops.js');
type Client = import('../schema-write-ops.js').SchemaWriteClient;

/**
 * Fresh module graph per test so the safety gate's pending-token map and
 * session delete counter start empty (safety.ts holds them at module level).
 */
async function loadOps(): Promise<Ops> {
  vi.resetModules();
  return import('../schema-write-ops.js');
}

const originalMax = process.env.PLYTIX_MCP_MAX_DELETES;
beforeEach(() => {
  delete process.env.PLYTIX_MCP_MAX_DELETES;
});
afterEach(() => {
  if (originalMax === undefined) delete process.env.PLYTIX_MCP_MAX_DELETES;
  else process.env.PLYTIX_MCP_MAX_DELETES = originalMax;
});

const colour: PlytixAttributeDetail = {
  id: 'attr-colour',
  label: 'colour',
  name: 'Colour',
  type_class: 'DropdownAttribute',
  options: ['Red', 'Blue'],
  groups: [],
};

const parent: PlytixProduct = { id: 'p-1', sku: 'PARENT', label: 'Parent', product_type: 'PARENT' };
const variants: PlytixProduct[] = [
  { id: 'v-1', sku: 'V1', product_type: 'VARIANT' },
  { id: 'v-2', sku: 'V2', product_type: 'VARIANT' },
];

const pumps: PlytixCategory = { id: 'cat-pumps', name: 'Pumps', path: ['Pumps'], n_children: 2, parents_ids: [] };
const pumpChildren: PlytixCategory[] = [
  { id: 'cat-gear', name: 'Gear', path: ['Pumps', 'Gear'], n_children: 0, parents_ids: ['cat-pumps'] },
  { id: 'cat-vane', name: 'Vane', path: ['Pumps', 'Vane'], n_children: 0, parents_ids: ['cat-pumps'] },
];
const tools: PlytixCategory = { id: 'cat-tools', name: 'Tools', path: ['Tools'], n_children: 0, parents_ids: [] };

/** A fake client with vi.fn methods; override any method per test. */
function fakeClient(overrides: Partial<Client> = {}): Client & Record<keyof Client, ReturnType<typeof vi.fn>> {
  const attrs = new Map<string, PlytixAttributeDetail>([[colour.label, colour]]);
  const cats = new Map<string, PlytixCategory>([
    [pumps.id!, pumps],
    [tools.id!, tools],
    ...pumpChildren.map((c) => [c.id!, c] as [string, PlytixCategory]),
  ]);
  const base = {
    getAttributeByLabel: vi.fn(async (label: string) => attrs.get(label) ?? null),
    createAttribute: vi.fn(async (body: Record<string, unknown>) => ({
      data: [{ id: 'attr-new', label: 'in_stock', name: body.name as string, type_class: body.type_class as string, groups: [] }],
    })),
    updateAttribute: vi.fn(async (_id: string, body: Record<string, unknown>) => ({ data: [{ ...colour, ...body }] })),
    deleteAttribute: vi.fn(async () => true),

    getProduct: vi.fn(async (id: string) => ({ data: id === parent.id ? [parent] : [] })),
    getProductVariants: vi.fn(async () => ({ data: variants })),
    unlinkVariant: vi.fn(async () => ({ data: [] })),
    deleteProduct: vi.fn(async () => true),

    getCategoryById: vi.fn(async (id: string) => cats.get(id) ?? null),
    getCategoryChildren: vi.fn(async (parentId: string) =>
      parentId === pumps.id ? pumpChildren : parentId === '' ? [pumps, tools] : []
    ),
    createCategory: vi.fn(async (data: { name: string; parent_id?: string }) => ({
      data: [{ id: 'cat-new', name: data.name, path: data.parent_id ? ['Pumps', data.name] : [data.name], n_children: 0 }],
    })),
    updateCategory: vi.fn(async (id: string, body: Record<string, unknown>) => ({ data: [{ ...cats.get(id)!, ...body }] })),
    sortRootCategories: vi.fn(async () => ({ data: [] })),
    deleteCategory: vi.fn(async () => true),
  };
  return { ...base, ...overrides } as Client & Record<keyof Client, ReturnType<typeof vi.fn>>;
}

function payload(result: { content: Array<{ text: string }>; isError?: boolean }): Record<string, unknown> {
  return JSON.parse(result.content[0]!.text) as Record<string, unknown>;
}

// ─────────────────────────────────────────────────────────────
// Attributes
// ─────────────────────────────────────────────────────────────

describe('attributesCreate', () => {
  it('validates before calling Plytix', async () => {
    const ops = await loadOps();
    const client = fakeClient();
    const result = await ops.attributesCreate(client, { name: 'x', type_class: 'TextAttribute', options: ['a'] });
    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toContain('options applies only to');
    expect(client.createAttribute).not.toHaveBeenCalled();
  });

  it('posts the body and returns the created attribute', async () => {
    const ops = await loadOps();
    const client = fakeClient();
    const result = await ops.attributesCreate(client, {
      name: 'In Stock',
      type_class: 'BooleanAttribute',
      description: 'd',
      product_families: [{ id: 'fam-1' }],
    });
    expect(client.createAttribute).toHaveBeenCalledWith({
      name: 'In Stock',
      type_class: 'BooleanAttribute',
      description: 'd',
      product_families: [{ id: 'fam-1', attribute_level: 'no_level' }],
    });
    expect(payload(result)).toMatchObject({ success: true, action: 'created', attribute: { id: 'attr-new', label: 'in_stock' } });
  });

  it('notes when Plytix substitutes the type', async () => {
    const ops = await loadOps();
    const client = fakeClient({
      createAttribute: vi.fn(async () => ({ data: [{ id: 'a', label: 'l', name: 'n', type_class: 'TextAttribute' }] })),
    });
    const result = await ops.attributesCreate(client, { name: 'n', type_class: 'HtmlAttribute' });
    expect(payload(result).note).toContain('created this as TextAttribute');
  });
});

describe('attributesUpdate', () => {
  it('adds options incrementally against the current list', async () => {
    const ops = await loadOps();
    const client = fakeClient();
    const result = await ops.attributesUpdate(client, { label: 'colour', add_options: ['Green'], description: 'Main colour' });
    expect(client.updateAttribute).toHaveBeenCalledWith('attr-colour', {
      description: 'Main colour',
      options: ['Red', 'Blue', 'Green'],
    });
    expect(payload(result)).toMatchObject({
      action: 'updated',
      changes: { options: { added: ['Green'], count: { from: 2, to: 3 } }, description: { from: null, to: 'Main colour' } },
    });
  });

  it('renames an option and keeps the full list in the body', async () => {
    const ops = await loadOps();
    const client = fakeClient();
    await ops.attributesUpdate(client, { label: 'colour', renamed_options: { Blue: 'Navy' } });
    expect(client.updateAttribute).toHaveBeenCalledWith('attr-colour', {
      options: ['Red', 'Navy'],
      renamed_options: { Blue: 'Navy' },
    });
  });

  it('reports unchanged without a PATCH when every added option already exists', async () => {
    const ops = await loadOps();
    const client = fakeClient();
    const result = await ops.attributesUpdate(client, { label: 'colour', add_options: ['Red'] });
    expect(client.updateAttribute).not.toHaveBeenCalled();
    expect(payload(result)).toMatchObject({ action: 'unchanged', already_present: ['Red'] });
  });

  it('fails cleanly on an unknown label or an invalid edit', async () => {
    const ops = await loadOps();
    const client = fakeClient();
    expect((await ops.attributesUpdate(client, { label: 'nope', name: 'x' })).isError).toBe(true);
    const bad = await ops.attributesUpdate(client, { label: 'colour', renamed_options: { Red: 'Blue' } });
    expect(bad.isError).toBe(true);
    expect(bad.content[0]!.text).toContain('already an option');
    expect(client.updateAttribute).not.toHaveBeenCalled();
  });
});

describe('attributesDelete', () => {
  it('requires a dry run first, then deletes with the token', async () => {
    const ops = await loadOps();
    const client = fakeClient();

    const noToken = await ops.attributesDelete(client, { label: 'colour' });
    expect(noToken.isError).toBe(true);
    expect(noToken.content[0]!.text).toContain('dry_run:true');

    const dry = payload(await ops.attributesDelete(client, { label: 'colour', dry_run: true }));
    expect(dry.dry_run).toBe(true);
    expect(dry.would_delete).toMatchObject({ attribute: { label: 'colour' }, options_count: 2 });
    expect(client.deleteAttribute).not.toHaveBeenCalled();

    const done = payload(await ops.attributesDelete(client, { label: 'colour', confirm_token: dry.confirm_token as string }));
    expect(done).toMatchObject({ action: 'deleted', session_deletes_performed: 1 });
    expect(client.deleteAttribute).toHaveBeenCalledWith('attr-colour');
  });

  it('does not issue a token for an unknown attribute', async () => {
    const ops = await loadOps();
    const result = await ops.attributesDelete(fakeClient(), { label: 'nope', dry_run: true });
    expect(result.isError).toBe(true);
  });

  it('surfaces a 409 usage report and does not spend the budget', async () => {
    const ops = await loadOps();
    const body = JSON.stringify({ error: { msg: 'in use', errors: [{ field: 'usages', msg: { ecatalogs: [{ id: 'e1', name: 'Europe' }] } }] } });
    const client = fakeClient({
      deleteAttribute: vi.fn(async () => {
        throw new PlytixError(`Request failed: 409 - ${body}`, 409, body);
      }),
    });
    const dry = payload(await ops.attributesDelete(client, { label: 'colour', dry_run: true }));
    const result = await ops.attributesDelete(client, { label: 'colour', confirm_token: dry.confirm_token as string });
    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toContain('still in use');
    expect(result.content[0]!.text).toContain('Europe');
    expect(ops.getSessionDeleteCount()).toBe(0);
  });

  it('reports not_found without spending the budget when the attribute is already gone', async () => {
    const ops = await loadOps();
    const client = fakeClient({ deleteAttribute: vi.fn(async () => false) });
    const dry = payload(await ops.attributesDelete(client, { label: 'colour', dry_run: true }));
    const result = payload(await ops.attributesDelete(client, { label: 'colour', confirm_token: dry.confirm_token as string }));
    expect(result.action).toBe('not_found');
    expect(ops.getSessionDeleteCount()).toBe(0);
  });
});

// ─────────────────────────────────────────────────────────────
// Products
// ─────────────────────────────────────────────────────────────

describe('productsDelete', () => {
  it('previews the variants and warns they would be deleted', async () => {
    const ops = await loadOps();
    const dry = payload(await ops.productsDelete(fakeClient(), { product_id: 'p-1', dry_run: true }));
    expect(dry.would_delete).toMatchObject({
      product: { sku: 'PARENT' },
      variant_count: 2,
      unlink_variants: false,
      variant_ids: ['v-1', 'v-2'],
    });
    expect((dry.would_delete as { warning: string }).warning).toContain('also deletes its 2 variants');
  });

  it('deletes the parent (and so its variants) once confirmed', async () => {
    const ops = await loadOps();
    const client = fakeClient();
    const dry = payload(await ops.productsDelete(client, { product_id: 'p-1', dry_run: true }));
    const done = payload(await ops.productsDelete(client, { product_id: 'p-1', confirm_token: dry.confirm_token as string }));
    expect(done).toMatchObject({ action: 'deleted', deleted_variants: ['v-1', 'v-2'], session_deletes_performed: 1 });
    expect(client.unlinkVariant).not.toHaveBeenCalled();
    expect(client.deleteProduct).toHaveBeenCalledWith('p-1');
  });

  it('unlinks every variant before deleting when asked', async () => {
    const ops = await loadOps();
    const client = fakeClient();
    const order: string[] = [];
    client.unlinkVariant.mockImplementation(async (_p: string, v: string) => {
      order.push(`unlink:${v}`);
      return { data: [] };
    });
    client.deleteProduct.mockImplementation(async () => {
      order.push('delete');
      return true;
    });

    const dry = payload(await ops.productsDelete(client, { product_id: 'p-1', dry_run: true, unlink_variants: true }));
    expect((dry.would_delete as { warning: string }).warning).toContain('unlinked');
    const done = payload(
      await ops.productsDelete(client, { product_id: 'p-1', confirm_token: dry.confirm_token as string, unlink_variants: true })
    );
    expect(order).toEqual(['unlink:v-1', 'unlink:v-2', 'delete']);
    expect(done).toMatchObject({ action: 'deleted', unlinked_variants: ['v-1', 'v-2'] });
  });

  it('refuses to execute with different unlink_variants than the preview', async () => {
    const ops = await loadOps();
    const client = fakeClient();
    const dry = payload(await ops.productsDelete(client, { product_id: 'p-1', dry_run: true, unlink_variants: true }));
    const result = await ops.productsDelete(client, { product_id: 'p-1', confirm_token: dry.confirm_token as string });
    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toContain('unlink_variants: true');
    expect(client.deleteProduct).not.toHaveBeenCalled();
    // The token was consumed; a retry needs a fresh dry run.
    const retry = await ops.productsDelete(client, { product_id: 'p-1', confirm_token: dry.confirm_token as string, unlink_variants: true });
    expect(retry.content[0]!.text).toMatch(/already-used/);
  });

  it('refuses when the variants changed since the dry run', async () => {
    const ops = await loadOps();
    const client = fakeClient();
    const dry = payload(await ops.productsDelete(client, { product_id: 'p-1', dry_run: true }));
    client.getProductVariants.mockResolvedValue({ data: [...variants, { id: 'v-3', sku: 'V3' }] });
    const result = await ops.productsDelete(client, { product_id: 'p-1', confirm_token: dry.confirm_token as string });
    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toContain('changed since the dry run');
    expect(client.deleteProduct).not.toHaveBeenCalled();
  });

  it('is an error for an unknown product and never mints a token', async () => {
    const ops = await loadOps();
    const result = await ops.productsDelete(fakeClient(), { product_id: 'ghost', dry_run: true });
    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toContain('Product not found');
  });

  it('honours the session cap', async () => {
    process.env.PLYTIX_MCP_MAX_DELETES = '0';
    const ops = await loadOps();
    const result = await ops.productsDelete(fakeClient(), { product_id: 'p-1', dry_run: true });
    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toContain('disabled');
  });
});

// ─────────────────────────────────────────────────────────────
// Categories
// ─────────────────────────────────────────────────────────────

describe('categoriesCreate / categoriesUpdate / categoriesSortRoot', () => {
  it('creates a root category and a subcategory', async () => {
    const ops = await loadOps();
    const client = fakeClient();
    const root = payload(await ops.categoriesCreate(client, { name: 'Valves' }));
    expect(root).toMatchObject({ action: 'created', level: 'root', category: { id: 'cat-new', name: 'Valves' } });
    expect(client.createCategory).toHaveBeenLastCalledWith({ name: 'Valves' });

    const sub = payload(await ops.categoriesCreate(client, { name: 'Ball', parent_id: 'cat-pumps' }));
    expect(sub).toMatchObject({ action: 'created', parent_id: 'cat-pumps' });
    expect(client.createCategory).toHaveBeenLastCalledWith({ name: 'Ball', parent_id: 'cat-pumps' });
  });

  it('renames and moves, and refuses moving into its own subtree', async () => {
    const ops = await loadOps();
    const client = fakeClient();
    const renamed = payload(await ops.categoriesUpdate(client, { category_id: 'cat-pumps', name: 'Pumps & Compressors' }));
    expect(renamed.action).toBe('renamed');
    expect(client.updateCategory).toHaveBeenLastCalledWith('cat-pumps', { name: 'Pumps & Compressors' });

    const moved = payload(await ops.categoriesUpdate(client, { category_id: 'cat-gear', parent_id: 'cat-tools' }));
    expect(moved).toMatchObject({ action: 'moved', parent_id: 'cat-tools' });

    const toRoot = payload(await ops.categoriesUpdate(client, { category_id: 'cat-gear', parent_id: '' }));
    expect(toRoot).toMatchObject({ action: 'moved_to_root', parent_id: null });
    expect(client.updateCategory).toHaveBeenLastCalledWith('cat-gear', { parent_id: '' });

    const cycle = await ops.categoriesUpdate(client, { category_id: 'cat-pumps', parent_id: 'cat-gear' });
    expect(cycle.isError).toBe(true);
    expect(cycle.content[0]!.text).toContain('inside the subtree');

    const self = await ops.categoriesUpdate(client, { category_id: 'cat-pumps', parent_id: 'cat-pumps' });
    expect(self.isError).toBe(true);
  });

  it('sorts children only with a complete list', async () => {
    const ops = await loadOps();
    const client = fakeClient();
    const partial = await ops.categoriesUpdate(client, { category_id: 'cat-pumps', sort_children: ['cat-vane'] });
    expect(partial.isError).toBe(true);
    expect(partial.content[0]!.text).toContain('missing current children: cat-gear');

    const sorted = payload(await ops.categoriesUpdate(client, { category_id: 'cat-pumps', sort_children: ['cat-vane', 'cat-gear'] }));
    expect(sorted.action).toBe('children_sorted');
    expect(client.updateCategory).toHaveBeenLastCalledWith('cat-pumps', { sort_children: ['cat-vane', 'cat-gear'] });
  });

  it('refuses parent_id with sort_children before touching the client', async () => {
    const ops = await loadOps();
    const client = fakeClient();
    const result = await ops.categoriesUpdate(client, { category_id: 'cat-pumps', parent_id: '', sort_children: ['a'] });
    expect(result.isError).toBe(true);
    expect(client.getCategoryById).not.toHaveBeenCalled();
  });

  it('sorts the root level against the actual roots', async () => {
    const ops = await loadOps();
    const client = fakeClient();
    const bad = await ops.categoriesSortRoot(client, { category_ids: ['cat-tools'] });
    expect(bad.isError).toBe(true);
    const good = payload(await ops.categoriesSortRoot(client, { category_ids: ['cat-tools', 'cat-pumps'] }));
    expect(good.action).toBe('root_sorted');
    expect(client.sortRootCategories).toHaveBeenCalledWith(['cat-tools', 'cat-pumps']);
  });
});

describe('categoriesDelete', () => {
  it('previews the subtree and deletes it once confirmed', async () => {
    const ops = await loadOps();
    const client = fakeClient();
    const dry = payload(await ops.categoriesDelete(client, { category_id: 'cat-pumps', dry_run: true }));
    expect(dry.would_delete).toMatchObject({
      category: { name: 'Pumps' },
      child_ids: ['cat-gear', 'cat-vane'],
      move_children_to: null,
    });
    expect((dry.would_delete as { warning: string }).warning).toContain('entire subtree');

    const done = payload(await ops.categoriesDelete(client, { category_id: 'cat-pumps', confirm_token: dry.confirm_token as string }));
    expect(done).toMatchObject({ action: 'deleted', deleted_subtree_roots: ['cat-gear', 'cat-vane'] });
    expect(client.updateCategory).not.toHaveBeenCalled();
    expect(client.deleteCategory).toHaveBeenCalledWith('cat-pumps');
  });

  it('moves the direct children out first when move_children_to is given', async () => {
    const ops = await loadOps();
    const client = fakeClient();
    const order: string[] = [];
    client.updateCategory.mockImplementation(async (id: string, body: Record<string, unknown>) => {
      order.push(`move:${id}->${String(body.parent_id)}`);
      return { data: [] };
    });
    client.deleteCategory.mockImplementation(async () => {
      order.push('delete');
      return true;
    });

    const dry = payload(await ops.categoriesDelete(client, { category_id: 'cat-pumps', dry_run: true, move_children_to: '' }));
    expect((dry.would_delete as { warning: string }).warning).toContain('moved under the root level');
    const done = payload(
      await ops.categoriesDelete(client, { category_id: 'cat-pumps', confirm_token: dry.confirm_token as string, move_children_to: '' })
    );
    expect(order).toEqual(['move:cat-gear->', 'move:cat-vane->', 'delete']);
    expect(done).toMatchObject({ action: 'deleted', moved_children: ['cat-gear', 'cat-vane'], moved_to: 'root' });
  });

  it('refuses a move target inside the subtree, or the category itself', async () => {
    const ops = await loadOps();
    const client = fakeClient();
    const inside = await ops.categoriesDelete(client, { category_id: 'cat-pumps', dry_run: true, move_children_to: 'cat-gear' });
    expect(inside.isError).toBe(true);
    expect(inside.content[0]!.text).toContain('would be deleted with it');
    const self = await ops.categoriesDelete(client, { category_id: 'cat-pumps', dry_run: true, move_children_to: 'cat-pumps' });
    expect(self.isError).toBe(true);
    const missing = await ops.categoriesDelete(client, { category_id: 'cat-pumps', dry_run: true, move_children_to: 'ghost' });
    expect(missing.isError).toBe(true);
  });

  it('refuses to execute with a different move_children_to than the preview', async () => {
    const ops = await loadOps();
    const client = fakeClient();
    const dry = payload(await ops.categoriesDelete(client, { category_id: 'cat-pumps', dry_run: true, move_children_to: 'cat-tools' }));
    const result = await ops.categoriesDelete(client, { category_id: 'cat-pumps', confirm_token: dry.confirm_token as string });
    expect(result.isError).toBe(true);
    expect(client.deleteCategory).not.toHaveBeenCalled();
    expect(client.updateCategory).not.toHaveBeenCalled();
  });

  it('refuses when the children changed since the dry run', async () => {
    const ops = await loadOps();
    const client = fakeClient();
    const dry = payload(await ops.categoriesDelete(client, { category_id: 'cat-pumps', dry_run: true }));
    client.getCategoryChildren.mockResolvedValue([pumpChildren[0]!]);
    const result = await ops.categoriesDelete(client, { category_id: 'cat-pumps', confirm_token: dry.confirm_token as string });
    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toContain('changed since the dry run');
  });

  it('reports a 409 e-catalog conflict and mentions children already moved', async () => {
    const ops = await loadOps();
    const body = JSON.stringify({ error: { msg: 'category used as root in e-catalog' } });
    const client = fakeClient({
      deleteCategory: vi.fn(async () => {
        throw new PlytixError(`Request failed: 409 - ${body}`, 409, body);
      }),
    });
    const dry = payload(await ops.categoriesDelete(client, { category_id: 'cat-pumps', dry_run: true, move_children_to: '' }));
    const result = await ops.categoriesDelete(client, { category_id: 'cat-pumps', confirm_token: dry.confirm_token as string, move_children_to: '' });
    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toContain('still in use');
    expect(result.content[0]!.text).toContain('2 children were already moved');
    expect(ops.getSessionDeleteCount()).toBe(0);
  });
});
