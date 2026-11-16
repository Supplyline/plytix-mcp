import { describe, expect, it, vi } from 'vitest';
import { changeFamilyLevel } from '../family-levels.js';
import { projectSearch } from '../search-projection.js';
import { catalogReads } from '../catalog-reads.js';
import { toolAnnotations } from '../tool-annotations.js';
import type { CatalogClient } from '../catalog-tools.js';
import type { PlytixResult, PlytixProduct } from '../types.js';

const family = 'a'.repeat(24), attr = 'b'.repeat(24);
const payload = (r: {content: {text: string}[]}) => JSON.parse(r.content[0].text);

describe('family association changes', () => {
  function fixture(initial: string | null) {
    let level = initial;
    const client = {
      getFamilyAttributes: async () => ({data: level ? [{label:'size', id:attr, attribute_level:level}] : []}),
      getAttributeByLabel: async (l: string) => l === 'size' ? {id:attr} : null,
      call: vi.fn(async (path, init) => {
        const body = JSON.parse(init.body);
        level = path.endsWith('/link') ? body.attributes_level : Object.keys(body)[0];
        if (path.endsWith('/link')) expect(body.attributes).toEqual([attr]);
        else expect(body[level!]).toEqual(['attributes.size']);
      }),
    };
    return {client:client as unknown as CatalogClient, write:client.call};
  }
  it.each(['parent_level','variant_level','no_level'] as const)('links and independently observes %s', async target => {
    const {client,write} = fixture(null);
    const outcome = await changeFamilyLevel(client,family,['size'],target,'link');
    expect(payload(outcome)).toMatchObject({outcome:'verified',after:[{attribute_id:attr,level:target}]});
    expect(write).toHaveBeenCalledOnce();
  });
  it('guards before no-op, previews without sending, and edits a direct link', async () => {
    const {client,write} = fixture('parent_level');
    expect(payload(await changeFamilyLevel(client,family,['size'],'parent_level','edit','variant_level')).outcome).toBe('conflict');
    expect(payload(await changeFamilyLevel(client,family,['size'],'variant_level','edit',undefined,true)).outcome).toBe('preview');
    expect(payload(await changeFamilyLevel(client,family,['size'],'parent_level','edit')).outcome).toBe('no_op');
    expect(write).not.toHaveBeenCalled();
    expect(payload(await changeFamilyLevel(client,family,['size'],'variant_level','edit','parent_level')).outcome).toBe('verified');
  });
  it('resolves every attribute before submission', async () => {
    const {client,write} = fixture(null);
    await expect(changeFamilyLevel(client,family,['size','absent'],'no_level','link')).rejects.toThrow('Unknown attribute');
    expect(write).not.toHaveBeenCalled();
  });
});

it('separates search totals, placeholders, absent keys and custom nulls', () => {
  const response = {data:[{id:'x', product_family_id:null, attributes:{weight:null}}],pagination:{count:1,total_count:78404,page:1,page_size:1}};
  const r = projectSearch(response as unknown as PlytixResult<PlytixProduct>, ['product_family_id','attributes.weight','attributes.note']);
  expect(r).toMatchObject({page_rows:1,matching_rows:1,catalog_rows:78404,next_page:null,products:[{
    product_family_id:{state:'indeterminate'},'attributes.weight':{state:'null'},'attributes.note':{state:'missing'},
  }]});
});

it('retains edge direction, quantity and offsets on the same source row', async () => {
  const to = 'c'.repeat(24);
  const tool = catalogReads.find(t => t.definition.name === 'relationships_search_links')!;
  const row = {id:family,relationships:[{relationship_id:attr,relationship_label:'kit',related_products:[
    {product_id:to,quantity:0},{product_id:family},
  ]}]};
  const client = {call: vi.fn(async () => ({data:[row]}))} as unknown as CatalogClient;
  const first = payload(await tool.run({from_product_id:family,page_size:1},client));
  expect(first.links[0]).toMatchObject({from_product_id:family,to_product_id:to,quantity:0});
  const last = payload(await tool.run({from_product_id:family,page_size:1,cursor:first.next},client));
  expect(last.links[0]).not.toHaveProperty('quantity');
  expect(last.next).toBeNull();
});

it('annotates reads, file writes, and preview-capable mutations by effect', () => {
  expect(toolAnnotations('products_batch_export_to_file').readOnlyHint).toBe(false);
  expect(toolAnnotations('families_set_attribute_level').destructiveHint).toBe(true);
  expect(toolAnnotations('attribute_groups_get').readOnlyHint).toBe(true);
});
