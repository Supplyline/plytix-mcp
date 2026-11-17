import { describe, expect, it, vi } from 'vitest';
import { adminTools } from '../catalog-admin.js';
import { detailTools } from '../catalog-detail.js';
import { catalogReads } from '../catalog-reads.js';
import type { CatalogClient } from '../catalog-tools.js';
import { createProductWithLinks } from '../product-create.js';
import { PlytixError } from '../types.js';

const id = 'a'.repeat(24),
  target = 'b'.repeat(24);
function fixture(call: ReturnType<typeof vi.fn>) {
  return { call } as unknown as CatalogClient;
}
function tool(name: string) {
  return [...adminTools, ...detailTools, ...catalogReads].find((t) => t.definition.name === name)!;
}
const payload = (r: { content: { text: string }[] }) => JSON.parse(r.content[0].text);

describe('staff catalog operations', () => {
  it('requires exactly one upload source, a filename for encoded content, and strict fields', async () => {
    const c = fixture(vi.fn());
    for (const args of [
      { url: 'https://example.com/a', content: 'YQ==' },
      { content: 'YQ==' },
      { filename: 'x' },
      { filename: 'a', content: '???' },
      { url: 'https://example.com/a', alt_text: 'ignored' },
    ]) {
      expect((await tool('assets_create').run(args, c)).isError).toBe(true);
    }
    expect(c.call).not.toHaveBeenCalled();
  });
  it('creates one file and verifies it using a fresh GET', async () => {
    const call = vi
      .fn()
      .mockResolvedValueOnce({ data: [{ id }] })
      .mockResolvedValueOnce({ data: [{ id, filename: 'test.pdf', file_size: 1 }] });
    const r = await tool('assets_create').run({ filename: 'test.pdf', content: 'YQ==' }, fixture(call));
    expect(payload(r)).toMatchObject({ id, outcome: 'verified' });
    expect(call.mock.calls[1][0]).toBe('/api/v1/assets/' + id);
  });
  it('reports an ambiguous create without resubmitting', async () => {
    const call = vi.fn().mockRejectedValue(new PlytixError('Timeout'));
    const r = await tool('assets_create').run({ url: 'https://example.com/a.pdf' }, fixture(call));
    expect(r.isError).toBe(true);
    expect(payload(r).outcome).toBe('unverified');
    expect(call).toHaveBeenCalledOnce();
  });
  it('detects a rename silently ignored upstream', async () => {
    const c = fixture(
      vi
        .fn()
        .mockResolvedValueOnce({ data: [] })
        .mockResolvedValueOnce({ data: [{ id, name: 'old' }] }),
    );
    expect(payload(await tool('families_update').run({ id, name: 'new' }, c)).outcome).toBe(
      'unverified',
    );
  });
  it('binds deletion to the observed membership and requires fresh absence evidence', async () => {
    let labels = ['a'],
      deleted = false;
    const call = vi.fn(async (_path, init) => {
      if (init?.method === 'DELETE') {
        deleted = true;
        return { data: [] };
      }
      if (deleted) throw new PlytixError('Not found', 404);
      return { data: [{ id, name: 'group', attribute_labels: labels }] };
    });
    const del = tool('attribute_groups_delete'),
      c = fixture(call);
    const preview = async () => payload(await del.run({ id, dry_run: true }, c)).confirm_token;
    const token = await preview();
    expect(token).toBeTruthy();
    labels = ['b'];
    expect(payload(await del.run({ id, confirm_token: token }, c)).outcome).toBe('conflict');
    expect(deleted).toBe(false);
    expect(payload(await del.run({ id, confirm_token: await preview() }, c)).outcome).toBe(
      'verified_absent',
    );
  });
  it('refuses cascading deletion when usage is present or unknown', async () => {
    for (const usage of [1, undefined]) {
      const c = fixture(vi.fn().mockResolvedValue({ data: [{ id, total_products: usage }] }));
      expect(payload(await tool('families_delete').run({ id, dry_run: true }, c)).outcome).toBe(
        'refused',
      );
      expect(c.call).toHaveBeenCalledTimes(1);
    }
  });
  it('bounds global edge search to one definition and one source per call', async () => {
    const call = vi
      .fn()
      .mockResolvedValueOnce({ data: [{ id }], pagination: { count: 2 } })
      .mockResolvedValueOnce({ data: [], pagination: { count: 0 } });
    const c = {
      call,
      getRelationship: vi.fn().mockResolvedValue({ data: [{ id, label: 'kit' }] }),
    } as unknown as CatalogClient;
    const r = await tool('relationships_search_links').run({ to_product_id: target }, c);
    expect(payload(r)).toEqual({ links: [], next: { type_page: 2, source_page: 1, offset: 0 } });
    expect(call).toHaveBeenCalledTimes(2);
  });
  it('verifies the canonical product, SKU and thumbnail on product creation', async () => {
    const client = {
      createProduct: vi.fn().mockResolvedValue({ data: [{ id }] }),
      getProduct: vi.fn().mockResolvedValue({ data: [{ id, sku: 'A', thumbnail: { id: target } }] }),
    };
    const r = await createProductWithLinks(client, {
      sku: 'A',
      thumbnail_id: target,
      asset_ids: [target],
    });
    expect(payload(r)).toMatchObject({ success: true, id, thumbnail_id: target });
    expect(client.createProduct).toHaveBeenCalledExactlyOnceWith({
      sku: 'A',
      thumbnail: { id: target },
      assets: [{ id: target }],
    });
    expect(client.getProduct).toHaveBeenCalledExactlyOnceWith(id);
  });
  it('reconciles a delayed group reorder using reads only and sends no membership array', async () => {
    const call = vi
      .fn()
      .mockResolvedValueOnce({ data: [] })
      .mockResolvedValueOnce({ data: [{ id, order: 0 }] })
      .mockResolvedValueOnce({ data: [{ id, order: 2 }] });
    const r = await tool('attribute_groups_update').run({ id, order: 2 }, fixture(call));
    expect(payload(r).outcome).toBe('verified');
    expect(call.mock.calls[0]).toEqual([
      '/api/v1/attribute-groups/product/' + id,
      { method: 'PATCH', body: '{"order":2}' },
    ]);
    expect(call.mock.calls.slice(1)).toEqual([
      ['/api/v1/attribute-groups/product/' + id],
      ['/api/v1/attribute-groups/product/' + id],
    ]);
  });
  it('checks child placement through a read of the requested category', async () => {
    const call = vi
      .fn()
      .mockResolvedValueOnce({ data: [{ id }] })
      .mockResolvedValueOnce({ data: [{ id, name: 'Leaf', parents_ids: [target] }] });
    const r = await tool('asset_categories_create').run(
      { name: 'Leaf', parent_id: target },
      fixture(call),
    );
    expect(payload(r).outcome).toBe('verified');
    expect(call.mock.calls[0][0]).toBe('/api/v1/categories/file/' + target);
    expect(JSON.parse(call.mock.calls[1][1].body).filters[0][0].value).toBe(id);
  });
  it('refuses to delete an empty DAM category if the usage count is missing', async () => {
    const call = vi
      .fn()
      .mockResolvedValueOnce({ data: [{ id, n_children: 0 }] })
      .mockResolvedValueOnce({ data: [], pagination: {} });
    const r = await tool('asset_categories_delete').run({ id, dry_run: true }, fixture(call));
    expect(payload(r).outcome).toBe('refused');
    expect(call.mock.calls.map(([path]) => path)).toEqual([
      '/api/v1/categories/file/search',
      '/api/v1/assets/search',
    ]);
  });
  it('returns a rejected create without retrying or reading', async () => {
    const call = vi.fn().mockRejectedValue(new PlytixError('Duplicate relationship type', 409));
    const r = await tool('relationship_types_create').run({ name: 'Parent' }, fixture(call));
    expect(r.isError).toBe(true);
    expect(payload(r).error).toContain('Duplicate');
    expect(call).toHaveBeenCalledOnce();
  });
  it('rejects a SKU that changed after the search', async () => {
    const call = vi
      .fn()
      .mockResolvedValueOnce({ data: [{ id, sku: 'A' }] })
      .mockResolvedValueOnce({ data: [{ id, sku: 'B' }] });
    expect((await tool('products_get_by_sku').run({ sku: 'A' }, fixture(call))).isError).toBe(true);
  });
});
