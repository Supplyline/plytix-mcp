# CLAUDE.md

This file provides guidance for AI assistants working with this codebase.

## Project Overview

Plytix MCP Server - A Model Context Protocol server that provides AI assistants with access to Plytix PIM (Product Information Management) data.

## Build & Test Commands

```bash
npm install          # Install dependencies
npm run build        # Build TypeScript to dist/
npm run dev          # Development server with hot reload
npm start            # Start production server
npm test             # Run integration tests
npm run test:mcp     # Test MCP protocol handshake
npm run test:all     # Run all tests
npm run typecheck    # Type check without building
```

## Project Structure

```
src/
  index.ts           # Main server entry point
  plytixClient.ts    # Plytix API client with auth handling
  tools/             # Generic Plytix MCP tools
    products.ts      # Product search and retrieval
    assets.ts        # Asset listing
    categories.ts    # Category listing
    variants.ts      # Variant listing
  supplyline/        # Supplyline-specific customizations (see below)
    index.ts         # Supplyline tool registration
    tools/           # Supplyline-specific tool implementations
```

## Code Organization: Generic vs Supplyline-Specific

This repository serves two purposes:

1. **Generic Plytix MCP Server** (`src/tools/`) - Reusable tools for any Plytix PIM user
2. **Supplyline Customizations** (`src/supplyline/`) - Workflow-specific implementations

### Guidelines

**Generic tools (`src/tools/`):**
- Should work for any Plytix user
- No Supplyline-specific business logic
- Follow standard Plytix API patterns

**Supplyline-specific (`src/supplyline/`):**
- Custom workflows, business rules, or integrations
- May use non-standard approaches or "bastardized" API usage
- Other users may find these useful as examples but they're not guaranteed to be generally applicable

### When adding new functionality

Ask: "Would this be useful to any Plytix user, or is this specific to Supplyline's workflow?"

- **Generic** → Add to `src/tools/`
- **Supplyline-specific** → Add to `src/supplyline/tools/`

## Environment Variables

Required:
- `PLYTIX_API_KEY` - Plytix API key
- `PLYTIX_API_PASSWORD` - Plytix API password

Optional:
- `PLYTIX_API_BASE` - API base URL (default: https://pim.plytix.com)
- `PLYTIX_AUTH_URL` - Auth endpoint (default: https://auth.plytix.com/auth/api/get-token)

## Architecture Notes

- MCP server communicates via stdio
- `PlytixClient` handles authentication with automatic token refresh
- Each tool file exports a `register*Tools(server, client)` function
- Tools are registered in `index.ts`
