/**
 * Supplyline-specific tools and customizations
 *
 * This directory contains workflow-specific implementations for Supplyline.
 * These extend or customize the generic Plytix MCP tools for Supplyline's
 * particular use cases.
 *
 * Generic Plytix tools live in ../tools/
 * Supplyline-specific tools live in ./tools/
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { PlytixClient } from "../plytixClient.js";

/**
 * Register all Supplyline-specific tools with the MCP server.
 * Call this after registering the generic tools.
 */
export function registerSupplylineTools(server: McpServer, client: PlytixClient): void {
  // Add Supplyline-specific tool registrations here
  // Example:
  // registerSupplylineProductTools(server, client);
  // registerSupplylineWorkflowTools(server, client);
}
