# CLAUDE.md

This file provides guidance for AI assistants working with this codebase.

## Project Overview

Plytix MCP Server - A Model Context Protocol server that provides AI assistants with access to Plytix PIM (Product Information Management) data. Supports smart product lookup, family/inheritance tracking, and attribute metadata.

## Build & Test Commands

```bash
npm install          # Install dependencies
npm run build        # Build TypeScript to dist/
npm run dev          # Development server with hot reload
npm start            # Start production server
npm test             # Run unit tests (vitest)
npm run test:watch   # Run tests in watch mode
npm run test:mcp     # Test MCP protocol handshake
npm run test:all     # Build + unit + integration + MCP tests
npm run typecheck    # Type check without building
```

## Project Structure

```
src/
  index.ts              # MCP server entry point
  client.ts             # Enhanced Plytix API client
  worker-client.ts      # Request-scoped Plytix client for the Cloudflare Worker
  types.ts              # TypeScript types for Plytix API
  worker.ts             # Cloudflare Worker MCP entry point
  batch/                # Shared batch update/export runners and stdio-only file helpers
  lookup/
    identifier.ts       # Identifier type detection (ID, SKU, MPN, GTIN, label)
    lookup.ts           # Smart product lookup with staged search
    index.ts            # Barrel export
  tools/
    products.ts         # Product tools (lookup, get, search, find, writes)
    families.ts         # Family tools (list, get, create, attribute membership)
    attributes.ts       # Attribute metadata + filter discovery tools
    product-attributes.ts # Atomic product attribute write tools
    assets.ts           # Asset get/search/update + product asset link tools
    categories.ts       # Category search + product category link tools
    variants.ts         # Variant lifecycle tools
    relationships.ts    # Relationship discovery + product relationship write tools
  extensions/           # Optional deployment-specific customizations
    index.ts            # Custom tool registration (registerCustomTools)
```

## Available MCP Tools

### Read Operations

| Tool | Description |
|------|-------------|
| `products_lookup` | Smart lookup by any identifier (auto-detects type) |
| `products_get` | Get a single product by ID (includes `overwritten_attributes`) |
| `products_search` | Advanced product search with filters, pagination, and sorting |
| `products_find` | Multi-criteria search (SKU, MPN, GTIN, label, fuzzy) |
| `products_batch_export` | Capped inline product export by search, SKU, or product ID |
| `products_batch_export_to_file` | Stdio-only JSONL/NDJSON product export under `PLYTIX_MCP_EXPORT_DIR` |
| `families_list` | List or search product families |
| `families_get` | Get one product family |
| `families_list_attributes` | List attributes directly linked to a family |
| `families_list_all_attributes` | List direct + inherited family attributes |
| `attributes_list` | List all product attributes (system + custom) |
| `attributes_get` | Get full details for a single attribute by label |
| `attributes_get_options` | Get allowed values for a dropdown/multiselect attribute |
| `attributes_filters` | Deprecated alias for product filter discovery |
| `products_filters` | Get product search filter metadata |
| `assets_filters` | Get asset search filter metadata |
| `relationships_filters` | Get relationship search filter metadata |
| `assets_get` | Get a single asset by ID |
| `assets_search` | Search account assets |
| `assets_list` | List assets linked to a product |
| `categories_search` | Search existing product categories |
| `categories_list` | List categories linked to a product |
| `variants_list` | List variants for a product |
| `relationships_get` | Get a relationship definition |
| `relationships_search` | Search relationship definitions |
| `identifier_detect` | Detect identifier type from format |
| `identifier_normalize` | Normalize identifier formatting for comparison |
| `match_score` | Score how well an identifier matches product data |

### Write Operations

