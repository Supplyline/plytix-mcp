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
      description: 'List product attributes.',
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
            key: attr.key ?? attr.field,
            label: attr.label,
            type: attr.filter_type ?? attr.type,
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
      description: 'Get one attribute.',
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
      description: 'List allowed values for an attribute.',
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
  // attributes.filters - Deprecated alias for product search filters
  // ─────────────────────────────────────────────────────────────

  registerTool<Record<string, never>>(
    server,
    'attributes_filters',
    {
      title: 'Get Search Filters (Deprecated)',
      description: 'Deprecated alias for product filters.',
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
                  deprecated: true,
                  message: 'Use products_filters, assets_filters, or relationships_filters instead.',
                  replacement_tools: ['products_filters', 'assets_filters', 'relationships_filters'],
                  resource: 'products',
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

  // ─────────────────────────────────────────────────────────────
  // products_filters - Product filter discovery
  // ─────────────────────────────────────────────────────────────

  registerTool<Record<string, never>>(
    server,
    'products_filters',
    {
      title: 'Product Search Filters',
      description: 'List product search filters.',
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
                  resource: 'products',
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
              text: `Error fetching product filters: ${error instanceof Error ? error.message : 'Unknown error'}`,
            },
          ],
          isError: true,
        };
      }
    }
  );

  // ─────────────────────────────────────────────────────────────
  // assets_filters - Asset filter discovery
  // ─────────────────────────────────────────────────────────────

  registerTool<Record<string, never>>(
    server,
    'assets_filters',
    {
      title: 'Asset Search Filters',
      description: 'List asset search filters.',
      inputSchema: {},
    },
    async () => {
      try {
        const result = await client.getAssetFilters();

        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(
                {
                  resource: 'assets',
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
              text: `Error fetching asset filters: ${error instanceof Error ? error.message : 'Unknown error'}`,
            },
          ],
          isError: true,
        };
      }
    }
  );

  // ─────────────────────────────────────────────────────────────
  // relationships_filters - Relationship filter discovery
  // ─────────────────────────────────────────────────────────────

  registerTool<Record<string, never>>(
    server,
    'relationships_filters',
    {
      title: 'Relationship Search Filters',
      description: 'List relationship search filters.',
      inputSchema: {},
    },
    async () => {
      try {
        const result = await client.getRelationshipFilters();

        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(
                {
                  resource: 'relationships',
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
              text: `Error fetching relationship filters: ${error instanceof Error ? error.message : 'Unknown error'}`,
            },
          ],
          isError: true,
        };
      }
    }
  );
}
