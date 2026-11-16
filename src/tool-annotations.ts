// Explicitly allowlist reads. Unknown tools receive conservative write hints.
const reads = new Set([
  'products_lookup', 'products_get', 'products_get_full', 'products_search', 'products_find',
  'products_batch_export', 'products_bulk_status', 'products_filters', 'families_list',
  'families_get', 'families_list_attributes', 'families_list_all_attributes', 'attributes_list',
  'attributes_get', 'attributes_get_options', 'attributes_filters', 'assets_filters', 'assets_get',
  'assets_search', 'assets_list', 'categories_search', 'categories_list', 'variants_list',
  'relationships_get', 'relationships_search', 'relationships_filters', 'families_get_attribute_level',
  'relationships_get_link', 'relationships_search_links', 'attribute_groups_search', 'attribute_groups_get',
]);
const local = new Set(['identifier_detect', 'identifier_normalize', 'match_score']);

export function toolAnnotations(name: string) {
  const readOnlyHint = reads.has(name) || local.has(name);
  return {
    readOnlyHint, openWorldHint: !local.has(name),
    ...(readOnlyHint ? {idempotentHint: true} : {destructiveHint: !name.endsWith('_create')}),
  };
}
