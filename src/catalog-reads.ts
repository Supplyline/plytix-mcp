import { z } from 'zod';
import { catalogTool, objectId, page, pageSize, post, result, type CatalogClient } from './catalog-tools.js';
import type { PlytixProduct } from './types.js';

const edgeFilters = {from_product_id: objectId.optional(), to_product_id: objectId.optional(), relationship_type_id: objectId.optional()};
type EdgeFilters = {from_product_id?: string; to_product_id?: string; relationship_type_id?: string};

async function links(client: CatalogClient, args: EdgeFilters, sourcePage: number, offset: number, limit: number) {
  if (!args.from_product_id && !args.relationship_type_id) throw new Error('Supply a source product or relationship type for indexed search.');
  const definition = args.relationship_type_id ? (await client.getRelationship(args.relationship_type_id)).data[0] : undefined;
  if (args.relationship_type_id && !definition) throw new Error('Unknown relationship type');
  const response = await client.call<PlytixProduct>('/api/v1/products/search', post({
    filters: args.from_product_id ? [[{field: 'id', operator: 'eq', value: args.from_product_id}]] : [],
    ...(definition && !args.from_product_id ? {relationship_filters: [[{relationship_id: definition.id, operator: 'exists',
      ...(args.to_product_id ? {product_ids: [{id: args.to_product_id, qty_operator: 'gte', value: [0]}]} : {})}]]} : {}),
    attributes: ['relationships'], pagination: {page: sourcePage, page_size: 1},
  }));
  const source = response.data[0];
  const entries = (source?.relationships ?? []).filter(rel => !definition || rel.relationship_id === definition.id)
    .flatMap(rel => (rel.related_products ?? []).filter(row => !args.to_product_id || row.product_id === args.to_product_id)
      .map(row => ({from_product_id: source.id, to_product_id: row.product_id, relationship_type_id: rel.relationship_id,
        api_label: rel.relationship_label, display_name: definition?.name, quantity: row.quantity})));
  const nextSource = !args.from_product_id && source && sourcePage < (response.pagination?.count ?? Infinity);
  return {links: entries.slice(offset, offset + limit), next: offset + limit < entries.length
    ? {source_page: sourcePage, offset: offset + limit} : nextSource ? {source_page: sourcePage + 1, offset: 0} : null};
}

export const catalogReads = [
  catalogTool('relationships_search_links', 'Page through directed edges. Supply a source or type ID. Add destination ID to reverse-search within a type. Pass next as cursor.',
    {...edgeFilters, page_size: pageSize, cursor: z.object({source_page: page, offset: z.number().int().nonnegative()}).optional()},
    async (a,c) => result(await links(c,a,a.cursor?.source_page ?? 1,a.cursor?.offset ?? 0,a.page_size))),
  catalogTool('relationships_get_link', 'Read one exact directed link by its three IDs.',
    {from_product_id: objectId, to_product_id: objectId, relationship_type_id: objectId},
    async (a,c) => result({link: (await links(c,a,1,0,1)).links[0] ?? null})),
  catalogTool('attribute_groups_get', 'Get one product attribute group with its member labels.', {group_id: objectId},
    async (a,c) => result(await c.call('/api/v1/attribute-groups/product/' + a.group_id))),
  catalogTool('attribute_groups_search', 'Search product attribute groups by name.', {query: z.string().optional(), page, page_size: pageSize},
    async (a,c) => result(await c.call('/api/v1/attribute-groups/product/search',post({
      filters: a.query ? [[{field:'name', operator:'like', value:a.query}]] : [], pagination: {page:a.page,page_size:a.page_size},
    })))),
];
