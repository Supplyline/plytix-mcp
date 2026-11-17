# Official beta operation coverage

Community release 0.7.0, compared with the authenticated Plytix MCP Gateway inventory on November 16, 2026. The gateway returned 75 tool names and an empty server version. Both community transports implement the mappings below with API-key credentials. The official beta uses its own authorization.

**Implemented** means the community workflow covers the named operation. **Partial** means the stated subset works and a caller-visible difference remains. **Open** means the operation has no equivalent community workflow. These are implementation classifications. The release checks exercised authenticated reads and synthetic mutations. Production write equivalence and full-catalog reconciliation require separate evidence.

Of the 75 operations, **18 are implemented, 35 are partial and 22 are open**. The count includes capabilities from earlier community releases.

| Official operation | Status | Community tools | Behavior and remaining scope |
|---|---|---|---|
| `get-products` | Partial | `products_get`, `products_get_by_sku`, `products_get_full` | ID and exact SKU. Selected custom attributes and specific related objects are available. Arbitrary relation expansion and field projection differ. |
| `search-products` | Partial | `products_search` | V2 filters, pagination and optional projected response. A projected null can be indeterminate. The native catalog total can differ from the match count. |
| `create-products` | Partial | `products_create`, `products_assign_family`, `variants_link` | Creates SKU, label, status, custom attributes and optional thumbnail by asset ID. GTIN, parent and family are outside the single create contract. |
| `update-products` | Partial | `products_update`, `products_set_attribute`, `products_assign_family`, `variants_link` | Label, status, named custom fields and separate family/variant operations. No general path update, SKU rename, GTIN or thumbnail field on this tool. |
| `delete-products` | Implemented | `products_delete` | Exact ID with variant preview and confirmation. Resolve an exact SKU to canonical ID first when needed. |
| `unset-products-field` | Open | — | The gateway removes label, GTIN, a custom key or last_context. products_clear_attribute assigns null to a custom attribute. Absent-key semantics are unproven. |
| `get-product-categories` | Partial | `categories_get` | Exact ID search returns the node, including path and parent IDs. Fixed field projection. |
| `search-product-categories` | Partial | `categories_search` | Paged name search. The gateway also supports its field, sort and filter grammar. |
| `create-product-categories` | Partial | `categories_create` | Creates a root or child. Setting a single position at creation is unavailable. |
| `update-product-categories` | Partial | `categories_update`, `categories_sort_root` | Rename, move or sort by explicit sibling IDs. A scalar position with concurrent sibling edits has different semantics. |
| `delete-product-categories` | Implemented | `categories_delete` | Exact node, subtree preview and confirmed deletion. Children can also be moved out first. |
| `get-product-categorizations` | Partial | `categories_get_membership` | Exact product and category membership. The V1 response describes the category and omits its per-product position. |
| `link-product-categorizations` | Partial | `categories_link` | Links by ID. Setting per-product order is unavailable. |
| `unlink-product-categorizations` | Implemented | `categories_unlink` | Unlinks the specified product and category IDs. |
| `update-product-categorizations` | Open | — | V1/V2 document link and unlink. A per-product membership position needs an upstream mutation and independent order readback. |
| `get-product-lists` | Open | — | No corresponding operation in the public V1/V2 endpoint index. Use the official beta for saved static and smart lists. |
| `search-product-lists` | Open | — | No corresponding operation in the public V1/V2 endpoint index. Use the official beta for saved static and smart lists. |
| `create-product-lists` | Open | — | No corresponding operation in the public V1/V2 endpoint index. Use the official beta for saved static and smart lists. |
| `update-product-lists` | Open | — | No corresponding operation in the public V1/V2 endpoint index. Use the official beta for saved static and smart lists. |
| `delete-product-lists` | Open | — | No corresponding operation in the public V1/V2 endpoint index. Use the official beta for saved static and smart lists. |
| `get-asset-lists` | Open | — | No corresponding operation in the public V1/V2 endpoint index. Use the official beta for saved static and smart lists. |
| `search-asset-lists` | Open | — | No corresponding operation in the public V1/V2 endpoint index. Use the official beta for saved static and smart lists. |
| `create-asset-lists` | Open | — | No corresponding operation in the public V1/V2 endpoint index. Use the official beta for saved static and smart lists. |
| `update-asset-lists` | Open | — | No corresponding operation in the public V1/V2 endpoint index. Use the official beta for saved static and smart lists. |
| `delete-asset-lists` | Open | — | No corresponding operation in the public V1/V2 endpoint index. Use the official beta for saved static and smart lists. |
| `link-products-static-lists` | Open | — | No public V1/V2 static-list membership route. The official gateway accepts resource and list identity. |
| `unlink-products-static-lists` | Open | — | No public V1/V2 static-list membership route. The official gateway accepts resource and list identity. |
| `link-assets-static-lists` | Open | — | No public V1/V2 static-list membership route. The official gateway accepts resource and list identity. |
| `unlink-assets-static-lists` | Open | — | No public V1/V2 static-list membership route. The official gateway accepts resource and list identity. |
| `get-product-attribute-definitions` | Partial | `attributes_get_by_id`, `attributes_get` | Exact custom definition ID or attribute label. No gateway field expansion contract. |
| `search-product-attribute-definitions` | Partial | `attributes_search`, `attributes_list` | Page custom definitions and filter by exact label. System metadata is available separately. Fixed search projection. |
| `create-product-attribute-definitions` | Partial | `attributes_create` | Type, name, description, options, sorting and completeness tracking. V1 derives labels. Explicit labels, formula text, date-time, text limits and restrictions lack equivalent contracts. |
| `update-product-attribute-definitions` | Partial | `attributes_update` | Name, description, option changes and completeness tracking. The full set of type-specific beta controls, including formula text, is open. |
| `delete-product-attribute-definitions` | Implemented | `attributes_get_by_id`, `attributes_delete` | Resolve the current label by ID and preview/delete that label. Upstream surfaces usage conflicts. |
| `unset-product-attribute-definitions-field` | Open | — | The gateway can remove description. Setting an empty string does not prove removal. |
| `get-product-attribute-groups` | Partial | `attribute_groups_get` | Reads by ID and returns member labels. Gateway field selection and related definition expansion differ. |
| `search-product-attribute-groups` | Partial | `attribute_groups_search` | Name query and pages. No generic sort or expansion. |
| `create-product-attribute-groups` | Implemented | `attribute_groups_create` | Name and optional zero-based order, independently checked after creation. |
| `update-product-attribute-groups` | Implemented | `attribute_groups_update` | Change name or zero-based order without writing member labels. Returns the actual position if the API clamps it. |
| `delete-product-attribute-groups` | Implemented | `attribute_groups_delete` | Single-use confirmation captures group identity and observed labels. Definitions survive group removal. |
| `link-product-attribute-definitions-groups` | Open | — | V1 replaces the full label roster. Safe single-member editing needs an atomic association or conditional replacement. Use the official beta for this operation. |
| `unlink-product-attribute-definitions-groups` | Open | — | V1 replaces the full label roster. Safe single-member editing needs an atomic association or conditional replacement. Use the official beta for this operation. |
| `get-product-families` | Partial | `families_get` | Exact family metadata. Arbitrary field and relation expansion remain open. |
| `search-product-families` | Partial | `families_list` | Paged name query. No generic gateway sort, filters or expansion. |
| `create-product-families` | Implemented | `families_create` | Creates a named family. The canonical ID is returned. |
| `update-product-families` | Implemented | `families_update` | Rename by exact family ID and read back the name. |
| `delete-product-families` | Partial | `families_delete` | Only a reported zero-product family can be confirmed. Unknown or nonzero product counts block this tool. |
| `get-family-attributes` | Partial | `attributes_get_by_id`, `families_get_attribute_level` | Resolve definition ID to label and read direct membership and level. Gateway field selection differs. |
| `search-family-attributes` | Partial | `families_search_attributes` | One family roster per call. Filter by family, exact label and level. Pass the cursor even after an empty page. No global sort or expansion. |
| `create-family-attributes` | Implemented | `attributes_get_by_id`, `families_link_attribute` | Resolve ID to label, specify no_level, parent_level or variant_level and verify direct membership. |
| `update-family-attributes` | Implemented | `attributes_get_by_id`, `families_set_attribute_level` | Resolve ID to label, set direct level with optional expected-state guard and verify it. |
| `delete-family-attributes` | Implemented | `attributes_get_by_id`, `families_unlink_attribute` | Resolve ID to label and unlink the direct association. Read its current state with families_get_attribute_level. |
| `get-product-relationship-types` | Partial | `relationships_get` | Exact definition with name and label. No generic gateway projection. |
| `search-product-relationship-types` | Partial | `relationships_search` | Name filter and pagination. No general gateway filter and sort grammar. |
| `create-product-relationship-types` | Implemented | `relationship_types_create` | Creates the named definition and verifies its canonical ID and name. |
| `update-product-relationship-types` | Implemented | `relationship_types_update` | Renames the display name by ID and reads it back. |
| `delete-product-relationship-types` | Partial | `relationship_types_delete` | Requires zero observed source products using the type. V1 can reject use by channels, catalogs or PDF templates. |
| `search-product-relationships` | Partial | `relationships_search_links` | Source, destination, type and unfiltered traversal. Bounded definition/source cursor, nonnegative quantity predicate for indexed reverse lookups. Gateway sorting, full-catalog census and pagination equivalence remain open. |
| `get-product-relationship` | Implemented | `relationships_get_link` | Exact directed triple and stored quantity. |
| `link-product-relationship` | Implemented | `relationships_link_product` | Creates a directed edge for the specified type and optional nonnegative quantity. |
| `update-product-relationship` | Implemented | `relationships_set_quantity` | Updates the quantity of the specified directed triple. |
| `unlink-product-relationship` | Implemented | `relationships_unlink_product` | Removes exactly the supplied directed triple. |
| `get-assets` | Partial | `assets_get` | Read by ID. Gateway-selectable fields and related-resource expansion differ. |
| `search-assets` | Partial | `assets_search` | Uses V1 DAM filters and pagination. Search shapes and selectable fields differ. |
| `create-assets` | Partial | `assets_create` | Create from URL or base64 with filename, then read the canonical asset. Encoded input cap is 4 MiB. No write contract for alt text. |
| `update-assets` | Partial | `assets_update` | V1 supports filename and category roster. The gateway also writes alt text. |
| `delete-assets` | Partial | `assets_delete` | Requires zero reported products and catalogs before the token is issued. Unknown or positive counts block deletion. |
| `unset-assets-field` | Open | — | The gateway removes alt_text. V1 documents filename and categories as writable fields. |
| `get-asset-categories` | Partial | `asset_categories_get` | Exact ID, path, parent IDs, tree order and child count. Fixed field projection. |
| `search-asset-categories` | Partial | `asset_categories_search` | Paged native name query. No generic sort, projection or gateway filter expression. |
| `create-asset-categories` | Partial | `asset_categories_create` | Creates root or child, then verifies name and parent. No single-node position on create. |
| `update-asset-categories` | Partial | `asset_categories_update` | Rename or move, including to root. Single-node order editing remains open. |
| `delete-asset-categories` | Partial | `asset_categories_delete` | Requires zero child categories and zero assets in the category. Preview and execute both recheck usage. |
| `link-assets-categories` | Open | — | V1 documents a category array on assets_update. Safe single-category edits require proven member-level or conditional write semantics. |
| `unlink-assets-categories` | Open | — | V1 documents a category array on assets_update. Safe single-category edits require proven member-level or conditional write semantics. |

