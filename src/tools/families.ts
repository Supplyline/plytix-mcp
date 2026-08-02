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
import {
  makeDryRunResult,
  consumeToken,
  sessionCapAvailable,
  recordDelete,
  MAX_DELETES_PER_SESSION,
} from '../safety.js';

export function registerFamilyTools(server: McpServer, client: PlytixClient) {
  // ─────────────────────────────────────────────────────────────
  // families.list - Search/list product families
  // ─────────────────────────────────────────────────────────────

  registerTool<{ query?: string; page: number; page_size: number }>(
    server,
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

  registerTool<{ family_id: string }>(
    server,
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

  // ─────────────────────────────────────────────────────────────
  // families.create
  // ─────────────────────────────────────────────────────────────

  registerTool<{
    name: string;
    attribute_ids?: string[];
    parent_attribute_ids?: string[];
  }>(
    server,
    'families_create',
    {
      title: 'Create Family',
      description:
        'Create a new product family. Pass `name` and optionally `attribute_ids` (variant-level attrs) ' +
        'and `parent_attribute_ids` (parent-level attrs). Returns the new family ID.',
      inputSchema: {
        name: z.string().min(1).describe('Family name (e.g., "Interior Products")'),
        attribute_ids: z.array(z.string()).optional().describe('Attribute IDs to link as variant-level'),
        parent_attribute_ids: z.array(z.string()).optional().describe('Attribute IDs to link at parent level'),
      },
    },
    async (args) => {
      try {
        const result = await client.createFamily({
          name: args.name,
          attribute_ids: args.attribute_ids,
          parent_attribute_ids: args.parent_attribute_ids,
        });
        const fam = result.data?.[0];
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({ success: true, id: fam?.id, name: fam?.name }, null, 2),
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
  // families.update (rename)
  // ─────────────────────────────────────────────────────────────

  registerTool<{ family_id: string; name: string }>(
    server,
    'families_update',
    {
      title: 'Rename Family',
      description:
        'Rename a product family. Plytix only supports renaming via PATCH; to change attributes, ' +
        'use families_link_attributes / families_unlink_attributes.',
      inputSchema: {
        family_id: z.string().describe('Family ID'),
        name: z.string().min(1).describe('New family name'),
      },
    },
    async ({ family_id, name }) => {
      try {
        const result = await client.updateFamily(family_id, { name });
        const fam = result.data?.[0];
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({ success: true, id: fam?.id ?? family_id, name: fam?.name ?? name }, null, 2),
            },
          ],
        };
      } catch (error) {
        return {
          content: [
            {
              type: 'text',
              text: `Error renaming family: ${error instanceof Error ? error.message : 'Unknown error'}`,
            },
          ],
          isError: true,
        };
      }
    }
  );

  // ─────────────────────────────────────────────────────────────
  // families.delete
  // ─────────────────────────────────────────────────────────────

  registerTool<{ family_id: string; dry_run?: boolean; confirm_token?: string }>(
    server,
    'families_delete',
    {
      title: 'Delete Family (two-step)',
      description:
        'Delete a product family. TWO-STEP GATE: first call with dry_run:true to get preview + token; ' +
        'then call again with confirm_token to execute. ' +
        `Session cap: ${MAX_DELETES_PER_SESSION} deletes per MCP process. ` +
        'WARNING: products in the family become family-less, breaking their attribute associations. ' +
        'You MUST surface the preview to the user and get explicit confirmation before executing.',
      inputSchema: {
        family_id: z.string().describe('Family ID'),
        dry_run: z.boolean().optional().describe('When true: return preview without deleting'),
        confirm_token: z.string().optional().describe('Token from a prior dry_run call'),
      },
    },
    async ({ family_id, dry_run, confirm_token }) => {
      try {
        const famResult = await client.getFamily(family_id);
        const fam = famResult.data?.[0];
        if (!fam) {
          return {
            content: [{ type: 'text', text: `Family not found: ${family_id}` }],
            isError: true,
          };
        }

        const preview = {
          id: family_id,
          name: fam.name,
          total_attributes: (fam as { total_attributes?: number }).total_attributes ?? null,
          total_products: (fam as { total_products?: number }).total_products ?? null,
        };

        if (dry_run) {
          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify(
                  makeDryRunResult('families_delete', family_id, preview),
                  null,
                  2
                ),
              },
            ],
          };
        }

        const tokenCheck = consumeToken('families_delete', family_id, confirm_token);
        if (!tokenCheck.ok) return { content: [{ type: 'text', text: tokenCheck.reason }], isError: true };
        const capCheck = sessionCapAvailable();
        if (!capCheck.ok) return { content: [{ type: 'text', text: capCheck.reason }], isError: true };

        const deleted = await client.deleteFamily(family_id);
        const count = recordDelete();
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(
                {
                  success: true,
                  deleted,
                  id: family_id,
                  name: fam.name,
                  session_deletes_used: count,
                  session_deletes_remaining: MAX_DELETES_PER_SESSION - count,
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
              text: `Error deleting family: ${error instanceof Error ? error.message : 'Unknown error'}`,
            },
          ],
          isError: true,
        };
      }
    }
  );

  // ─────────────────────────────────────────────────────────────
  // families.link_attributes
  // ─────────────────────────────────────────────────────────────

  registerTool<{
    family_id: string;
    attribute_ids?: string[];
    attribute_labels?: string[];
    attributes_level?: string;
  }>(
    server,
    'families_link_attributes',
    {
      title: 'Link Attributes to Family',
      description:
        'Link one or more existing attributes to a family. ' +
        'Pass either `attribute_ids` directly OR `attribute_labels` (resolved to IDs via cache). ' +
        '`attributes_level`: "no_level" (default, no model linking), "parent_level" (typical for product-level attrs), or "variant_level". Plytix uses lowercase-with-underscores; OFF/PARENT/etc are rejected with a 422 schema error. ' +
        'This is how to bring "orphan" attributes (created at org level) into a family\'s attribute set.',
      inputSchema: {
        family_id: z.string().describe('Family ID'),
        attribute_ids: z.array(z.string()).optional().describe('Attribute IDs (preferred)'),
        attribute_labels: z.array(z.string()).optional().describe('Snake_case labels (resolved to IDs)'),
        attributes_level: z
          .string()
          .optional()
          .default('OFF')
          .describe('"no_level" | "parent_level" | "variant_level"'),
      },
    },
    async ({ family_id, attribute_ids, attribute_labels, attributes_level }) => {
      try {
        const ids = [...(attribute_ids ?? [])];
        const missing: string[] = [];
        if (attribute_labels) {
          for (const lbl of attribute_labels) {
            const a = await client.getAttributeByLabel(lbl);
            if (a?.id) ids.push(a.id);
            else missing.push(lbl);
          }
        }
        if (missing.length) {
          return {
            content: [{ type: 'text', text: `Attribute label(s) not found: ${missing.join(', ')}` }],
            isError: true,
          };
        }
        if (!ids.length) {
          return {
            content: [{ type: 'text', text: 'Provide at least one attribute_id or attribute_label.' }],
            isError: true,
          };
        }

        await client.linkAttributesToFamily(family_id, ids, attributes_level ?? 'no_level');
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(
                {
                  success: true,
                  family_id,
                  linked_attribute_ids: ids,
                  attributes_level: attributes_level ?? 'no_level',
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
              text: `Error linking attributes: ${error instanceof Error ? error.message : 'Unknown error'}`,
            },
          ],
          isError: true,
        };
      }
    }
  );

  // ─────────────────────────────────────────────────────────────
  // families.unlink_attributes
  // ─────────────────────────────────────────────────────────────

  registerTool<{
    family_id: string;
    attribute_ids?: string[];
    attribute_labels?: string[];
  }>(
    server,
    'families_unlink_attributes',
    {
      title: 'Unlink Attributes from Family',
      description:
        'Unlink one or more attributes from a family. The attributes themselves are not deleted — ' +
        'they just stop being part of this family\'s attribute set. Products in the family lose those attribute values.',
      inputSchema: {
        family_id: z.string().describe('Family ID'),
        attribute_ids: z.array(z.string()).optional().describe('Attribute IDs (preferred)'),
        attribute_labels: z.array(z.string()).optional().describe('Snake_case labels (resolved to IDs)'),
      },
    },
    async ({ family_id, attribute_ids, attribute_labels }) => {
      try {
        const ids = [...(attribute_ids ?? [])];
        const missing: string[] = [];
        if (attribute_labels) {
          for (const lbl of attribute_labels) {
            const a = await client.getAttributeByLabel(lbl);
            if (a?.id) ids.push(a.id);
            else missing.push(lbl);
          }
        }
        if (missing.length) {
          return {
            content: [{ type: 'text', text: `Attribute label(s) not found: ${missing.join(', ')}` }],
            isError: true,
          };
        }
        if (!ids.length) {
          return {
            content: [{ type: 'text', text: 'Provide at least one attribute_id or attribute_label.' }],
            isError: true,
          };
        }

        await client.unlinkAttributesFromFamily(family_id, ids);
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(
                { success: true, family_id, unlinked_attribute_ids: ids },
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
              text: `Error unlinking attributes: ${error instanceof Error ? error.message : 'Unknown error'}`,
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
