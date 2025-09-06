# Plytix MCP Server

A **Model Context Protocol (MCP) server** that provides AI assistants with access to Plytix PIM (Product Information Management) data. This server enables AI tools like Claude Desktop to read, search, and manage product information, assets, categories, and variants through a standardized interface.

## Features

- **5 MCP Tools** for comprehensive Plytix PIM access:
  - `products.get` — Fetch individual products by ID
  - `products.search` — Search products with filters and pagination
  - `assets.list` — List product assets (images, videos, etc.)
  - `categories.list` — List product categories
  - `variants.list` — List product variants
- **Automatic authentication** with token refresh
- **Error handling** with detailed error messages
- **TypeScript** with full type safety
- **Production ready** with proper logging and validation

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

Add this to your Claude Desktop MCP configuration (`~/Library/Application Support/Claude/claude_desktop_config.json` on macOS):

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

### With other MCP clients

The server communicates via **stdio** using the MCP protocol. Start it with:

```bash
npm start
# or for development:
npm run dev
```

### Testing

Run the integration tests to verify everything works:

```bash
# Test with dummy credentials (expects auth failures)
npm test

# Test MCP protocol handshake
npm run test:mcp

# Run all tests
npm run test:all
```

## Available Tools

### products.get
Fetch a single product by its ID.

**Input:**
```json
{
  "product_id": "your-product-id-here"
}
```

**Example:**
```json
{
  "product_id": "64f8a1b2c3d4e5f6a7b8c9d0"
}
```

### products.search
Search products with filters, pagination, and attribute selection.

**Input:**
```json
{
  "attributes": ["sku", "label", "attributes.color", "attributes.size"],
  "filters": [
    [{ "field": "modified", "operator": "last_days", "value": "30" }]
  ],
  "pagination": {
    "page": 1,
    "page_size": 25
  },
  "sort": {
    "field": "modified",
    "order": "desc"
  }
}
```

**Notes:**
- Prefix custom attributes with `attributes.`
- Maximum 50 attributes allowed
- Use product-specific endpoints for assets, categories, and variants

### assets.list
List all assets (images, videos, documents) linked to a product.

**Input:**
```json
{
  "product_id": "your-product-id-here"
}
```

### categories.list
List all categories associated with a product.

**Input:**
```json
{
  "product_id": "your-product-id-here"
}
```

### variants.list
List all variants (size, color, etc.) for a product.

**Input:**
```json
{
  "product_id": "your-product-id-here"
}
```

## Configuration

### Environment Variables

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `PLYTIX_API_KEY` | ✅ | - | Your Plytix API key |
| `PLYTIX_API_PASSWORD` | ✅ | - | Your Plytix API password |
| `PLYTIX_API_BASE` | ❌ | `https://pim.plytix.com` | Plytix API base URL |
| `PLYTIX_AUTH_URL` | ❌ | `https://auth.plytix.com/auth/api/get-token` | Authentication endpoint |

### Example .env file

```bash
PLYTIX_API_KEY=your_api_key_here
PLYTIX_API_PASSWORD=your_api_password_here
# Optional overrides:
# PLYTIX_API_BASE=https://pim.plytix.com
# PLYTIX_AUTH_URL=https://auth.plytix.com/auth/api/get-token
```

## Development

### Scripts

- `npm run dev` - Start development server with hot reload
- `npm run build` - Build TypeScript to JavaScript
- `npm start` - Start production server
- `npm test` - Run integration tests
- `npm run test:mcp` - Test MCP protocol handshake
- `npm run test:all` - Run all tests
- `npm run typecheck` - Type check without building

### Architecture

- **`src/index.ts`** - Main server entry point
- **`src/plytixClient.ts`** - Plytix API client with auth handling
- **`src/tools/`** - MCP tool implementations
  - `products.ts` - Product-related tools
  - `assets.ts` - Asset management tools
  - `categories.ts` - Category tools
  - `variants.ts` - Product variant tools

### Error Handling

The server includes comprehensive error handling:
- **Authentication errors** - Clear messages for invalid credentials
- **API errors** - Detailed error responses from Plytix API
- **Network errors** - Timeout and connection error handling
- **Validation errors** - Input validation with helpful messages

## Contributing

1. Fork the repository
2. Create a feature branch: `git checkout -b feature-name`
3. Make your changes
4. Run tests: `npm run test:all`
5. Commit your changes: `git commit -m 'Add feature'`
6. Push to the branch: `git push origin feature-name`
7. Submit a pull request

## License

MIT License - see [LICENSE](LICENSE) file for details.

## Support

- **Issues**: [GitHub Issues](https://github.com/Supplyline/plytix-mcp/issues)
- **Documentation**: [Plytix API Docs](https://docs.plytix.com/)
- **MCP Protocol**: [Model Context Protocol](https://modelcontextprotocol.io/)
