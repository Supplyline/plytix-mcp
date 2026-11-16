import type { PlytixProduct, PlytixResult } from './types.js';

export function projectSearch(response: PlytixResult<PlytixProduct>, fields: string[]) {
  const selected = [...new Set(['id', 'sku', ...fields])];
  const products = response.data.map(row => Object.fromEntries(selected.map(field => {
    const custom = field.startsWith('attributes.');
    const source = custom ? row.attributes : row;
    const key = custom ? field.slice('attributes.'.length) : field;
    if (!source || !Object.prototype.hasOwnProperty.call(source, key)) return [field, {state: 'missing'}];
    const value = source[key];
    // Native null placeholders can survive projection. Only assert null for custom fields.
    return [field, {state: value === null ? (custom ? 'null' : 'indeterminate') : 'present', value}];
  })));
  const p = response.pagination;
  const more = p && (p.count == null ? products.length === p.page_size : p.page * p.page_size < p.count);
  return {products, requested_fields: fields, page_rows: products.length, matching_rows: p?.count ?? null,
    catalog_rows: p?.total_count ?? null, next_page: more ? p.page + 1 : null};
}
