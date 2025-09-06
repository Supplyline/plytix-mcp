
# plytix-mcp-server

Minimal **MCP server** (stdio) that authenticates to **Plytix PIM** and exposes two tools out of the box:

- `products.get` — `GET /api/v2/products/:product_id`
- `products.search` — `POST /api/v2/products/search`

> Uses **API v2**. Tokens are short‑lived (~15 min). We re‑auth on 401 automatically.

## Quick start

1) **Node 18+** required (Node 20 recommended).  
2) Install dependencies:

```bash
npm i
```

3) Configure credentials:

```bash
cp .env.example .env
# edit .env to set PLYTIX_API_KEY and PLYTIX_API_PASSWORD
```

4) Run the server (stdio):

```bash
npm run dev
```

You can register this MCP server in a compatible client (e.g., Claude Desktop / other MCP client) as a **stdio** server with the command:
```jsonc
{
  "mcpServers": {
    "plytix": {
      "command": "npx",
      "args": ["tsx", "src/index.ts"],
      "env": {
        "PLYTIX_API_KEY": "...",
        "PLYTIX_API_PASSWORD": "..."
      }
    }
  }
}
```

## Tools

### products.get
**Input**
```json
{ "product_id": "xxxxxxxxxxxxxxxx" }
```
**Effect**  
Calls `GET https://pim.plytix.com/api/v2/products/:product_id` with a valid Bearer token.

### products.search
**Input**
```json
{
  "attributes": ["sku", "label", "attributes.color"],
  "filters": [[{ "field": "modified", "operator": "last_days", "value": "30" }]],
  "pagination": { "page": 1, "page_size": 25 }
}
```
**Notes**
- Prefix custom/user attributes with `attributes.`
- Up to **50 attributes** allowed by v2 search
- Media/categories are **not** inlined in product reads; use product‑scoped endpoints.

## Next endpoints (scaffolded)
Scaffold files are included under `src/tools/` for:
- `assets.list` → `GET /api/v2/products/:product_id/assets`
- `categories.list` → `GET /api/v2/products/:product_id/categories`
- `variants.list` → `GET /api/v2/products/:product_id/variants`

Uncomment registrations in `src/index.ts` to enable once you're ready.

## Environment variables
- `PLYTIX_API_KEY` (required)
- `PLYTIX_API_PASSWORD` (required)
- `PLYTIX_API_BASE` (default `https://pim.plytix.com`)
- `PLYTIX_AUTH_URL` (default `https://auth.plytix.com/auth/api/get-token`)

## Dev tips
- The client auto‑refreshes token on 401 and caches for ~14 minutes with 60s skew.
- On HTTP 429, the call throws — add retries/backoff where you orchestrate bulk ops.
- If you get `NXDOMAIN` or 401s, verify hosts and Bearer header capitalization.
