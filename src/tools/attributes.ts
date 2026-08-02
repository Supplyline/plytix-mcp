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
import {
  makeDryRunResult,
  consumeToken,
  sessionCapAvailable,
  recordDelete,
  getSessionDeleteCount,
  MAX_DELETES_PER_SESSION,
} from '../safety.js';

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
  // attributes.create - Create a new product attribute
  // ─────────────────────────────────────────────────────────────

  registerTool<{
    name: string;
    type_class: string;
    description?: string;
    options?: string[];
    family_ids?: string[];
    attribute_level?: string;
    contributing_attribute_labels?: string[];
    manual_sorting?: boolean;
    sort_ascending?: boolean;
  }>(
    server,
    'attributes_create',
    {
      title: 'Create Attribute',
      description:
        'Create a new product attribute. Provide the display name and type_class. ' +
        'Common type_class values: TextAttribute (Short Text), MultilineAttribute (Paragraph), ' +
        'HtmlAttribute, IntAttribute, DecimalAttribute, DropdownAttribute (requires options), ' +
        'MultiSelectAttribute (requires options), DateAttribute, UrlAttribute, BooleanAttribute, ' +
        'MediaAttribute, MediaGalleryAttribute, CompletenessAttribute (requires contributing_attribute_labels). ' +
        'Snake_case label is auto-generated by Plytix from the name. ' +
        'Optionally bind to one or more families on creation via family_ids + attribute_level.',
      inputSchema: {
        name: z.string().min(1).describe('Display name (e.g., "Fitment Last Reviewed")'),
        type_class: z
          .string()
          .describe('Type class string (e.g., "DateAttribute", "DecimalAttribute")'),
        description: z.string().optional().describe('Optional description shown in Plytix UI'),
        options: z
          .array(z.string())
          .optional()
          .describe('For Dropdown/MultiSelect: the allowed values'),
        family_ids: z
          .array(z.string())
          .optional()
          .describe('Optional list of family IDs to bind the new attribute to'),
        attribute_level: z
          .string()
          .optional()
          .default('OFF')
          .describe(
            'Inheritance level when binding to families: "no_level" (default, no model linking), "parent_level", or "variant_level". (Plytix uses lowercase-with-underscores; OFF/PARENT/etc are NOT accepted.)'
          ),
        contributing_attribute_labels: z
          .array(z.string())
          .optional()
          .describe(
            'For CompletenessAttribute: snake_case labels of the contributing attributes (these resolve to {id, label} pairs server-side via the cache)'
          ),
        manual_sorting: z
          .boolean()
          .optional()
          .describe('Dropdown/MultiSelect: present options in manual sort order instead of alpha'),
        sort_ascending: z
          .boolean()
          .optional()
          .describe('Dropdown/MultiSelect: alphabetical sort direction'),
      },
    },
    async (args) => {
      try {
        const data: Parameters<typeof client.createAttribute>[0] = {
          name: args.name,
          type_class: args.type_class,
        };
        if (args.description) data.description = args.description;
        if (args.options && args.options.length) data.options = args.options;
        if (args.manual_sorting !== undefined) data.manual_sorting = args.manual_sorting;
        if (args.sort_ascending !== undefined) data.sort_ascending = args.sort_ascending;
        if (args.family_ids && args.family_ids.length) {
          const level = args.attribute_level ?? 'no_level';
          data.product_families = args.family_ids.map((id) => ({ id, attribute_level: level }));
        }
        if (args.contributing_attribute_labels && args.contributing_attribute_labels.length) {
          const resolved: Array<{ id: string; label: string }> = [];
          const missing: string[] = [];
          for (const lbl of args.contributing_attribute_labels) {
            const a = await client.getAttributeByLabel(lbl);
            if (a?.id) resolved.push({ id: a.id, label: lbl });
            else missing.push(lbl);
          }
          if (missing.length) {
            return {
              content: [
                {
                  type: 'text',
                  text: `Cannot create — contributing attribute label(s) not found: ${missing.join(', ')}`,
                },
              ],
              isError: true,
            };
          }
          data.attributes = resolved;
        }

        const result = await client.createAttribute(data);
        const attr = result.data?.[0];
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(
                {
                  success: true,
                  id: attr?.id,
                  label: attr?.label,
                  name: attr?.name,
                  type_class: attr?.type_class,
                  options: attr?.options ?? [],
                  description: attr?.description,
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
              text: `Error creating attribute: ${error instanceof Error ? error.message : 'Unknown error'}`,
            },
          ],
          isError: true,
        };
      }
    }
  );

  // ─────────────────────────────────────────────────────────────
  // attributes.update - Rename an existing attribute
  // ─────────────────────────────────────────────────────────────

  registerTool<{ attribute_id?: string; label?: string; name: string }>(
    server,
    'attributes_update',
    {
      title: 'Rename Attribute',
      description:
        'Rename a product attribute (update its display name). Plytix only supports renaming via PATCH — ' +
        'type, options, etc. cannot be changed once created (use attributes_delete + attributes_create instead). ' +
        'Provide either attribute_id directly, OR label (which is resolved to id via cache).',
      inputSchema: {
        attribute_id: z.string().optional().describe('Plytix attribute ID (preferred)'),
        label: z
          .string()
          .optional()
          .describe('Snake_case label — used to look up the ID if attribute_id not given'),
        name: z.string().min(1).describe('New display name'),
      },
    },
    async ({ attribute_id, label, name }) => {
      try {
        let id = attribute_id;
        if (!id && label) {
          const a = await client.getAttributeByLabel(label);
          if (!a?.id) {
            return {
              content: [{ type: 'text', text: `Attribute not found by label: ${label}` }],
              isError: true,
            };
          }
          id = a.id;
        }
        if (!id) {
          return {
            content: [{ type: 'text', text: 'Provide attribute_id or label.' }],
            isError: true,
          };
        }

        const result = await client.updateAttribute(id, { name });
        const attr = result.data?.[0];
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(
                {
                  success: true,
                  id: attr?.id ?? id,
                  label: attr?.label,
                  name: attr?.name ?? name,
                  type_class: attr?.type_class,
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
              text: `Error updating attribute: ${error instanceof Error ? error.message : 'Unknown error'}`,
            },
          ],
          isError: true,
        };
      }
    }
  );

  // ─────────────────────────────────────────────────────────────
  // attributes.delete - Delete an attribute by ID or label
  // ─────────────────────────────────────────────────────────────

  registerTool<{
    attribute_id?: string;
    label?: string;
    dry_run?: boolean;
    confirm_token?: string;
  }>(
    server,
    'attributes_delete',
    {
      title: 'Delete Attribute (two-step)',
      description:
        'Delete a product attribute. TWO-STEP GATE: first call with dry_run:true to get a preview + confirm_token; ' +
        'then call AGAIN with the same identifier AND confirm_token to execute. ' +
        `Session cap: ${MAX_DELETES_PER_SESSION} successful deletes per MCP process before lockout (restart to reset). ` +
        'WARNING: any product values stored on this attribute will be permanently lost. ' +
        'You MUST surface the dry_run preview to the user and get explicit confirmation before calling with confirm_token.',
      inputSchema: {
        attribute_id: z.string().optional().describe('Plytix attribute ID (preferred)'),
        label: z
          .string()
          .optional()
          .describe('Snake_case label — used to look up the ID if attribute_id not given'),
        dry_run: z
          .boolean()
          .optional()
          .describe('When true: return preview + confirm_token without deleting. Required as first call.'),
        confirm_token: z
          .string()
          .optional()
          .describe('Token from a prior dry_run call. Required for actual execution.'),
      },
    },
    async ({ attribute_id, label, dry_run, confirm_token }) => {
      try {
        let id = attribute_id;
        const attr = id
          ? await client.getAttributeById(id)
          : label
            ? await client.getAttributeByLabel(label)
            : null;
        if (!attr?.id) {
          return {
            content: [
              {
                type: 'text',
                text: `Attribute not found: ${attribute_id ?? label ?? '(neither id nor label given)'}`,
              },
            ],
            isError: true,
          };
        }
        id = attr.id;

        const preview = {
          id,
          label: attr.label,
          name: attr.name,
          type_class: attr.type_class,
          groups: attr.groups ?? [],
        };

        if (dry_run) {
          return {
            content: [
              { type: 'text', text: JSON.stringify(makeDryRunResult('attributes_delete', id, preview), null, 2) },
            ],
          };
        }

        const tokenCheck = consumeToken('attributes_delete', id, confirm_token);
        if (!tokenCheck.ok) {
          return { content: [{ type: 'text', text: tokenCheck.reason }], isError: true };
        }
        const capCheck = sessionCapAvailable();
        if (!capCheck.ok) {
          return { content: [{ type: 'text', text: capCheck.reason }], isError: true };
        }

        const deleted = await client.deleteAttribute(id);
        const count = recordDelete();
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(
                {
                  success: true,
                  deleted,
                  id,
                  label: label ?? attr.label ?? null,
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
              text: `Error deleting attribute: ${error instanceof Error ? error.message : 'Unknown error'}`,
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
