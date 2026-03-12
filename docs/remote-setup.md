# Remote MCP Server Setup

This guide explains how to use the Plytix MCP server as a remote service, enabling access from Claude mobile app, Claude Desktop, and other MCP clients.

## Overview

The remote MCP server runs on Cloudflare Workers and provides:
- **No local setup required** - Access from any device
- **BYOK (Bring Your Own Key)** - Your Plytix API credentials are sent per-request
- **Mobile access** - Works with Claude mobile app
- **Team sharing** - Single deployment, multiple users
- **44 remote tools** - All API-backed tools in this project except three local-only identifier utilities

The remote worker intentionally does not expose these stdio-only utilities:
- `identifier_detect`
- `identifier_normalize`
- `match_score`

For remote clients, use `products_lookup` instead of those helpers.

## Getting Your Plytix API Key

1. Log in to [Plytix](https://pim.plytix.com)
2. Go to **Settings** > **API Keys**
3. Create a new API key or use an existing one
4. Note both the **API Key** and **API Password**

## Using the Remote Server

### Deployed Server URL

After deployment, your server will be available at:
```
https://plytix-mcp.your-subdomain.workers.dev/mcp
```

### Authentication

Every request must include your Plytix credentials in headers:

```
X-Plytix-API-Key: your-api-key
X-Plytix-API-Password: your-api-password
```

### Endpoints

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/` | GET | Server info and capabilities |
| `/health` | GET | Health check |
| `/mcp` | POST | MCP JSON-RPC endpoint |

## Client Configuration

### Claude Desktop

Add to your Claude Desktop configuration (`~/.claude/claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "plytix": {
      "command": "npx",
      "args": [
        "mcp-remote",
        "https://plytix-mcp.your-subdomain.workers.dev/mcp",
        "--header",
        "X-Plytix-API-Key: YOUR_API_KEY",
        "--header",
        "X-Plytix-API-Password: YOUR_API_PASSWORD"
      ]
    }
  }
}
```

### Claude Mobile App

The Claude mobile app supports remote MCP servers natively. In the app settings:

1. Go to **Settings** > **MCP Servers**
2. Add a new server with URL: `https://plytix-mcp.your-subdomain.workers.dev/mcp`
3. Add custom headers:
   - `X-Plytix-API-Key: YOUR_API_KEY`
   - `X-Plytix-API-Password: YOUR_API_PASSWORD`

### Cursor / Other Clients

For clients that support remote MCP via `mcp-remote`:

```bash
npx mcp-remote https://plytix-mcp.your-subdomain.workers.dev/mcp \
  --header "X-Plytix-API-Key: YOUR_API_KEY" \
  --header "X-Plytix-API-Password: YOUR_API_PASSWORD"
```

## Testing the Connection

### Using curl

```bash
# Health check
curl https://plytix-mcp.your-subdomain.workers.dev/health

# List available tools
curl -X POST https://plytix-mcp.your-subdomain.workers.dev/mcp \
  -H "Content-Type: application/json" \
  -H "X-Plytix-API-Key: YOUR_API_KEY" \
  -H "X-Plytix-API-Password: YOUR_API_PASSWORD" \
  -d '{"jsonrpc":"2.0","method":"tools/list","id":1}'

# Lookup a product
curl -X POST https://plytix-mcp.your-subdomain.workers.dev/mcp \
  -H "Content-Type: application/json" \
  -H "X-Plytix-API-Key: YOUR_API_KEY" \
  -H "X-Plytix-API-Password: YOUR_API_PASSWORD" \
  -d '{"jsonrpc":"2.0","method":"tools/call","params":{"name":"products_lookup","arguments":{"identifier":"YOUR-SKU"}},"id":1}'
```

### Using the test script

```bash
# Test against local development server
PLYTIX_API_KEY=your-key PLYTIX_API_PASSWORD=your-password npm run test:worker

# Test against deployed worker
PLYTIX_API_KEY=your-key PLYTIX_API_PASSWORD=your-password \
  node test-worker.js https://plytix-mcp.your-subdomain.workers.dev
```

## Example Queries

Once connected, try these queries in Claude:

1. **Product lookup**
   > "Look up the product with SKU ABC-123"

2. **Search products**
   > "Find all products in the 'Tools' category"

3. **Get product details**
   > "Show me all attributes for product ID 507f1f77bcf86cd799439011"