| Tool | Description |
|------|-------------|
| `products_create` | Create a new product (SKU required) |
| `products_update` | Update product fields and attributes (PATCH) |
| `products_batch_update` | Update a small batch of products by `product_id` or `sku` (PATCH loop; inline capped; supports drift guards) |
| `products_batch_update_manifest` | Update products from a local JSON manifest (stdio-only; supports dry run and drift guards) |
| `products_assign_family` | Assign or unassign family (may cause data loss) |
| `products_set_attribute` | Set one product attribute atomically |
| `products_clear_attribute` | Clear one product attribute atomically |
| `families_create` | Create a new product family |
| `families_link_attribute` | Link one or more attributes to a family |
| `families_unlink_attribute` | Unlink one or more attributes from a family |
| `assets_update` | Update asset metadata (`filename`, `categories` only) |
| `assets_link` | Link an existing asset to a product |
| `assets_unlink` | Unlink an asset from a product |
| `categories_link` | Link an existing category to a product |
| `categories_unlink` | Unlink an existing category from a product |
| `variants_create` | Create a new variant beneath a parent product |
| `variants_link` | Convert an existing product into a variant |
| `variants_unlink` | Detach a variant without deleting the product |
| `variants_resync` | Restore variant attributes to inherit from parent |
| `relationships_link_product` | Link one related product row |
| `relationships_unlink_product` | Unlink one related product row |
| `relationships_set_quantity` | Update quantity for one related product row |

## Smart Lookup System

The lookup system automatically detects identifier types and uses staged search strategies:

**Detection priority:**
1. MongoDB ObjectId (24-char hex) → `id` (confidence: 1.0)
2. GTIN (8/12/13/14 digits) → `gtin` (confidence: 0.95)
3. Spaces → `label` (confidence: 0.9)
4. Dashed alphanumeric → `mpn` (confidence: 0.8)
5. Alphanumeric with separators → `sku` (confidence: 0.7)
6. Pure alphanumeric → `sku` (confidence: 0.7)

**Search strategies:**
1. Direct ID lookup (if detected as ID)
2. Exact field matches (SKU, GTIN, MPN, MNO)
3. Text search across multiple fields
4. Broad LIKE search (last resort)

## Code Organization: Core vs Extensions

**Core tools (`src/tools/`):**
- Should work for any Plytix user
- No deployment-specific business logic
- Follow standard Plytix API patterns

**Custom extensions (`src/extensions/`):**
- Optional, deployment-specific workflows, business rules, or integrations
- May use non-standard approaches
- Not guaranteed to be generally applicable
- Ships empty by default; register via `registerCustomTools` (see `src/index.ts`)

When adding new functionality, ask: "Would this be useful to any Plytix user, or is it specific to one deployment's workflow?"

## Environment Variables

Required:
- `PLYTIX_API_KEY` - Plytix API key
- `PLYTIX_API_PASSWORD` - Plytix API password

