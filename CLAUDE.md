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
  supplyline/           # Supplyline-specific customizations
    index.ts            # Supplyline tool registration
```

## Available MCP Tools

### Read Operations

| Tool | Description |
|------|-------------|
| `products_lookup` | Smart lookup by any identifier (auto-detects type) |
| `products_get` | Get a single product by ID (includes `overwritten_attributes`) |
| `products_search` | Advanced product search with filters, pagination, and sorting |
| `products_find` | Multi-criteria search (SKU, MPN, GTIN, label, fuzzy) |
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

## Code Organization: Generic vs Supplyline-Specific

**Generic tools (`src/tools/`):**
- Should work for any Plytix user
- No Supplyline-specific business logic
- Follow standard Plytix API patterns

**Supplyline-specific (`src/supplyline/`):**
- Custom workflows, business rules, or integrations
- May use non-standard approaches
- Not guaranteed to be generally applicable

When adding new functionality, ask: "Would this be useful to any Plytix user, or is this specific to Supplyline's workflow?"

## Environment Variables

Required:
- `PLYTIX_API_KEY` - Plytix API key
- `PLYTIX_API_PASSWORD` - Plytix API password

Optional:
- `PLYTIX_API_BASE` - API base URL (default: https://pim.plytix.com)
- `PLYTIX_AUTH_URL` - Auth endpoint (default: https://auth.plytix.com/auth/api/get-token)
- `PLYTIX_MPN_LABELS` - JSON array of MPN attribute labels
- `PLYTIX_MNO_LABELS` - JSON array of MNO attribute labels

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
- Rate limit detection with backoff on 429 responses
- Each tool file exports a `register*Tools(server, client)` function
- Tools are registered in `index.ts`

## Testing

- Unit tests: `src/__tests__/*.test.ts` (vitest)
- Integration tests: `test-integration.js` (requires credentials)
- MCP handshake: `test-mcp-client.js`

## Session Notes

_Last updated: 2026-03-11_

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
