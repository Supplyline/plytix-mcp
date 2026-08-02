/**
 * Attribute Group Tools
 *
 * Full CRUD for product-attribute groups. Attribute groups are the
 * organizational units within a family — used for UI display ordering
 * and, eventually, per-role permission scoping.
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

export function registerAttributeGroupTools(server: McpServer, client: PlytixClient) {
  // ─────────────────────────────────────────────────────────────
  // attribute_groups.search
  // ─────────────────────────────────────────────────────────────

  registerTool<{ page: number; page_size: number }>(
    server,
    'attribute_groups_search',
    {
      title: 'Search Attribute Groups',
      description:
        'Search/list all product-attribute groups in the org. Returns id, name, attribute_labels, order.',
      inputSchema: {
        page: z.number().int().positive().default(1).describe('Page number'),
        page_size: z.number().int().positive().max(100).default(25).describe('Results per page'),
      },
    },
    async ({ page, page_size }) => {
      try {
        const result = await client.searchAttributeGroups({ pagination: { page, page_size } });
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(
                {
                  groups: result.data ?? [],
                  pagination: result.pagination ?? null,
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
              text: `Error searching attribute groups: ${error instanceof Error ? error.message : 'Unknown error'}`,
            },
          ],
          isError: true,
        };
      }
    }
  );

  // ─────────────────────────────────────────────────────────────
  // attribute_groups.get
  // ─────────────────────────────────────────────────────────────

  registerTool<{ group_id: string }>(
    server,
    'attribute_groups_get',
    {
      title: 'Get Attribute Group',
      description: 'Get a single attribute group by ID.',
      inputSchema: { group_id: z.string().describe('Attribute group ID') },
    },
    async ({ group_id }) => {
      try {
        const group = await client.getAttributeGroup(group_id);
        if (!group) {
          return {
            content: [{ type: 'text', text: `Attribute group not found: ${group_id}` }],
            isError: true,
          };
        }
        return {
          content: [{ type: 'text', text: JSON.stringify(group, null, 2) }],
        };
      } catch (error) {
        return {
          content: [
            {
              type: 'text',
              text: `Error fetching attribute group: ${error instanceof Error ? error.message : 'Unknown error'}`,
            },
          ],
          isError: true,
        };
      }
    }
  );

  // ─────────────────────────────────────────────────────────────
  // attribute_groups.create
  // ─────────────────────────────────────────────────────────────

  registerTool<{
    name: string;
    attribute_labels?: string[];
    order?: number;
  }>(
    server,
    'attribute_groups_create',
    {
      title: 'Create Attribute Group',
      description:
        'Create a new attribute group. Pass `name` and optionally `attribute_labels` ' +
        '(snake_case labels to assign to this group on creation) and `order` (display position).',
      inputSchema: {
        name: z.string().min(1).describe('Group display name (e.g., "Channel Readiness")'),
        attribute_labels: z
          .array(z.string())
          .optional()
          .describe('Snake_case attribute labels to include in this group'),
        order: z.number().int().optional().describe('Display order index'),
      },
    },
    async (args) => {
      try {
        const result = await client.createAttributeGroup({
          name: args.name,
          attribute_labels: args.attribute_labels,
          order: args.order,
        });
        const group = result.data?.[0];
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(
                {
                  success: true,
                  id: group?.id,
                  name: group?.name,
                  attribute_labels: group?.attribute_labels ?? [],
                  order: group?.order,
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
              text: `Error creating attribute group: ${error instanceof Error ? error.message : 'Unknown error'}`,
            },
          ],
          isError: true,
        };
      }
    }
  );

  // ─────────────────────────────────────────────────────────────
  // attribute_groups.update
  // ─────────────────────────────────────────────────────────────

  registerTool<{
    group_id: string;
    name?: string;
    attribute_labels?: string[];
    order?: number;
  }>(
    server,
    'attribute_groups_update',
    {
      title: 'Update Attribute Group',
      description:
        'Update an attribute group. Can change `name`, replace `attribute_labels` (full set, not delta), ' +
        'or change `order`. Provide only the fields you want to change.',
      inputSchema: {
        group_id: z.string().describe('Attribute group ID'),
        name: z.string().min(1).optional().describe('New name'),
        attribute_labels: z
          .array(z.string())
          .optional()
          .describe('Full replacement set of attribute labels'),
        order: z.number().int().optional().describe('New display order'),
      },
    },
    async ({ group_id, name, attribute_labels, order }) => {
      try {
        const data: { name?: string; attribute_labels?: string[]; order?: number } = {};
        if (name !== undefined) data.name = name;
        if (attribute_labels !== undefined) data.attribute_labels = attribute_labels;
        if (order !== undefined) data.order = order;
        const result = await client.updateAttributeGroup(group_id, data);
        const group = result.data?.[0];
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(
                {
                  success: true,
                  id: group?.id ?? group_id,
                  name: group?.name,
                  attribute_labels: group?.attribute_labels ?? [],
                  order: group?.order,
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
              text: `Error updating attribute group: ${error instanceof Error ? error.message : 'Unknown error'}`,
            },
          ],
          isError: true,
        };
      }
    }
  );

  // ─────────────────────────────────────────────────────────────
  // attribute_groups.delete
  // ─────────────────────────────────────────────────────────────

  registerTool<{ group_id: string; dry_run?: boolean; confirm_token?: string }>(
    server,
    'attribute_groups_delete',
    {
      title: 'Delete Attribute Group (two-step)',
      description:
        'Delete an attribute group. TWO-STEP GATE: dry_run:true first → confirm_token to execute. ' +
        `Session cap: ${MAX_DELETES_PER_SESSION} deletes per MCP process. ` +
        'Attributes in the group are NOT deleted — they just lose their group assignment. ' +
        'You MUST surface the preview to the user and get explicit confirmation before executing.',
      inputSchema: {
        group_id: z.string().describe('Attribute group ID'),
        dry_run: z.boolean().optional(),
        confirm_token: z.string().optional(),
      },
    },
    async ({ group_id, dry_run, confirm_token }) => {
      try {
        const group = await client.getAttributeGroup(group_id);
        if (!group) {
          return {
            content: [{ type: 'text', text: `Attribute group not found: ${group_id}` }],
            isError: true,
          };
        }
        const preview = {
          id: group_id,
          name: group.name,
          attribute_labels: group.attribute_labels ?? [],
        };
        if (dry_run) {
          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify(makeDryRunResult('attribute_groups_delete', group_id, preview), null, 2),
              },
            ],
          };
        }
        const tokenCheck = consumeToken('attribute_groups_delete', group_id, confirm_token);
        if (!tokenCheck.ok) return { content: [{ type: 'text', text: tokenCheck.reason }], isError: true };
        const capCheck = sessionCapAvailable();
        if (!capCheck.ok) return { content: [{ type: 'text', text: capCheck.reason }], isError: true };

        const deleted = await client.deleteAttributeGroup(group_id);
        const count = recordDelete();
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(
                {
                  success: true,
                  deleted,
                  id: group_id,
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
              text: `Error deleting attribute group: ${error instanceof Error ? error.message : 'Unknown error'}`,
            },
          ],
          isError: true,
        };
      }
    }
  );
}
