import { z } from 'zod';
import { catalogTool, objectId, page, pageSize, post, result } from './catalog-tools.js';
import { familyLevel } from './family-levels.js';
import type { PlytixAttributeDetail, PlytixFamily, PlytixProduct } from './types.js';
import { projectProductGet, validateProductGetAttributeLabels } from './utils/product-get-projection.js';

export const detailTools = [
  catalogTool(
    'products_get_by_sku',
    'Fetch one product by exact SKU, with optional local custom field projection.',
    { sku: z.string().min(1), attribute_labels: z.array(z.string()).max(50).optional() },
    async (a, c) => {
      const labels = validateProductGetAttributeLabels(a.attribute_labels);
      const found = await c.call<PlytixProduct>(
        '/api/v2/products/search',
        post({
          filters: [[{ field: 'sku', operator: 'eq', value: a.sku }]],
          attributes: ['sku'],
          pagination: { page: 1, page_size: 2 },
        }),
      );
      if (found.data.length !== 1 || found.data[0].sku !== a.sku)
        throw new Error('No unique exact SKU match');
      const id = objectId.parse(found.data[0].id);
      const row = (await c.call<PlytixProduct>('/api/v2/products/' + id)).data[0];
      if (!row || row.id !== id || row.sku !== a.sku)
        throw new Error('SKU identity changed before readback');
      return result(projectProductGet(row, labels));
    },
  ),
  catalogTool(
    'attributes_get_by_id',
    'Get a custom attribute definition by canonical ID.',
    { id: objectId },
    async (a, c) => result(await c.call('/api/v1/attributes/product/' + a.id)),
  ),
  catalogTool(
    'attributes_search',
    'Page through custom attribute definitions. Use attributes_list for system metadata.',
    { label: z.string().min(1).optional(), page, page_size: pageSize },
    async (a, c) =>
      result(
        await c.call<PlytixAttributeDetail>(
          '/api/v1/attributes/product/search',
          post({
            filters: a.label ? [[{ field: 'label', operator: 'eq', value: a.label }]] : [],
            attributes: ['name', 'label', 'type_class', 'description', 'options', 'groups'],
            pagination: { page: a.page, page_size: a.page_size },
          }),
        ),
      ),
  ),
  catalogTool(
    'families_search_attributes',
    'Search direct family associations by family, level or label. Pass next as cursor, including after an empty page.',
    {
      family_id: objectId.optional(),
      attribute_label: z.string().min(1).optional(),
      level: familyLevel.optional(),
      page_size: pageSize,
      cursor: z.object({ family_page: page, offset: z.number().int().nonnegative() }).optional(),
    },
    async (a, c) => {
      const familyPage = a.cursor?.family_page ?? 1,
        offset = a.cursor?.offset ?? 0;
      const roster = a.family_id
        ? undefined
        : await c.call<PlytixFamily>(
            '/api/v1/product_families/search',
            post({ filters: [], pagination: { page: familyPage, page_size: 1 } }),
          );
      const id = a.family_id ?? roster?.data[0]?.id;
      if (!id) return result({ associations: [], next: null });
      const rows = (await c.getFamilyAttributes(id)).data.filter(
        (row) =>
          (!a.attribute_label || a.attribute_label === row.label) &&
          (!a.level || a.level === row.attribute_level),
      );
      const associations = rows
        .slice(offset, offset + a.page_size)
        .map((row) => ({
          family_id: id,
          attribute_id: row.id,
          label: row.label,
          level: row.attribute_level,
        }));
      const next =
        offset + a.page_size < rows.length
          ? { family_page: familyPage, offset: offset + a.page_size }
          : roster && familyPage < (roster.pagination?.count ?? Infinity)
            ? { family_page: familyPage + 1, offset: 0 }
            : null;
      return result({ associations, next });
    },
  ),
];
