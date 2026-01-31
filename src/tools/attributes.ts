/**
 * Attribute Tools
 *
 * Tools for discovering and listing product attributes.
 * Useful for understanding available fields and building queries.
 */

import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { PlytixClient } from '../client.js';
import { registerTool } from './register.js';

export function registerAttributeTools(server: McpServer, client: PlytixClient) {
  // ─────────────────────────────────────────────────────────────
  // attributes.list - List all available attributes
  // ─────────────────────────────────────────────────────────────

  registerTool<{ include_options: boolean }>(
    server,
    'attributes_list',
    {
      title: 'List Attributes',
      description:
        'List all available product attributes (system and custom). ' +
        'Returns attribute keys, types, labels, and options for dropdown fields. ' +
        'Use this to discover what attributes exist and their data types.',
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
  // attributes.get - Get full attribute details by label
  // ─────────────────────────────────────────────────────────────

  registerTool<{ label: string }>(
    server,
    'attributes_get',
    {
      title: 'Get Attribute',
      description:
        'Get full details for a single attribute by its label (snake_case identifier like "head_material"). ' +
        'Returns type, options (for dropdowns), groups, and other metadata. ' +
        'Use this to inspect a specific attribute or get its allowed values.',
      inputSchema: {
        label: z
          .string()
          .describe('Attribute label (snake_case identifier, e.g., "head_material")'),
      },
    },
    async ({ label }) => {
      try {
        const attr = await client.getAttributeByLabel(label);

        if (!attr) {
          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify({ error: 'not_found', label, message: `Attribute "${label}" not found` }, null, 2),
              },
            ],
          };
        }

        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(
                {
                  id: attr.id,
                  label: attr.label,
                  name: attr.name,
                  type_class: attr.type_class,
                  options: attr.options ?? [],
                  options_count: attr.options?.length ?? 0,
                  groups: attr.groups ?? [],
                  description: attr.description,
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
              text: `Error getting attribute: ${error instanceof Error ? error.message : 'Unknown error'}`,
            },
          ],
          isError: true,
        };
      }
    }
  );

  // ─────────────────────────────────────────────────────────────
  // attributes.get_options - Get allowed values for dropdown/multiselect
  // ─────────────────────────────────────────────────────────────

  registerTool<{ label: string }>(
    server,
    'attributes_get_options',
    {
      title: 'Get Attribute Options',
      description:
        'Get the allowed values (options) for a dropdown or multiselect attribute. ' +
        'Returns an array of valid option strings. ' +
        'Use this to validate enum values or sync options to external systems.',
      inputSchema: {
        label: z
          .string()
          .describe('Attribute label (snake_case identifier, e.g., "head_material")'),
      },
    },
    async ({ label }) => {
      try {
        const options = await client.getAttributeOptions(label);

        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(
                {
                  label,
                  options,
                  count: options.length,
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
              text: `Error getting attribute options: ${error instanceof Error ? error.message : 'Unknown error'}`,
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

  registerTool<Record<string, never>>(
    server,
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
