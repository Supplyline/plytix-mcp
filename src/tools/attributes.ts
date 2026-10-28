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
import { attributesCreate, attributesDelete, attributesUpdate } from '../schema-write-ops.js';
import { ATTRIBUTE_LEVELS, ATTRIBUTE_TYPE_CLASSES } from '../schema-writes.js';

const completenessAttributeSchema = z.object({
  id: z.string().nullable().describe('Attribute ID (null for system attributes such as sku)'),
  label: z.string().min(1).describe('Attribute label'),
});

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

  // ─────────────────────────────────────────────────────────────
  // attributes_create - Create a product attribute definition
  // ─────────────────────────────────────────────────────────────

  registerTool<{
    name: string;
    type_class: (typeof ATTRIBUTE_TYPE_CLASSES)[number];
    description?: string;
    options?: string[];
    manual_sorting?: boolean;
    sort_ascending?: boolean;
    product_families?: Array<{ id: string; attribute_level?: (typeof ATTRIBUTE_LEVELS)[number] }>;
    attributes?: Array<{ id: string | null; label: string }>;
  }>(
    server,
    'attributes_create',
    {
      title: 'Create Attribute',
      description:
        'Create a product attribute definition. Plytix derives the snake_case label from the name. options/manual_sorting/sort_ascending apply to DropdownAttribute and MultiSelectAttribute; attributes applies to CompletenessAttribute.',
      inputSchema: {
        name: z.string().min(1).describe('Display name, e.g. "Head Material"'),
        type_class: z.enum(ATTRIBUTE_TYPE_CLASSES).describe('Attribute type'),
        description: z.string().optional().describe('Help text shown to editors'),
        options: z
          .array(z.string().min(1))
          .optional()
          .describe('Allowed values (DropdownAttribute / MultiSelectAttribute only)'),
        manual_sorting: z
          .boolean()
          .optional()
          .describe('true keeps options in the given order; false sorts them alphabetically (default true)'),
        sort_ascending: z
          .boolean()
          .optional()
          .describe('Sort direction when manual_sorting is false (default true)'),
        product_families: z
          .array(
            z.object({
              id: z.string().min(1).describe('Family ID'),
              attribute_level: z
                .enum(ATTRIBUTE_LEVELS)
                .optional()
                .describe('no_level (default), parent_level or variant_level'),
            })
          )
          .optional()
          .describe('Families to link the new attribute to'),
        attributes: z
          .array(completenessAttributeSchema)
          .optional()
          .describe('CompletenessAttribute only: the attributes it tracks'),
      },
    },
    async (input) => attributesCreate(client, input)
  );

  // ─────────────────────────────────────────────────────────────
  // attributes_update - Patch name/description/options
  // ─────────────────────────────────────────────────────────────

  registerTool<{
    label: string;
    name?: string;
    description?: string;
    options?: string[];
    add_options?: string[];
    remove_options?: string[];
    renamed_options?: Record<string, string>;
    attributes?: Array<{ id: string | null; label: string }>;
  }>(
    server,
    'attributes_update',
    {
      title: 'Update Attribute',
      description:
        'Update an attribute definition: name, description, and on dropdown/multiselect its options. Use add_options/remove_options/renamed_options to edit incrementally, or options to replace the full list. renamed_options keeps product values attached through a rename.',
      inputSchema: {
        label: z.string().min(1).describe('Attribute label (snake_case identifier)'),
        name: z.string().min(1).optional().describe('New display name'),
        description: z.string().optional().describe('New description'),
        options: z
          .array(z.string().min(1))
          .optional()
          .describe('Full replacement option list (cannot be combined with add_options/remove_options)'),
        add_options: z.array(z.string().min(1)).optional().describe('Options to append'),
        remove_options: z
          .array(z.string().min(1))
          .optional()
          .describe('Options to remove (products using them lose that value)'),
        renamed_options: z
          .record(z.string().min(1), z.string().min(1))
          .optional()
          .describe('Map of old option value -> new value; products keep their selection'),
        attributes: z
          .array(completenessAttributeSchema)
          .optional()
          .describe('CompletenessAttribute only: replace the tracked attributes'),
      },
    },
    async (input) => attributesUpdate(client, input)
  );

  // ─────────────────────────────────────────────────────────────
  // attributes_delete - Delete an attribute definition (gated)
  // ─────────────────────────────────────────────────────────────

  registerTool<{ label: string; dry_run?: boolean; confirm_token?: string }>(
    server,
    'attributes_delete',
    {
      title: 'Delete Attribute',
      description:
        'Delete an attribute definition and every product value for it. Two-step: call with dry_run: true to get a preview and confirm_token, then call again with the token. Plytix refuses while an e-catalog, channel or PDF catalog uses the attribute.',
      inputSchema: {
        label: z.string().min(1).describe('Attribute label (snake_case identifier)'),
        dry_run: z.boolean().optional().describe('Preview and get a confirm_token without deleting'),
        confirm_token: z.string().optional().describe('Token from the dry run; required to execute'),
      },
    },
    async (input) => attributesDelete(client, input)
  );
}
