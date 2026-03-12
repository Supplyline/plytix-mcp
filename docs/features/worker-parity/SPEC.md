# SPEC — Worker MCP Parity

> **Status:** Draft

## Summary

The Cloudflare Worker MCP server (`worker.ts`) is missing 7 tools and several client methods that exist in the stdio MCP server. It also skips attribute validation on write tools. This feature brings full parity so the remote server (used from Claude mobile, Craft Agents, etc.) has identical capabilities to the local stdio server.

## Gap Inventory

### Missing Tools (7)

| # | Tool | Category | Stdio Source | Complexity |
|---|------|----------|-------------|------------|
| 1 | `products_create` | Write | `tools/products.ts` | Medium — maps SKU + optional fields |
| 2 | `products_update` | Write | `tools/products.ts` | Low — PATCH with partial fields |
| 3 | `products_assign_family` | Write | `tools/products.ts` | Low — single API call, danger warning |
| 4 | `attributes_get` | Read | `tools/attributes.ts` | Medium — needs attribute cache in worker |
| 5 | `attributes_get_options` | Read | `tools/attributes.ts` | Medium — depends on `attributes_get` |
| 6 | `categories_link` | Write | `tools/categories.ts` | Low — POST one category |
| 7 | `categories_unlink` | Write | `tools/categories.ts` | Low — DELETE one category |

### NOT porting (intentional)

| Tool | Reason |
|------|--------|
| `identifier_detect` | Pure utility — no API call, `products_lookup` already uses it internally. Low value as standalone remote tool. |
| `identifier_normalize` | Same — stateless string transform. |
| `match_score` | Same — stateless scoring. Agents can use `products_lookup` instead. |

### Behavioral Gaps (2)

| Tool | Gap | Fix |
|------|-----|-----|
| `products_set_attribute` | Worker skips attribute existence check + dropdown/multiselect validation | Add attribute cache + `validateAttributeValue()` to worker |
| `products_clear_attribute` | Worker skips attribute existence check | Add attribute existence check |

### Missing WorkerPlytixClient Methods (4)

| Method | Used By | API |
|--------|---------|-----|
| `createProduct(data)` | `products_create` | `POST /api/v2/products` |
| `assignProductFamily(productId, familyId)` | `products_assign_family` | `PUT /api/v2/products/:id/family` |
| `linkProductCategory(productId, categoryId)` | `categories_link` | `POST /api/v2/products/:id/categories` |
| `unlinkProductCategory(productId, categoryId)` | `categories_unlink` | `DELETE /api/v2/products/:id/categories/:catId` |

Attribute cache methods (for validation):

| Method | Used By | API |
|--------|---------|-----|
| `searchAttributeIds(pageSize)` | Cache builder | `POST /api/v1/attributes/product/search` |
| `getAttributeById(attrId)` | Cache builder | `GET /api/v1/attributes/product/:id` |
| `getAttributeByLabel(label)` | `set_attribute`, `clear_attribute`, `attributes_get` | Via cache |
| `getAttributeOptions(label)` | `attributes_get_options` | Via `getAttributeByLabel` |

## Behavior

### Happy Path

1. Add 4 missing client methods to `WorkerPlytixClient`
2. Add attribute cache (same pattern as `PlytixClient.buildAttributeCache()`)
3. Add 7 tool definitions to `TOOLS` array
4. Add 7 tool handlers to `toolHandlers` object
5. Add validation to `products_set_attribute` and `products_clear_attribute` handlers
6. Build, test, deploy

### Edge Cases

| Scenario | Expected Behavior |
|----------|------------------|
| `products_create` with duplicate SKU | Plytix returns 409 → surface error |
| `products_assign_family` on variant | Plytix returns error → surface error |
| `products_assign_family` with empty string | Unassigns family (intentional) |
| `products_update` with no fields | Return error "No fields provided" |
| Attribute cache in request-scoped worker | Cache lives on client instance, rebuilt per request. No cross-request caching (stateless worker). |
| `set_attribute` with invalid enum value | Reject before API call, list allowed values |
| `attributes_get` for non-existent label | Return `isError: true` with message |

## Data Model

No new entities. Uses existing Plytix API contracts.

### Attribute Cache (in-memory, per-request)

