/**
 * Attribute Tools
 *
 * Tools for discovering and listing product attributes.
 * Useful for understanding available fields and building sync logic.
 */

import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { PlytixClient } from '../client.js';

export function registerAttributeTools(server: McpServer, client: PlytixClient) {
  // ─────────────────────────────────────────────────────────────
  // attributes.list - List all available attributes
  // ─────────────────────────────────────────────────────────────

  server.registerTool(
    'attributes_list',
    {
      title: 'List Attributes',
      description:
        'List all available product attributes (system and custom). ' +
        'Returns attribute keys, types, labels, and options for dropdown fields. ' +
        'Use this to discover what attributes exist for syncing to external systems.',
      inputSchema: {
        include_options: z
          .boolean()
          .default(true)
          .describe('Include dropdown/multiselect options in response'),
      },
    },
    async ({ include_options }) => {
      try {
        const { system, custom } = await client.getProductAttributes();

        const result: Record<string, unknown> = {
          system_attributes: system,
          custom_attributes: custom.map((attr) => ({
            key: attr.field,
            label: attr.label,
            type: attr.type,
            ...(include_options && attr.options ? { options: attr.options } : {}),
          })),
          summary: {
            system_count: system.length,
            custom_count: custom.length,
            total: system.length + custom.length,
          },
        };

        return {
          content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
        };
      } catch (error) {
        return {
          content: [
            {
              type: 'text',
              text: `Error listing attributes: ${error instanceof Error ? error.message : 'Unknown error'}`,
            },
          ],
          isError: true,
        };
      }
    }
  );

  // ─────────────────────────────────────────────────────────────
  // attributes.filters - Get available search filters
  // ─────────────────────────────────────────────────────────────

  server.registerTool(
    'attributes_filters',
    {
      title: 'Get Search Filters',
      description:
        'Get all available search filters for product queries. ' +
        'Returns filterable fields, their types, and available operators. ' +
        'Use this to understand how to construct advanced search queries.',
      inputSchema: {},
    },
    async () => {
      try {
        const result = await client.getAvailableFilters();

        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(
                {
                  filters: result.data,
                  count: result.data?.length ?? 0,
                },
                null,
                2
              ),
            },
          ],
        };
      } catch (error) {
        return {
          content: [
            {
              type: 'text',
              text: `Error fetching filters: ${error instanceof Error ? error.message : 'Unknown error'}`,
            },
          ],
          isError: true,
        };
      }
    }
  );
}
