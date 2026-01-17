# Remote MCP Server Setup

This guide explains how to use the Plytix MCP server as a remote service, enabling access from Claude mobile app, Claude Desktop, and other MCP clients.

## Overview

The remote MCP server runs on Cloudflare Workers and provides:
- **No local setup required** - Access from any device
- **BYOK (Bring Your Own Key)** - Your Plytix API credentials are sent per-request
- **Mobile access** - Works with Claude mobile app
- **Team sharing** - Single deployment, multiple users

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

| Tool | Description |
|------|-------------|
| `products_lookup` | Smart lookup by any identifier (auto-detects type) |
| `products_get` | Get single product by ID |
| `products_search` | Advanced search with filters, pagination, sorting |
| `products_find` | Multi-criteria search (SKU, MPN, GTIN, label, fuzzy) |
| `families_list` | List/search product families |
| `families_get` | Get single family with linked attributes |
| `attributes_list` | List all attributes (system + custom) |
| `attributes_filters` | Get available search filters |
| `assets_list` | List assets linked to a product |
| `categories_list` | List categories linked to a product |
| `variants_list` | List variants for a product |
