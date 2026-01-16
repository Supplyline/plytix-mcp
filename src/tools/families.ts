/**
 * Product Family Tools
 *
 * Tools for listing and retrieving product families and their attributes.
 * Useful for understanding inheritance structure and attribute assignments.
 */

import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { PlytixClient } from '../client.js';

export function registerFamilyTools(server: McpServer, client: PlytixClient) {
  // ─────────────────────────────────────────────────────────────
  // families.list - Search/list product families
  // ─────────────────────────────────────────────────────────────

  server.registerTool(
    'families_list',
    {
      title: 'List Product Families',
      description:
        'List or search product families. Returns family IDs, names, and linked attributes. ' +
        'Use this to understand the family structure for inheritance tracking.',
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

  server.registerTool(
    'families_get',
    {
      title: 'Get Product Family',
      description:
        'Get a single product family by ID. Returns the family name, linked attributes, ' +
        'and parent family (if any) for understanding inheritance.',
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
}