Optional:
- `PLYTIX_API_BASE` - API base URL (default: https://pim.plytix.com)
- `PLYTIX_AUTH_URL` - Auth endpoint (default: https://auth.plytix.com/auth/api/get-token)
- `PLYTIX_MPN_LABELS` - JSON array of MPN attribute labels
- `PLYTIX_MNO_LABELS` - JSON array of MNO attribute labels
- `PLYTIX_MCP_EXPORT_DIR` - Required only for stdio `products_batch_export_to_file`;
  file exports are restricted to this directory

## Plytix API Notes

**Authentication:**
- Two-step: POST credentials to auth endpoint, receive token
- Token at `data[0].access_token` (array, not object)
- Default TTL: 15 minutes, refresh 60s before expiry

**Naming convention (backwards from typical):**
- `label` = snake_case identifier (e.g., "head_material")
- `name` = human-readable name (e.g., "Head Material")

**API versions:**
- Product reads/writes, product-linked assets/categories, relationship mutations, and most variant operations use v2 (`/api/v2/...`)
- Account-level assets, category discovery, relationship definitions, families, filters, and attribute metadata use v1 (`/api/v1/...`)

**Attribute limits:**
- v2 search: max 50 attributes
- v1 search: max 20 attributes

**Rate limits:** 50 req / 10 s and 5,000 req / h per account, advertised only in the auth JWT
(`user_claims.account.rate_limit`); no `x-ratelimit-*` headers. See
`docs/solutions/api-quirks/plytix-api.md` §16a.

## Inheritance Tracking

Products return `overwritten_attributes` array listing attributes explicitly set (not inherited from family). If an attribute is NOT in this array, its value comes from family inheritance.

Related fields:
- `product_family_id` - The family this product belongs to
- `product_family_model_id` - The model within the family
- `product_type` - PARENT, VARIANT, or STANDALONE
- `product_level` - Hierarchy level (1 = parent, 2 = variant)

## Architecture Notes

- MCP server communicates via stdio (StdioServerTransport)
- `PlytixClient` handles authentication with automatic token refresh
- Rate limiting: token-bucket pacing (40 req / 10 s default, learned from the auth JWT) plus
  body-aware 429/5xx backoff in `src/rate-limit.ts`; stdio logs retries to stderr as JSON
- Each tool file exports a `register*Tools(server, client)` function
- Tools are registered in `index.ts`

## Testing

- Unit tests: `src/__tests__/*.test.ts` (vitest)
- Integration tests: `test-integration.js` (requires credentials)
- MCP handshake: `test-mcp-client.js`

## Session Notes

_Last updated: 2026-07-27_

### MCP 2026-07-28 conformance (worker)

`src/protocol.ts` holds the version/era logic; `src/worker.ts` wires it into the
endpoint. The worker is **dual-era** — the `2026-07-28` revision removed the
`initialize` handshake and `Mcp-Session-Id`, but shipping clients still use them,
so both are served on one endpoint.

- Era is detected by **shape, not version value**: presence of the
  `io.modelcontextprotocol/protocolVersion` `_meta` key (a key legacy clients never
  emit), or an `MCP-Protocol-Version` header naming a non-legacy version. This is
  what lets a *future* client reach the modern path and renegotiate via `-32022`
  instead of being silently downgraded.
- Modern path only: mirrored-header validation (`-32020`), required `_meta`
  (`-32602`), unknown method → `404`/`-32601` *before* the auth gate, and
  `resultType` + `serverInfo` stamped on results. Legacy responses are deliberately
  left byte-identical so an upgrade can't perturb a connected client.
- `clientExtensions()` is the negotiation seam for MCP Apps (`io.modelcontextprotocol/ui`)
  and Tasks (`io.modelcontextprotocol/tasks`) — both are advertised in per-request
  capabilities, so extension work builds on this.
- Deprecated by the RC but unused here: Roots, Sampling, Logging. Error `-32002` is
  retired in favour of `-32602` (we never emitted it).

**Stdio is still legacy** and cannot move yet: it delegates the protocol to
`@modelcontextprotocol/sdk`, whose latest (1.29.0) tops out at `2025-11-25`. When the
SDK ships `2026-07-28` this becomes a dependency bump, not hand-rolled work.

Not yet done (tracked separately): CIMD client registration (DCR is now formally
deprecated), `iss` on authorization responses per RFC 9207, and the RFC 8707
`resource` parameter.

### Recent Changes
- Added variant lifecycle tools: `variants_create`, `variants_link`, `variants_unlink`
- Added asset read/search/update tools and split filter discovery by resource
- Added category search, relationship discovery, and expanded family operations

### v0.2.0 (2025-01-16)
- Ported smart lookup system from archived codebase
- Added families tools (list, get)
- Added attributes tools (list, filters)
- Enhanced products.get to include overwritten_attributes
- Added vitest test infrastructure
- Improved PlytixClient with rate limiting and retry logic

## Delete Safety Gate

`src/safety.ts` is the shared gate for destructive tools. When adding a
delete-style tool, use it rather than inventing another pattern:

```ts
import {
  makeDryRunResult,
  authorizeDelete,
  recordDelete,
} from '../safety.js';
```

In the handler:

1. Resolve the target and build a `preview` object. If it does not resolve,
   return `isError` — never issue a token for something that is not there.
2. If `dry_run`, return `makeDryRunResult(tool, target, preview)`. It returns
   `{ ok: false }` when the session cap is exhausted, so no token is minted
   that could never be redeemed.
3. Otherwise call `authorizeDelete(tool, target, confirm_token)`. It checks the
   cap *before* consuming the token, so a capped session does not strand a
   valid token.
4. Perform the delete, and call `recordDelete()` **only if something was
   actually removed**. A 404 no-op must not spend the session budget.

The cap comes from `PLYTIX_MCP_MAX_DELETES` (default 3, `0` disables deletes).

Note the gate's limits: the token is returned to the calling agent, so this is
a forced pause with a preview, not human confirmation. See the README section
for the `elicitInput` upgrade path.
