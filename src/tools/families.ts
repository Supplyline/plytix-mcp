/**
 * Product Family Tools
 *
 * Tools for listing and retrieving product families and their attributes.
 * Useful for understanding inheritance structure and attribute assignments.
 */

import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { PlytixClient } from '../client.js';
import { registerTool } from './register.js';

export function registerFamilyTools(server: McpServer, client: PlytixClient) {
  // ─────────────────────────────────────────────────────────────
  // families.list - Search/list product families
  // ─────────────────────────────────────────────────────────────

  registerTool<{ query?: string; page: number; page_size: number }>(
    server,
    'families_list',
    {
      title: 'List Product Families',
      description: 'List product families.',
      inputSchema: {
        query: z.string().optional().describe('Search query to filter families by name'),
        page: z.number().int().positive().default(1).describe('Page number'),
        page_size: z.number().int().positive().max(100).default(25).describe('Results per page'),
      },
    },
    async ({ query, page, page_size }) => {
      try {
        const body: Record<string, unknown> = {
          pagination: { page, page_size },
        };

        if (query) {
          body.filters = [[{ field: 'name', operator: 'like', value: query }]];
        }

        const result = await client.searchFamilies(body);

        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(
                {
                  families: result.data,
                  pagination: result.pagination,
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
              text: `Error listing families: ${error instanceof Error ? error.message : 'Unknown error'}`,
            },
          ],
          isError: true,
        };
      }
    }
  );

  // ─────────────────────────────────────────────────────────────
  // families.get - Get single family with details
  // ─────────────────────────────────────────────────────────────

  registerTool<{ family_id: string }>(
    server,
    'families_get',
    {
      title: 'Get Product Family',
      description: 'Get one product family.',
      inputSchema: {
        family_id: z.string().min(1).describe('The product family ID'),
      },
    },
    async ({ family_id }) => {
      try {
        const result = await client.getFamily(family_id);

        if (!result.data?.[0]) {
          return {
            content: [{ type: 'text', text: `Family not found: ${family_id}` }],
            isError: true,
          };
        }

        return {
          content: [{ type: 'text', text: JSON.stringify(result.data[0], null, 2) }],
        };
      } catch (error) {
        return {
          content: [
            {
              type: 'text',
              text: `Error fetching family: ${error instanceof Error ? error.message : 'Unknown error'}`,
            },
          ],
          isError: true,
        };
      }
    }
  );

  // ─────────────────────────────────────────────────────────────
  // families_create - Create a product family
  // ─────────────────────────────────────────────────────────────

  registerTool<{ name: string; parent_id?: string }>(
    server,
    'families_create',
    {
      title: 'Create Product Family',
      description: 'Create a product family.',
      inputSchema: {
        name: z.string().min(1).describe('Name for the new family'),
        parent_id: z.string().optional().describe('Optional parent family ID'),
      },
    },
    async ({ name, parent_id }) => {
      try {
        const result = await client.createFamily({
          name,
          ...(parent_id !== undefined ? { parent_id } : {}),
        });
        const family = result.data?.[0];

        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(
                {
                  success: true,
                  action: 'created',
                  family: family ? { id: family.id, name: family.name } : undefined,
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
              text: `Error creating family: ${error instanceof Error ? error.message : 'Unknown error'}`,
            },
          ],
          isError: true,
        };
      }
    }
  );

  // ─────────────────────────────────────────────────────────────
  // families_link_attribute - Link one or more attributes
  // ─────────────────────────────────────────────────────────────

  registerTool<{ family_id: string; attribute_labels: string[] }>(
    server,
    'families_link_attribute',
    {
      title: 'Link Attributes to Family',
      description: 'Link attributes to a family.',
      inputSchema: {
        family_id: z.string().min(1).describe('The product family ID'),
        attribute_labels: z
          .array(z.string())
          .min(1)
          .describe('Attribute labels to link to the family'),
      },
    },
    async ({ family_id, attribute_labels }) => {
      try {
        await client.linkFamilyAttributes(family_id, attribute_labels);

        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(
                {
                  success: true,
                  action: 'linked',
                  family_id,
                  attribute_labels,
                  count: attribute_labels.length,
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
              text: `Error linking family attributes: ${error instanceof Error ? error.message : 'Unknown error'}`,
            },
          ],
          isError: true,
        };
      }
    }
  );

  // ─────────────────────────────────────────────────────────────
  // families_unlink_attribute - Unlink one or more attributes
  // ─────────────────────────────────────────────────────────────

  registerTool<{ family_id: string; attribute_labels: string[] }>(
    server,
    'families_unlink_attribute',
    {
      title: 'Unlink Attributes from Family',
      description: 'Unlink attributes from a family.',
      inputSchema: {
        family_id: z.string().min(1).describe('The product family ID'),
        attribute_labels: z
          .array(z.string())
          .min(1)
          .describe('Attribute labels to unlink from the family'),
      },
    },
    async ({ family_id, attribute_labels }) => {
      try {
        await client.unlinkFamilyAttributes(family_id, attribute_labels);

        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(
                {
                  success: true,
                  action: 'unlinked',
                  family_id,
                  attribute_labels,
                  count: attribute_labels.length,
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
              text: `Error unlinking family attributes: ${error instanceof Error ? error.message : 'Unknown error'}`,
            },
          ],
          isError: true,
        };
      }
    }
  );

  // ─────────────────────────────────────────────────────────────
  // families_list_attributes - Directly linked family attributes
  // ─────────────────────────────────────────────────────────────

  registerTool<{ family_id: string }>(
    server,
    'families_list_attributes',
    {
      title: 'List Family Attributes',
      description: 'List direct family attributes.',
      inputSchema: {
        family_id: z.string().min(1).describe('The product family ID'),
      },
    },
    async ({ family_id }) => {
      try {
        const result = await client.getFamilyAttributes(family_id);

        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(
                {
                  family_id,
                  attributes: result.data,
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
              text: `Error listing family attributes: ${error instanceof Error ? error.message : 'Unknown error'}`,
            },
          ],
          isError: true,
        };
      }
    }
  );

  // ─────────────────────────────────────────────────────────────
  // families_list_all_attributes - Direct + inherited family attributes
  // ─────────────────────────────────────────────────────────────

  registerTool<{ family_id: string }>(
    server,
    'families_list_all_attributes',
    {
      title: 'List All Family Attributes',
      description: 'List all family attributes.',
      inputSchema: {
        family_id: z.string().min(1).describe('The product family ID'),
      },
    },
    async ({ family_id }) => {
      try {
        const result = await client.getFamilyAllAttributes(family_id);

        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(
                {
                  family_id,
                  attributes: result.data,
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
              text: `Error listing all family attributes: ${error instanceof Error ? error.message : 'Unknown error'}`,
            },
          ],
          isError: true,
        };
      }
    }
  );
}
