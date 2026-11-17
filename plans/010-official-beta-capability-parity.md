# Change order 010 — Community MCP parity with the official Plytix beta

**Status** · Release 1 landed in [#52](https://github.com/Supplyline/plytix-mcp/pull/52). Release 2 implements the available API-backed scope in 0.7.0. The [75-operation coverage record](../docs/official-beta-parity.md) tracks open parity and live-write verification.

**Requested outcome** · Let community MCP users perform the catalog operations exposed by the November 2026 official beta, starting with the operations that previously required custom REST code.  
**Baseline** · November 16, 2026. Community 0.5.0 at `68b7d34190fa3bf1e114f96a7aa202a15880bd07`, verified against remote main.  
**Delivery** · Two independently reviewable releases. The first addresses known workflow problems. The second closes the remaining catalog-operation and field-level gaps. This document requests engineering work. Production catalog changes and deployment are separate decisions.

## Decision requested

Approve Release 1 for implementation and Release 2 for API feasibility and sequencing. Give family inheritance the first implementation slot and directed relationship search the first discovery slot. The two can proceed independently. Estimate the remaining write work after confirming what a community API credential can do. The largest uncertainty is API access and semantics, especially relationship enumeration, single-member edits, list filters and media writes.

**Parity means a caller can accomplish the same catalog task with equivalent scope, observable results and supported fields.** One community tool can cover several official operations. Existing community tool names, identifier lookup, guarded batches, manifests, receipts, bulk-job settlement and variant resync continue to be supported. Matching the official count or spelling does not establish parity.

## Baseline and evidence

| Surface | Evidence available at drafting |
|---|---|
| Official hosted beta | Authenticated discovery returned 75 tools from `Plytix MCP Gateway`. The server supplied an empty version string. The release baseline is therefore the dated inventory. Twenty-five tools advertised read-only behavior. |
| Community | Authenticated stdio discovery returned 61 tools. The repository documents 56 Worker tools and five intentional local-only tools. The Worker count is a repository baseline, awaiting runtime verification for this release. |
| Live comparisons | The same SKU, product ID, selected values and attribute definition agreed across both servers. Official reads also returned a saved product list, a family attribute's level, a directed link with quantity, and an attribute group. The comparisons exercised reads only. |
| Evidence limit | A gateway input schema establishes an advertised operation. It does not establish that the community credential can reach an equivalent API or that both APIs implement the same update semantics. |

Re-capture official and community discovery at implementation start. Retain tool names, schemas, annotations, date and source revision in the test evidence. Use synthetic fixtures in the public repository. The vendor publishes the supported catalog areas and records beta changes. [Official capabilities](https://docs.plytix.com/mcp/tools/) · [Changelog](https://docs.plytix.com/mcp/changelog/) · [Community transport contract](../docs/features/worker-parity/SPEC.md)

## Release 1 — Four changes with demonstrated demand

### 1. Read and set family attribute levels

**Why.** A family attribute link controls whether a field belongs at parent, variant or no level. The existing link tool accepts labels without a level. A family setup had to generate raw REST requests to express that choice. A later ETL writer handles level changes and checks whether descendants would lose or change displayed content. That writer is a reference for the wire format and remains the owner of migration policy.

**Contract proposed for both transports**

| Operation | Inputs and behavior |
|---|---|
| Extend `families_link_attribute` | Keep `family_id` and `attribute_labels[]`. Add optional `level` with exactly `parent_level`, `variant_level`, or `no_level`. Omission follows the existing payload and response path. An explicit level on a new link requires an exact attribute resolution. A pre-existing link at a different level returns a conflict pointing to the edit operation. |
| Add `families_get_attribute_level` | Accept a family ID and an exact attribute label. Return canonical family ID, attribute ID, label, membership and direct level. Distinguish an existing attribute unlinked from that family, an unknown attribute, an unknown family and a failed read. Inherited membership must not masquerade as a direct editable link. |
| Add `families_set_attribute_level` | Accept `family_id`, `attribute_label`, `level`, optional `expected_level` and `dry_run`. Require an existing direct link. On an expected-level mismatch, return the observed state without applying the change. Compare the guard before treating a repeat call as a no-op. Return prior, requested and read-back level with an explicit outcome. |

The ETL implementation reads the family attribute roster, links new attributes by ObjectId using `attributes_level`, and edits existing links with a payload keyed by target level whose values use `attributes.<label>`. Verify each supported enum on the community credential. The private implementation reference is `supplyline-etl/skills/primitives/writes/guarded_family_inheritance.py`, functions `family_levels` and `run`. Keep account-specific allowlists, leases, inheritance policy and descendant migration decisions in ETL. A generic family edit verifies the association and makes no claim about every descendant's displayed value. [Existing family tools](../src/tools/families.ts)

**Acceptance.** Exercise all three levels, a missing link, an invalid label, a guard conflict, a matching repeat and a dry run. Preserve the legacy no-level-argument call. Verify a change by a fresh direct-association read. If upstream reads lag, bound polling and return the last observed state as unverified. On an ambiguous write result, reconcile by read before another mutation. For explicit multi-label linking, resolve all labels before submission and report each observed association if only part of the operation can be verified.

### 2. Search and retrieve actual directed product links

**Why.** Community `relationships_search` enumerates definitions. Answering “Which assemblies use this part?” previously required paging through products and extracting relationships. The beta exposes individual directed links and allows filters on source, destination and relationship type.

**Contract.** Add `relationships_search_links` with optional exact `from_product_id`, `to_product_id`, `relationship_type_id` and bounded pagination. Combine supplied filters with AND. Return one directed row per link with the three IDs, quantity when present, and continuation information. Add `relationships_get_link` for the exact triple or document an equivalent exact lookup that distinguishes a miss from a failed read. Return the definition's display name and API label as distinct fields when available. Reuse or batch definition lookups and avoid a request per edge. Retain the current `relationships_search` definition lookup. [Current relationship tools](../src/tools/relationships.ts)

**Discovery and acceptance.** Find a supported edge-enumeration API usable with community credentials. Compare outbound, inbound and type-only queries against a known set of directed edges, including A→B and B→A with different quantities. Verify multiple pages, an empty result, absent quantity, and two definitions whose display names differ from their API labels. Reconcile distinct triples against the independent product-based census over a defined, stable scope. Include a source product without edges so a coverage count cannot confuse products with links. If account-wide search is unavailable, deliver any proven scoped lookup with its scope documented and leave global enumeration open. Avoid an invisible catalog-wide scan for a one-page query.

### 3. Read attribute groups and change one membership

**Why.** A previous attempt to group a technical attribute edited the wrong resource. The eventual REST solution patched a roster of 43 labels to change one membership. The beta models that membership as an operation on two exact resources.

**Contract.** Add `attribute_groups_search`, `attribute_groups_get`, `attribute_groups_add_attribute` and `attribute_groups_remove_attribute`. Read operations return group identity and unambiguous membership. Paginated memberships must expose continuation. Writes take an exact group and attribute, resolve labels to IDs when supported, and return the observed before/after membership. A duplicate add or removal of an already absent membership is a no-op after both resource identities have been verified.

**Acceptance.** Start with 43 synthetic labels, change one membership and verify the other 42 are intact. Interleave an unrelated addition by another writer. The final membership must retain both changes, or the operation must report a conflict before overwriting anything. Prefer an upstream single-association operation. If the API offers only whole-list replacement, require an upstream conditional write or equivalent concurrency guarantee before presenting the wrapper as a safe single-member write. A read/compare/write loop and a process-local mutex cannot protect other clients. Read support can ship while write feasibility is unresolved.

### 4. Make tool effects and search results clear to clients

**Tool annotations.** Extend the stdio registration wrapper and Worker descriptors with shared MCP annotations for read-only, destructive, idempotent and open-world behavior where justified. Classify by actual side effects. A tool that supports both dry run and execute advertises its write capability. A file export writes locally. A local identifier calculation and a live catalog read have different external dependencies. Keep delete confirmation, session caps and authority checks independent of client hints. Compare emitted annotations in actual `tools/list` responses for both transports. [Registration wrapper](../src/tools/register.ts) · [Worker](../src/worker.ts) · [Delete gate](../src/safety.ts)

**Search response.** Offer an explicit response mode on `products_search` for callers that need exact field selection and labeled pagination. Preserve the current default envelope. In the new mode, identify requested fields and whether each returned value was present, explicitly null, missing or indeterminate. Do not infer database null from a projected placeholder. Separate page rows, total matching rows and catalog total. Supply a matching total only when the endpoint establishes its meaning. Support a bounded next-page request and document when its result can be empty. [Current search](../src/tools/products.ts) · [By-ID projection](../src/utils/product-get-projection.ts)

**Acceptance.** Reproduce the observed exact-SKU case in a fixture: one returned row, a catalog total of 78,404, and a populated by-ID family field that appeared null in the narrow search. The new mode must neither report 78,404 matches nor assert that the product lacks a family. Include an explicitly null requested field, an absent custom field, an empty page, and a multi-page result. A regression fixture must verify the legacy response and current by-ID projection behavior.

## Release 2 — Remaining catalog parity

For each row below, compare the beta's input fields and response semantics with the community implementation. Classify each operation as **verified equivalent**, **partial**, **missing** or **upstream unavailable**. Record the community tool or implementation issue, upstream credential/transport, and a fixture proving the disposition. “Partial” must identify the specific input, output or side effect that differs. Prioritize DAM intake and saved-list reads after Release 1. These are useful independently of the remaining administrative writes.

| Official capability | Requested community outcome and acceptance example |
|---|---|
| Products | Cover get by ID or exact SKU, create, filtered search, update and field unset. Compare native fields, nested custom fields, relation expansion, pagination, sorting and caps. Reuse exact lookup and narrow set/clear tools where equivalent. Demonstrate that editing one custom field preserves its siblings and distinguish removing a key from assigning null. Compare nullability and whole-map replacement explicitly. |
| Product categories and categorizations | Cover category CRUD/search, product membership and the order of a category **within one product**. Existing tree/root ordering serves a different purpose. Read and update one membership position, then verify product order and tree order independently. |
| Product lists | Support get/search/create/update/delete for supported static and smart lists. Add/remove static members by exact ID, read membership, preserve smart-list filters across edits, and reject direct membership writes to smart lists. Verify a saved-list read, one static member change and an equivalent smart query. |
| Product attributes and groups | Compare definition creation, update and field unset by attribute type, including allowed options, formula, completeness, sorting and restrictions where supported. Preserve the existing options-edit behavior. Cover group CRUD and the Release 1 association tools. Demonstrate that removing a definition field differs from clearing a product value. |
| Families and their attributes | Verify family get/search/create/update/delete and family-attribute get/search/create/update/delete. Validate family rename by ID, level-specific membership queries across the advertised scope, direct unlinking, and dependent-product handling before exposing deletion. Release 1 covers individual level operations. |
| Relationship types and directed links | Add missing type create, rename and delete alongside current definition reads. Support exact edge get/search/link/update/unlink, direction and quantity. The beta type-update schema accepts a display name. Treat API-label renaming as a distinct unsupported request unless separately established. Preview dependent links before type deletion. |
| Assets | Support creation from a source URL or bounded encoded content with filename, plus get/search/update/delete, alt text and supported field unset. Keep current product asset linking available. For document intake, upload a test file once, categorize it and verify by ID. If creation times out after submission, report uncertainty and reconcile before retrying. In-place replacement of file bytes lies outside the beta's advertised update schema. |
| Asset categories and asset lists | Cover category/list CRUD and search, single category membership changes, and static asset-list membership. Verify that adding one category preserves other categories. Compare smart-list query semantics and static-list membership independently. Exercise delete previews with populated fixtures. |

The crosswalk below identifies all 75 official operations observed on November 16. Combine each verb with its suffix using a hyphen to obtain the exact gateway tool name, e.g. `search-product-relationships`. Multiple entries on one row share the same verbs. This inventory pins the comparison even if the beta changes during implementation.

| Gateway suffixes | Observed verbs | Operations |
|---|---|---:|
| `products`, `product-categories`, `product-lists`, `product-attribute-definitions`, `product-attribute-groups`, `product-families`, `family-attributes`, `product-relationship-types`, `assets`, `asset-categories`, `asset-lists` | create, delete, get, search, update | 55 |
| `product-categorizations`, `product-relationship` | get, link, unlink, update | 8 |
| `products-static-lists`, `product-attribute-definitions-groups`, `assets-categories`, `assets-static-lists` | link, unlink | 8 |
| `products-field`, `product-attribute-definitions-field`, `assets-field` | unset | 3 |
| `product-relationships` | search | 1 |

## Implementation and verification

1. **Verify upstream feasibility per operation.** Use the existing API-key clients on stdio and Worker. Record supported API version, route, request/response shape, page limits, permission failures and any documented conditional-write capability. Distinguish a permission denial from an unsupported operation. The official connection's user OAuth grant is independent of community credentials. An undocumented or gateway-only operation stays open until there is a supported implementation.
2. **Implement shared semantics with thin transport wrappers.** Put common validation, request shaping, outcomes and readback in shared modules, as already done for schema writes. Add client methods in both clients where needed. Exercise stdio registration and the Worker's legacy and modern tool discovery/call paths. This work can ship independently of the proposed whole-registry refactor. [Stdio client](../src/client.ts) · [Worker client](../src/worker-client.ts) · [Shared write handlers](../src/schema-write-ops.ts)
3. **Preserve write outcomes under failure.** For new verified-write tools, distinguish a preview, verified change, verified no-op, conflict, upstream refusal and unresolved outcome after submission. Return the exact resource identity and observations. Use bounded reads for eventual consistency. Reuse the existing delete preview/token gate for new destructive entity deletes, including affected dependents. A timeout after a mutation may hide a committed change. An automatic replay must not duplicate an asset or destroy a newer edit.
4. **Exercise the real entry points.** Run both typechecks, unit tests, the stdio handshake and Worker protocol tests against a local Worker. Exercise equivalent fixtures through `tools/call` on both surfaces. Include validation, API rejection, missing resource, pagination, partial failure and readback timeout. Compare normalized domain results while allowing transport-specific protocol envelopes. Check only intentional local-only omissions against the existing exception list.
5. **Separate repository evidence from release evidence.** Each implementation PR supplies its tool crosswalk, fixtures, test commands/results and remaining limitations. For live verification use a permitted disposable test catalog with reversible fixtures, seed and teardown receipts, and separate credentials for each surface as appropriate. Track merged source, installed stdio build, deployed Worker version and live verification separately. Deployment and live writes follow the maintainer's normal release process.
6. **Document the operator contract.** Update tool reference, Worker parity documentation and changelog. Include exact examples for setting a family level, reverse-searching a relationship, changing one group membership and interpreting a narrow search. Document credential requirements, field semantics, side-effect annotations, transport limits and supported upstream versions. [Tool reference](../README.md) · [Changelog](../CHANGELOG.md)

## Sign-off

| Milestone | Ready to accept when |
|---|---|
| Release 1 | The four workflow sections meet their acceptance examples on both surfaces. Any upstream limitation is named with evidence and the affected item stays open or is explicitly deferred by the maintainer. Release notes identify the individual capabilities delivered. |
| Release 2 | Each of the 75 baseline operations maps to a community workflow and field-level evidence. Any accepted exception is listed with user impact and an alternative when available. Claim full baseline parity only when every operation is verified equivalent within the declared credential and transport scope. |
| Operational acceptance | A maintainer can reproduce the representative workflows from the published instructions and identify the version tested on each surface. The record distinguishes fixture results from live observations. |

The beta comparison covers catalog and DAM operations. Channel execution, sync-cache freshness, storefront rendering, increased account quotas and Supplyline-specific migration approval remain separate work. A successful PIM read cannot establish that a downstream channel has run.
