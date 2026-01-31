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
  types.ts              # TypeScript types for Plytix API
  lookup/
    identifier.ts       # Identifier type detection (ID, SKU, MPN, GTIN, label)
    lookup.ts           # Smart product lookup with staged search
    index.ts            # Barrel export
  tools/
    products.ts         # Product tools (lookup, get, search, find)
    families.ts         # Family tools (list, get)
    attributes.ts       # Attribute tools (list, filters)
    assets.ts           # Asset listing
    categories.ts       # Category listing
    variants.ts         # Variant listing
  supplyline/           # Supplyline-specific customizations
    index.ts            # Supplyline tool registration
```

## Available MCP Tools

### Read Operations

| Tool | Description |
|------|-------------|
| `products.lookup` | Smart lookup by any identifier (auto-detects type) |
| `products.get` | Get single product by ID (includes `overwritten_attributes`) |
| `products.search` | Advanced search with filters, pagination, sorting |
| `products.find` | Multi-criteria search (SKU, MPN, GTIN, label, fuzzy) |
| `families.list` | List/search product families |
| `families.get` | Get single family with linked attributes |
| `attributes.list` | List all attributes (system + custom) |
| `attributes.get` | Get full details for a single attribute by label |
| `attributes.get_options` | Get allowed values for a dropdown/multiselect attribute |
| `attributes.filters` | Get available search filters |
| `assets.list` | List assets linked to a product |
| `categories.list` | List categories linked to a product |
| `variants.list` | List variants for a product |

### Write Operations

| Tool | Description |
|------|-------------|
| `products.create` | Create a new product (SKU required) |
| `products.update` | Update product attributes (PATCH - partial update) |
| `products.assign_family` | Assign/unassign family (⚠️ may cause data loss) |
| `categories.link` | Link existing category to product |
| `categories.unlink` | Unlink category from product |
| `variants.resync` | Restore variant attributes to inherit from parent |

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
- Products, Assets, Variants, Categories: v2 API (`/api/v2/...`)
- Families, Filters: v1 API (`/api/v1/...`)

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

_Last updated: 2025-01-22_

### Recent Changes
- Added write tools: `products.create`, `products.update`, `products.assign_family`
- Added category tools: `categories.link`, `categories.unlink`
- Client methods for all write operations

### v0.2.0 (2025-01-16)
- Ported smart lookup system from archived codebase
- Added families tools (list, get)
- Added attributes tools (list, filters)
- Enhanced products.get to include overwritten_attributes
- Added vitest test infrastructure
- Improved PlytixClient with rate limiting and retry logic