```
WorkerPlytixClient
├── attributeCache?: Map<string, PlytixAttributeDetail>
├── buildAttributeCache(): Promise<Map<...>>    # paginate searchAttributeIds → getAttributeById
├── getAttributeByLabel(label): Promise<...>    # lazy-build cache, lookup by label
└── getAttributeOptions(label): Promise<...>    # delegates to getAttributeByLabel
```

**Note:** Unlike stdio client's 5-min TTL cache, the worker cache is per-request (no persistence between requests). This is fine — attribute metadata rarely changes mid-request.

## API Changes

No new endpoints. Worker `/mcp` endpoint gains 7 additional tools in `tools/list` response.

### New Tool Schemas

**`products_create`**
```json
{
  "required": ["sku"],
  "properties": {
    "sku": { "type": "string" },
    "label": { "type": "string" },
    "status": { "type": "string" },
    "attributes": { "type": "object" },
    "category_ids": { "type": "array", "items": { "type": "string" } },
    "asset_ids": { "type": "array", "items": { "type": "string" } }
  }
}
```

**`products_update`**
```json
{
  "required": ["product_id"],
  "properties": {
    "product_id": { "type": "string" },
    "label": { "type": "string" },
    "status": { "type": "string" },
    "attributes": { "type": "object" }
  }
}
```

**`products_assign_family`**
```json
{
  "required": ["product_id", "family_id"],
  "properties": {
    "product_id": { "type": "string" },
    "family_id": { "type": "string" }
  }
}
```

**`attributes_get`**
```json
{
  "required": ["label"],
  "properties": {
    "label": { "type": "string" }
  }
}
```

**`attributes_get_options`**
```json
{
  "required": ["label"],
  "properties": {
    "label": { "type": "string" }
  }
}
```

**`categories_link`**
```json
{
  "required": ["product_id", "category_id"],
  "properties": {
    "product_id": { "type": "string" },
    "category_id": { "type": "string" }
  }
}
```

**`categories_unlink`**
```json
{
  "required": ["product_id", "category_id"],
  "properties": {
    "product_id": { "type": "string" },
    "category_id": { "type": "string" }
  }
}
```

## Invariants

1. Every tool in stdio (except `identifier_detect`, `identifier_normalize`, `match_score`) must have an equivalent in the worker
2. Tool schemas must be identical between stdio and worker
3. Write tool validation behavior must match (attribute existence + enum checks)
4. Worker tool handlers must surface Plytix API errors, never swallow them
5. No secrets or credentials stored — BYOK model preserved

## Implementation Sequence

1. [ ] `WorkerPlytixClient` — add `createProduct`, `assignProductFamily`, `linkProductCategory`, `unlinkProductCategory`
2. [ ] `WorkerPlytixClient` — add attribute cache (`searchAttributeIds`, `getAttributeById`, `getAttributeByLabel`, `getAttributeOptions`)
3. [ ] `worker.ts` — add tool defs + handlers for `categories_link`, `categories_unlink` (simple, no new deps)
4. [ ] `worker.ts` — add tool defs + handlers for `products_create`, `products_update`, `products_assign_family`
5. [ ] `worker.ts` — add tool defs + handlers for `attributes_get`, `attributes_get_options`
6. [ ] `worker.ts` — add attribute validation to `products_set_attribute` and `products_clear_attribute`
7. [ ] Extract `validateAttributeValue()` to shared util (used by both stdio + worker)
8. [ ] Build + typecheck
9. [ ] Test with `npm run test:mcp` and manual curl against local wrangler
10. [ ] Deploy

## Rollback Plan

Worker deploys are instant-rollback via `wrangler rollback`. If new tools break existing ones, roll back to previous version.

## Open Questions

- [ ] Should worker attribute cache paginate all attributes upfront, or do single-attribute lookups on demand? Upfront is simpler (matches stdio) but costs N+1 API calls on first use. On-demand is cheaper but more code.
- [ ] Worth extracting shared tool handler logic (stdio + worker produce identical JSON responses) into shared functions? Would reduce duplication but adds a shared dependency between two different runtimes.

## Assumptions

- Attribute metadata changes infrequently (safe to cache per-request)
- `identifier_*` and `match_score` tools are low-value for remote use (agents use `products_lookup` instead)
- Worker handler logic can be copy-adapted from stdio without shared abstraction (pragmatic duplication > premature abstraction)

---

*Author: Claude | Created: 2026-03-03 | Last Updated: 2026-03-03*