## Reproducing the checks

1. Use an enabled beta account for official discovery. Compare the advertised tool names and input fields with the [official capabilities](https://docs.plytix.com/mcp/tools/) and the [change order](../plans/010-official-beta-capability-parity.md).
2. Build the community server and run both typechecks and `npm run test:all`. For the Worker, run Wrangler locally and point `node -r dotenv/config test-worker.js` at its URL. Discover tools on both transports. The expected inventories are 88 and 83 respectively. The five local exceptions are listed in the [Worker contract](features/worker-parity/SPEC.md).
3. Use equivalent read-only inputs through each transport. Release checks compared a known SKU, attribute ID and exact-label search, DAM category search and ID read, direct family association page and first page of unfiltered directed edges. Compare identity, values and continuation. Additional relationship testing covered a known triple and reverse lookup.
4. Use synthetic write fixtures for readback lag, canonical identity, rejection, timeout, dependency changes and confirmed absence. To qualify live writes, use a disposable authorized catalog and retain the before, submission, after and teardown results. Inspect intermediate empty pages until the cursor becomes null. A mutable index can change during traversal.

## Dependencies for open work

The public V1/V2 endpoint index supplies the native route baseline. The official gateway advertises product lists, asset lists and static membership, but the public reference lists no equivalent endpoints for community API-key credentials. Verification needs a supported route, its credential model, and a disposable smart/static-list fixture. [Public API reference](https://docs.plytix.com/reference/v1-v2/api-v1-v2-reference/)

Single-member edits must preserve concurrent edits by other clients. V1 accepts whole arrays for attribute-group labels and asset categories. Vendor documentation of an atomic member operation or conditional write and an interleaved fixture would close this gap. [Group updates](https://docs.plytix.com/reference/v1-v2/product-attribute-groups/update-product-attribute-group/) · [Asset updates](https://docs.plytix.com/reference/v1-v2/assets/update-asset/)

Per-product category order needs a write and read for the individual membership position. Field removal needs an observable missing-key read. Advanced definition fields, asset alt text and system product writes need an upstream field contract and independent readback. Until then the corresponding official operations remain available to beta-authorized users. [Product category membership](https://docs.plytix.com/reference/v1-v2/products/get-product-category/) · [Definition updates](https://docs.plytix.com/reference/v1-v2/product-attributes/update-product-attribute/)
