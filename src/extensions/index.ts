/**
 * Custom tool registration (extension point)
 *
 * Optional extension point for deployment-specific MCP tools that are not part of the
 * generic Plytix tool surface. Ships empty by default.
 *
 * To add your own tools, implement them here and enable the registration in
 * src/index.ts (see the commented `registerCustomTools(server, client)` line there).
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { PlytixClient } from '../client.js';

export function registerCustomTools(_server: McpServer, _client: PlytixClient): void {
  // Register custom, deployment-specific tools here, e.g.:
  //   server.tool('my_custom_tool', { /* schema */ }, async (args) => { /* ... */ });
}