4. **List families**
   > "What product families exist in Plytix?"

5. **Check inheritance**
   > "Which attributes on product XYZ are inherited from its family?"

## Deploying Your Own Instance

### Prerequisites

- Node.js 18+
- Cloudflare account
- Wrangler CLI (`npm install -g wrangler`)

### Steps

1. Clone the repository:
   ```bash
   git clone https://github.com/Supplyline/plytix-mcp.git
   cd plytix-mcp
   npm install
   ```

2. Authenticate with Cloudflare:
   ```bash
   wrangler login
   ```

3. Deploy:
   ```bash
   npm run deploy
   ```

4. Your server will be available at the URL shown in the output.

### Local Development

```bash
# Start local development server
npm run dev:worker

# Test locally
curl http://localhost:8787/health
```

## Security Considerations

- **API credentials are never stored** - They're sent with each request
- **CORS is configured** - Only allows requests from Claude origins
- **HTTPS only** - All production traffic is encrypted
- **No logging of credentials** - API keys are not logged

## Troubleshooting

### "Missing Plytix API credentials"
Ensure you're sending both headers:
- `X-Plytix-API-Key`
- `X-Plytix-API-Password`

### "Authentication failed"
- Verify your API key and password are correct
- Check if the API key has expired in Plytix settings

### "Rate limited"
The Plytix API has rate limits. The server handles backoff automatically, but repeated rapid requests may still be throttled.

### Connection timeout
- Check your internet connection
- Verify the worker URL is correct
- Try the health endpoint first: `GET /health`

## Available Tools

### Product Tools

| Tool | Description |
|------|-------------|
| `products_lookup` | Smart lookup by any identifier (auto-detects type) |
| `products_get` | Get single product by ID |
| `products_get_full` | Get one product with family, variants, categories, and assets |
| `products_search` | Advanced search with filters, pagination, sorting |
| `products_find` | Multi-criteria search (SKU, MPN, GTIN, label, fuzzy) |
| `products_create` | Create a new product |
| `products_update` | Update product fields and attributes |
| `products_assign_family` | Assign or unassign a family |
| `products_set_attribute` | Set one product attribute atomically |
| `products_clear_attribute` | Clear one product attribute atomically |

### Family Tools

| Tool | Description |
|------|-------------|
| `families_list` | List or search product families |
| `families_get` | Get one family with linked attributes |
| `families_create` | Create a new product family |
| `families_link_attribute` | Link one or more attributes to a family |
| `families_unlink_attribute` | Unlink one or more attributes from a family |
| `families_list_attributes` | List attributes directly linked to a family |
| `families_list_all_attributes` | List direct and inherited family attributes |

### Attribute & Filter Tools

| Tool | Description |
|------|-------------|
| `attributes_list` | List all attributes (system + custom) |
| `attributes_get` | Get attribute metadata by label |
| `attributes_get_options` | Get allowed values for a selectable attribute |
| `attributes_filters` | Deprecated alias for product filter discovery |
| `products_filters` | Get product search filter metadata |
| `assets_filters` | Get asset search filter metadata |
| `relationships_filters` | Get relationship search filter metadata |

### Asset Tools

| Tool | Description |
|------|-------------|
| `assets_get` | Get one asset by ID |
| `assets_search` | Search account assets |
| `assets_update` | Update asset metadata (`filename`, `categories`) |
| `assets_list` | List assets linked to a product |
| `assets_link` | Link asset to a product |
| `assets_unlink` | Unlink asset from a product |

### Category Tools

| Tool | Description |
|------|-------------|
| `categories_search` | Search existing categories |
| `categories_list` | List categories linked to a product |
| `categories_link` | Link a category to a product |
| `categories_unlink` | Unlink a category from a product |

### Variant Tools

| Tool | Description |
|------|-------------|
| `variants_create` | Create a variant beneath a parent product |
| `variants_link` | Link an existing product as a variant |
| `variants_unlink` | Unlink a variant without deleting the product |
| `variants_list` | List variants for a product |
| `variants_resync` | Reset variant attributes to inherit from parent |

### Relationship Tools

| Tool | Description |
|------|-------------|
| `relationships_get` | Get a relationship definition |
| `relationships_search` | Search relationship definitions |
| `relationships_link_product` | Link one related product row in a relationship |
| `relationships_unlink_product` | Unlink one related product row in a relationship |
| `relationships_set_quantity` | Update quantity for one related product row |
