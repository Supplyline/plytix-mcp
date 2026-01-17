# Plytix MCP Server

A **lightweight, stateless Model Context Protocol (MCP) server** that provides AI assistants with live access to Plytix PIM (Product Information Management) data. This server enables AI tools like Claude Desktop to search, look up, and retrieve product information directly from the Plytix API.

> **Note:** This is a read-only query tool for live API access. For sync, caching, or ETL workflows, see [supplyline-sync](https://github.com/Supplyline/supplyline-sync).

## Features

- **11 MCP Tools** for comprehensive Plytix PIM access
- **Smart product lookup** with automatic identifier detection (SKU, MPN, GTIN, label)
- **Family & inheritance tracking** with overwritten_attributes support
- **Schema discovery** for attributes and search filters
- **Automatic authentication** with token refresh
- **Rate limit handling** with exponential backoff
- **Zero persistence** — stateless, no database required

## Installation

### Prerequisites

- **Node.js 18+** (Node 20+ recommended)
- **Plytix PIM account** with API access

### Setup

1. **Clone and install:**
```bash
git clone https://github.com/Supplyline/plytix-mcp.git
cd plytix-mcp
npm install
```

2. **Configure credentials:**
```bash
cp .env.example .env
# Edit .env with your Plytix API credentials
```

3. **Build the project:**
```bash
npm run build
```

## Usage

### With Claude Desktop

Add to your Claude Desktop MCP configuration (`~/Library/Application Support/Claude/claude_desktop_config.json` on macOS):

```json
{
  "mcpServers": {
    "plytix": {
      "command": "node",
      "args": ["/path/to/plytix-mcp/dist/index.js"],
      "env": {
        "PLYTIX_API_KEY": "your_api_key_here",
        "PLYTIX_API_PASSWORD": "your_api_password_here"
      }
    }
  }
}
```

### Standalone

```bash
npm start          # Production mode
npm run dev        # Development with hot reload
```

## Available Tools

### Product Tools

| Tool | Description |
|------|-------------|
| `products_lookup` | Smart lookup by any identifier (auto-detects ID, SKU, MPN, GTIN, label) |
| `products_get` | Get single product by ID with full details and `overwritten_attributes` |
| `products_search` | Advanced search with filters, pagination, and sorting |
| `products_find` | Simple multi-criteria search (SKU, MPN, MNO, GTIN, label, fuzzy) |

### Family Tools

| Tool | Description |
|------|-------------|
| `families_list` | List or search product families |
| `families_get` | Get single family with linked attributes |

### Attribute Tools

| Tool | Description |
|------|-------------|
| `attributes_list` | List all attributes (system + custom) with types and options |
| `attributes_filters` | Get available search filters and operators |

### Related Data Tools

| Tool | Description |
|------|-------------|
| `assets_list` | List assets (images, videos, documents) linked to a product |
| `categories_list` | List categories associated with a product |
| `variants_list` | List variants for a product |

## Smart Lookup System

The `products_lookup` tool automatically detects identifier types and uses staged search strategies:

**Detection priority:**
1. MongoDB ObjectId (24-char hex) → `id` (confidence: 1.0)
2. GTIN (8/12/13/14 digits) → `gtin` (confidence: 0.95)
3. Contains spaces → `label` (confidence: 0.9)
4. Dashed alphanumeric → `mpn` (confidence: 0.8)
5. Alphanumeric with separators → `sku` (confidence: 0.7)

**Search strategies (in order):**
1. Direct ID lookup (if detected as ID)
2. Exact field matches (SKU, GTIN, MPN, MNO)
3. Text search across multiple fields
4. Broad LIKE search (last resort)

**Example:**
```
Input: "LMI-PD-123"
→ Detected as: sku (confidence: 0.7)
→ Tries: sku_eq, mpn fields, text_search, broad_like
→ Returns: best match with confidence score
```

## Inheritance Tracking

Products return an `overwritten_attributes` array listing which attributes are explicitly set (not inherited from family). Use this with:

- `product_family_id` — The family this product belongs to
- `families_get` — Retrieve family-level default values
- Compare to determine inherited vs overwritten values

## Configuration

### Environment Variables

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `PLYTIX_API_KEY` | ✅ | — | Your Plytix API key |
| `PLYTIX_API_PASSWORD` | ✅ | — | Your Plytix API password |
| `PLYTIX_API_BASE` | ❌ | `https://pim.plytix.com` | Plytix API base URL |
| `PLYTIX_AUTH_URL` | ❌ | `https://auth.plytix.com/auth/api/get-token` | Auth endpoint |
| `PLYTIX_MPN_LABELS` | ❌ | `["attributes.mpn"]` | JSON array of MPN attribute labels |
| `PLYTIX_MNO_LABELS` | ❌ | `["attributes.model_no"]` | JSON array of MNO attribute labels |

## Development

### Scripts

| Command | Description |
|---------|-------------|
| `npm run dev` | Development server with hot reload |
| `npm run build` | Build TypeScript to JavaScript |
| `npm start` | Start production server |
| `npm test` | Run unit tests (vitest) |
| `npm run test:watch` | Run tests in watch mode |
| `npm run test:mcp` | Test MCP protocol handshake |
| `npm run test:all` | Build + unit + integration + MCP tests |
| `npm run typecheck` | Type check without building |

### Architecture

```
src/
  index.ts              # MCP server entry point
  client.ts             # Plytix API client with auth & rate limiting
  types.ts              # TypeScript types
  lookup/
    identifier.ts       # Identifier type detection
    lookup.ts           # Smart lookup with staged search
  tools/
    products.ts         # Product tools (lookup, get, search, find)
    families.ts         # Family tools (list, get)
    attributes.ts       # Attribute tools (list, filters)
    assets.ts           # Asset listing
    categories.ts       # Category listing
    variants.ts         # Variant listing
  supplyline/           # Supplyline-specific customizations
```

### Design Principles

This MCP server is intentionally **stateless and lightweight**:

- **No database** — All queries go directly to Plytix API
- **No sync/caching layer** — Fresh data on every request
- **No background jobs** — Request/response only
- **Ephemeral in-memory cache** — Brief (60s) request deduplication, cleared on restart

For ETL, sync, or persistent caching needs, use a separate tool like [supplyline-sync](https://github.com/Supplyline/supplyline-sync).

## License

MIT License — see [LICENSE](LICENSE) file for details.

## Support

- **Issues**: [GitHub Issues](https://github.com/Supplyline/plytix-mcp/issues)
- **Plytix API**: [Plytix Documentation](https://docs.plytix.com/)
- **MCP Protocol**: [Model Context Protocol](https://modelcontextprotocol.io/)
