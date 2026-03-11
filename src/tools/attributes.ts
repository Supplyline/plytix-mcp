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
        'List all product attributes (system and custom) with types and dropdown options.',
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
        'Get full details for one attribute by label — type, options, groups.',
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
            content: [{ type: 'text', text: `Attribute not found: ${label}` }],
            isError: true,
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
        'Get allowed values for a dropdown or multiselect attribute.',
      inputSchema: {
        label: z
          .string()
          .describe('Attribute label (snake_case identifier, e.g., "head_material")'),
      },
    },
    async ({ label }) => {
      try {
        const options = await client.getAttributeOptions(label);

        if (options === null) {
          return {
            content: [{ type: 'text', text: `Attribute not found: ${label}` }],
            isError: true,
          };
        }

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
        'Get available search filter fields, types, and operators.',
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
