/**
 * Supplyline-specific tools and customizations
 *
 * This directory contains workflow-specific implementations for Supplyline.
 * These extend or customize the generic Plytix MCP tools for Supplyline's
 * particular use cases.
 *
 * Generic Plytix tools live in ../tools/
 * Supplyline-specific tools live here
 *
 * Current modules:
 * - sync/ - Channel export parsing and Supabase sync tools
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { PlytixClient } from "../client.js";
import { registerSyncTools } from "./sync/index.js";

/**
 * Register all Supplyline-specific tools with the MCP server.
 * Call this after registering the generic tools.
 */
export function registerSupplylineTools(server: McpServer, client: PlytixClient): void {
  // Sync tools for Channel export and Supabase integration
  registerSyncTools(server, client);
}
