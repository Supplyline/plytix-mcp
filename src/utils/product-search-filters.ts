/** Shared products_search input contract; batch/export keeps its own validation. */
export const PRODUCT_SEARCH_FILTERS_DESCRIPTION =
  'Search filters: outer groups are OR, conditions within each group are AND. ' +
  'Use [[{field, operator, value}]], or one JSON-encoded condition array per group ' +
  'when the client requires strings. Do not encode the entire outer array as one group.';

function nonblankText(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function encodedConditionShape(value: unknown): boolean {
  if (Array.isArray(value)) {
    return (value.length === 2 || value.length === 3)
      && nonblankText(value[0]) && nonblankText(value[1]);
  }
  if (!value || typeof value !== 'object') return false;
  const { field, operator } = value as Record<string, unknown>;
  return (nonblankText(field)
    || (Array.isArray(field) && field.length > 0 && field.every(nonblankText)))
    && nonblankText(operator);
}

/**
 * Decode a host's string group once, then apply the existing tuple shorthand.
 * Never flatten groups, decode values, mutate the input, or drop a bad predicate.
 * Encoded group structure is checked locally; operators/values remain API-owned.
 * Native inputs retain their existing pass-through semantics, including empty groups.
 */
export function normalizeProductSearchFilters(filters: unknown[]): unknown[] {
  return filters.map((input, index) => {
    let group = input;
    if (typeof group === 'string') {
      const invalid = () => new Error(`filters[${index}] must encode a nonempty condition array`);
      try {
        group = JSON.parse(group);
      } catch {
        throw invalid();
      }
      if (!Array.isArray(group) || group.length === 0 || !group.every(encodedConditionShape)) {
        throw invalid();
      }
    }
    return Array.isArray(group)
      ? group.map((item) =>
          Array.isArray(item) && item.length >= 2 && typeof item[0] === 'string'
            ? { field: item[0], operator: item[1], value: item[2] }
            : item
        )
      : group;
  });
}
