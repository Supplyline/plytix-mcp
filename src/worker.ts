/**
 * Plytix MCP Server - Cloudflare Worker Entry Point
 *
 * Remote MCP server for Plytix PIM access.
 * Uses BYOK (Bring Your Own Key) model - API credentials come from request headers.
 *
 * Endpoints:
 * - POST /mcp - MCP JSON-RPC endpoint
 * - GET /health - Health check
 * - GET / - Server info
 */

import { WorkerPlytixClient } from './worker-client.js';
import { WorkerPlytixLookup } from './worker-lookup.js';
import { stripAttributesPrefix } from './utils/attribute-labels.js';
import { validateAttributeValue } from './utils/validate-attribute.js';

// ─────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────

interface Env {
  PLYTIX_API_BASE?: string;
  PLYTIX_AUTH_URL?: string;
}

interface JsonRpcRequest {
  jsonrpc: '2.0';
  id?: string | number | null;
  method: string;
  params?: Record<string, unknown>;
}

interface JsonRpcResponse {
  jsonrpc: '2.0';
  id: string | number | null;
  result?: unknown;
  error?: {
    code: number;
    message: string;
    data?: unknown;
  };
}

interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, unknown>;
    required?: string[];
  };
}

interface ToolHandler {
  (args: Record<string, unknown>, client: WorkerPlytixClient): Promise<{
    content: Array<{ type: string; text: string }>;
    isError?: boolean;
  }>;
}

// ─────────────────────────────────────────────────────────────
// CORS Configuration
// ─────────────────────────────────────────────────────────────

const ALLOWED_ORIGINS = [
  'https://claude.ai',
  'https://app.claude.ai',
  'https://console.anthropic.com',
  // Mobile app origins
  'capacitor://localhost',
  'ionic://localhost',
  'http://localhost',
  'http://localhost:3000',
  'http://localhost:5173',
  'http://localhost:8080',
];

function getCorsHeaders(request: Request): Record<string, string> {
  const origin = request.headers.get('Origin') || '';
  const headers: Record<string, string> = {
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, X-Plytix-API-Key, X-Plytix-API-Password, Authorization',
    'Access-Control-Max-Age': '86400',
  };

  // Only allow specific origins (Claude clients and local development)
  if (ALLOWED_ORIGINS.includes(origin) || origin.endsWith('.claude.ai')) {
    headers['Access-Control-Allow-Origin'] = origin;
  }
  // For requests without an allowed origin, don't set Access-Control-Allow-Origin
  // This will cause browsers to block cross-origin requests from unauthorized sites

  return headers;
}

// ─────────────────────────────────────────────────────────────
// Tool Definitions
// ─────────────────────────────────────────────────────────────

const TOOLS: ToolDefinition[] = [
  {
    name: 'products_lookup',
    description:
      'Smart product lookup that auto-detects identifier type (ID, SKU, MPN, GTIN, label). ' +
      'Returns best match with confidence scoring.',
    inputSchema: {
      type: 'object',
      properties: {
        identifier: {
          type: 'string',
          description: 'Product identifier (ID, SKU, MPN, GTIN, or label)',
        },
        type: {
          type: 'string',
          enum: ['id', 'sku', 'mpn', 'mno', 'gtin', 'label'],
          description: 'Explicit identifier type (auto-detected if not provided)',
        },
        limit: {
          type: 'number',
          description: 'Max results to return (default: 5, max: 20)',
          default: 5,
        },
      },
      required: ['identifier'],
    },
  },
  {
    name: 'products_get',
    description:
      'Get a single product by ID with full attributes and inheritance metadata.',
    inputSchema: {
      type: 'object',
      properties: {
        product_id: {
          type: 'string',
          description: 'The product ID to fetch',
        },
      },
      required: ['product_id'],
    },
  },
  {
    name: 'products_get_full',
    description:
      'Get product with all related data (family, variants, categories, assets) in one call.',
    inputSchema: {
      type: 'object',
      properties: {
        product_id: {
          type: 'string',
          description: 'The product ID to fetch',
        },
      },
      required: ['product_id'],
    },
  },
  {
    name: 'products_search',
    description: 'Search products with filters, pagination, and sorting.',
    inputSchema: {
      type: 'object',
      properties: {
        attributes: {
          type: 'array',
          items: { type: 'string' },
          description: 'List of attributes to return (max 50)',
        },
        filters: {
          type: 'array',
          description: 'Search filters. Format: [[{field, operator, value}]]',
        },
        pagination: {
          type: 'object',
          properties: {
            page: { type: 'number', default: 1 },
            page_size: { type: 'number', default: 25 },
          },
        },
        sort: {
          description: 'Sorting options',
        },
      },
    },
  },
  {
    name: 'products_find',
    description:
      'Find products by SKU, MPN, MNO, GTIN, label, or fuzzy text search.',
    inputSchema: {
      type: 'object',
      properties: {
        sku: { type: 'string', description: 'Exact SKU match' },
        mpn: { type: 'string', description: 'Manufacturer part number' },
        mno: { type: 'string', description: 'Model number' },
        gtin: { type: 'string', description: 'GTIN/UPC/EAN' },
        label: { type: 'string', description: 'Product label (partial match)' },
        fuzzy_search: { type: 'string', description: 'Fuzzy text search across all fields' },
        limit: { type: 'number', default: 10, description: 'Max results' },
      },
    },
  },
  {
    name: 'families_list',
    description: 'List or search product families with linked attributes.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Search query to filter families by name' },
        page: { type: 'number', default: 1 },
        page_size: { type: 'number', default: 25 },
      },
    },
  },
  {
    name: 'families_get',
    description:
      'Get a single product family by ID with linked attributes and parent info.',
    inputSchema: {
      type: 'object',
      properties: {
        family_id: { type: 'string', description: 'The product family ID' },
      },
      required: ['family_id'],
    },
  },
  {
    name: 'attributes_list',
    description:
      'List all product attributes (system and custom) with types and dropdown options.',
    inputSchema: {
      type: 'object',
      properties: {
        include_options: {
          type: 'boolean',
          default: true,
          description: 'Include dropdown/multiselect options in response',
        },
      },
    },
  },
  {
    name: 'attributes_get',
    description:
      'Get full details for one attribute by label — type, options, groups.',
    inputSchema: {
      type: 'object',
      properties: {
        label: {
          type: 'string',
          description: 'Attribute label (snake_case identifier, e.g., "head_material")',
        },
      },
      required: ['label'],
    },
  },
  {
    name: 'attributes_get_options',
    description:
      'Get allowed values for a dropdown or multiselect attribute.',
    inputSchema: {
      type: 'object',
      properties: {
        label: {
          type: 'string',
          description: 'Attribute label (snake_case identifier, e.g., "head_material")',
        },
      },
      required: ['label'],
    },
  },
  {
    name: 'attributes_filters',
    description: 'Get all available search filters for product queries.',
    inputSchema: {
      type: 'object',
      properties: {},
    },
  },
  {
    name: 'products_set_attribute',
    description:
      'Set a single product attribute value. Validates against attribute schema.',
    inputSchema: {
      type: 'object',
      properties: {
        product_id: { type: 'string', description: 'The product ID to update' },
        attribute_label: { type: 'string', description: 'Attribute label (snake_case)' },
        value: { description: 'Attribute value to set' },
      },
      required: ['product_id', 'attribute_label', 'value'],
    },
  },
  {
    name: 'products_clear_attribute',
    description: 'Clear a single product attribute value (set to null).',
    inputSchema: {
      type: 'object',
      properties: {
        product_id: { type: 'string', description: 'The product ID to update' },
        attribute_label: { type: 'string', description: 'Attribute label (snake_case)' },
      },
      required: ['product_id', 'attribute_label'],
    },
  },
  {
    name: 'products_create',
    description: 'Create a new product (SKU required).',
    inputSchema: {
      type: 'object',
      properties: {
        sku: { type: 'string', description: 'Product SKU (required, must be unique)' },
        label: { type: 'string', description: 'Product label/name' },
        status: { type: 'string', description: 'Product status' },
        attributes: {
          type: 'object',
          description: 'Custom attributes as key-value pairs (use attribute labels as keys)',
        },
        category_ids: {
          type: 'array',
          items: { type: 'string' },
          description: 'Category IDs to link to this product',
        },
        asset_ids: {
          type: 'array',
          items: { type: 'string' },
          description: 'Asset IDs to link to this product',
        },
      },
      required: ['sku'],
    },
  },
  {
    name: 'products_update',
    description: 'Partial update — only specified fields are changed.',
    inputSchema: {
      type: 'object',
      properties: {
        product_id: { type: 'string', description: 'The product ID to update' },
        label: { type: 'string', description: 'New product label/name' },
        status: { type: 'string', description: 'New product status' },
        attributes: {
          type: 'object',
          description: 'Attributes to update (use attribute labels as keys, null to clear)',
        },
      },
      required: ['product_id'],
    },
  },
  {
    name: 'products_assign_family',
    description:
      'Assign or unassign a product family. Pass empty string to unassign.',
    inputSchema: {
      type: 'object',
      properties: {
        product_id: { type: 'string', description: 'The product ID' },
        family_id: {
          type: 'string',
          description: 'The family ID to assign (empty string to unassign)',
        },
      },
      required: ['product_id', 'family_id'],
    },
  },
  {
    name: 'assets_list',
    description: 'List assets linked to a product (Plytix v2)',
    inputSchema: {
      type: 'object',
      properties: {
        product_id: { type: 'string', description: 'The product ID' },
      },
      required: ['product_id'],
    },
  },
  {
    name: 'assets_link',
    description: 'Link an existing asset to a product.',
    inputSchema: {
      type: 'object',
      properties: {
        product_id: { type: 'string', description: 'The product ID' },
        asset_id: { type: 'string', description: 'The asset ID to link' },
        attribute_label: {
          type: 'string',
          description: 'Optional media attribute label to assign the asset to',
        },
      },
      required: ['product_id', 'asset_id'],
    },
  },
  {
    name: 'assets_unlink',
    description: 'Remove an asset link from a product. The asset itself is not deleted.',
    inputSchema: {
      type: 'object',
      properties: {
        product_id: { type: 'string', description: 'The product ID' },
        asset_id: { type: 'string', description: 'The asset ID to unlink' },
      },
      required: ['product_id', 'asset_id'],
    },
  },
  {
    name: 'categories_list',
    description: 'List categories linked to a product (Plytix v2)',
    inputSchema: {
      type: 'object',
      properties: {
        product_id: { type: 'string', description: 'The product ID' },
      },
      required: ['product_id'],
    },
  },
  {
    name: 'categories_link',
    description: 'Link an existing category to a product',
    inputSchema: {
      type: 'object',
      properties: {
        product_id: { type: 'string', description: 'The product ID' },
        category_id: { type: 'string', description: 'The category ID to link' },
      },
      required: ['product_id', 'category_id'],
    },
  },
  {
    name: 'categories_unlink',
    description: 'Remove a category link from a product. The category itself is not deleted.',
    inputSchema: {
      type: 'object',
      properties: {
        product_id: { type: 'string', description: 'The product ID' },
        category_id: { type: 'string', description: 'The category ID to unlink' },
      },
      required: ['product_id', 'category_id'],
    },
  },
  {
    name: 'variants_list',
    description: 'List variants linked to a product (Plytix v2)',
    inputSchema: {
      type: 'object',
      properties: {
        product_id: { type: 'string', description: 'The product ID' },
      },
      required: ['product_id'],
    },
  },
  {
    name: 'variants_resync',
    description:
      'Resync variant attributes to inherit from parent product.',
    inputSchema: {
      type: 'object',
      properties: {
        parent_product_id: {
          type: 'string',
          description: 'The parent product ID containing the variants',
        },
        attribute_labels: {
          type: 'array',
          items: { type: 'string' },
          description: 'List of attribute labels to reset (must be attributes at parent level)',
        },
        variant_ids: {
          type: 'array',
          items: { type: 'string' },
          description: 'List of variant product IDs to resync (must be variants of the specified parent)',
        },
      },
      required: ['parent_product_id', 'attribute_labels', 'variant_ids'],
    },
  },
  {
    name: 'relationships_link_product',
    description: 'Link a related product to a relationship.',
    inputSchema: {
      type: 'object',
      properties: {
        product_id: { type: 'string', description: 'Primary product ID' },
        relationship_id: { type: 'string', description: 'Relationship definition ID' },
        related_product_id: { type: 'string', description: 'Related product ID to link' },
        quantity: { type: 'number', description: 'Optional relationship quantity' },
      },
      required: ['product_id', 'relationship_id', 'related_product_id'],
    },
  },
  {
    name: 'relationships_unlink_product',
    description:
      'Unlink one related product from a relationship on the primary product.',
    inputSchema: {
      type: 'object',
      properties: {
        product_id: { type: 'string', description: 'Primary product ID' },
        relationship_id: { type: 'string', description: 'Relationship definition ID' },
        related_product_id: { type: 'string', description: 'Related product ID to unlink' },
      },
      required: ['product_id', 'relationship_id', 'related_product_id'],
    },
  },
  {
    name: 'relationships_set_quantity',
    description:
      'Set quantity for a single related product row in a relationship.',
    inputSchema: {
      type: 'object',
      properties: {
        product_id: { type: 'string', description: 'Primary product ID' },
        relationship_id: { type: 'string', description: 'Relationship definition ID' },
        related_product_id: { type: 'string', description: 'Related product ID to update' },
        quantity: { type: 'number', description: 'Quantity value to store' },
      },
      required: ['product_id', 'relationship_id', 'related_product_id', 'quantity'],
    },
  },
];

// ─────────────────────────────────────────────────────────────
// Tool Handlers
// ─────────────────────────────────────────────────────────────

const toolHandlers: Record<string, ToolHandler> = {
  async products_lookup(args, client) {
    const lookup = new WorkerPlytixLookup(client);
    const identifier = args.identifier as string;
    const type = args.type as string | undefined;
    const limit = Math.min((args.limit as number) || 5, 20);

    const result = await lookup.findByIdentifier(
      identifier,
      type as 'id' | 'sku' | 'mpn' | 'mno' | 'gtin' | 'label' | undefined,
      limit
    );

    let fullProduct = null;
    if (result.selected) {
      try {
        const productResult = await client.getProduct(result.selected.id);
        fullProduct = productResult.data?.[0] ?? null;
      } catch {
        fullProduct = result.selected.raw;
      }
    }

    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(
            {
              selected: result.selected
                ? {
                    id: result.selected.id,
                    sku: result.selected.sku,
                    label: result.selected.label,
                    confidence: result.selected.confidence,
                    reason: result.selected.reason,
                    matchedField: result.selected.matchedField,
                  }
                : null,
              product: fullProduct,
              alternativeMatches: result.matches.slice(1, 5).map((m) => ({
                id: m.id,
                sku: m.sku,
                label: m.label,
                confidence: m.confidence,
              })),
              searchPlan: result.plan,
            },
            null,
            2
          ),
        },
      ],
    };
  },

  async products_get(args, client) {
    const productId = args.product_id as string;
    const result = await client.getProduct(productId);

    if (!result.data?.[0]) {
      return {
        content: [{ type: 'text', text: `Product not found: ${productId}` }],
        isError: true,
      };
    }

    return {
      content: [{ type: 'text', text: JSON.stringify(result.data[0], null, 2) }],
    };
  },

  async products_get_full(args, client) {
    const productId = args.product_id as string;
    const productResult = await client.getProduct(productId);
    const product = productResult.data?.[0];

    if (!product) {
      return {
        content: [{ type: 'text', text: `Product not found: ${productId}` }],
        isError: true,
      };
    }

    const familyId = (product as Record<string, unknown>).product_family_id as string | undefined;
    const [familyResult, variantsResult, categoriesResult, assetsResult] =
      await Promise.allSettled([
        familyId ? client.getFamily(familyId) : Promise.resolve(null),
        client.getProductVariants(productId),
        client.getProductCategories(productId),
        client.getProductAssets(productId),
      ]);

    const errors: string[] = [];

    const family =
      familyResult.status === 'fulfilled'
        ? (familyResult.value?.data?.[0] ?? null)
        : (errors.push(`family: ${familyResult.reason}`), null);

    const variants =
      variantsResult.status === 'fulfilled'
        ? (variantsResult.value?.data ?? [])
        : (errors.push(`variants: ${variantsResult.reason}`), []);

    const categories =
      categoriesResult.status === 'fulfilled'
        ? (categoriesResult.value?.data ?? [])
        : (errors.push(`categories: ${categoriesResult.reason}`), []);

    const assets =
      assetsResult.status === 'fulfilled'
        ? (assetsResult.value?.data ?? [])
        : (errors.push(`assets: ${assetsResult.reason}`), []);

    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(
            {
              product,
              family,
              variants,
              categories,
              assets,
              ...(errors.length > 0 ? { _errors: errors } : {}),
            },
            null,
            2
          ),
        },
      ],
    };
  },

  async products_search(args, client) {
    const result = await client.searchProducts(args as Record<string, unknown>);

    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(
            {
              products: result.data,
              pagination: result.pagination,
              attributes_returned: result.attributes,
            },
            null,
            2
          ),
        },
      ],
    };
  },

  async products_find(args, client) {
    const lookup = new WorkerPlytixLookup(client);
    const result = await lookup.findProducts({
      sku: args.sku as string | undefined,
      mpn: args.mpn as string | undefined,
      mno: args.mno as string | undefined,
      gtin: args.gtin as string | undefined,
      label: args.label as string | undefined,
      fuzzySearch: args.fuzzy_search as string | undefined,
      limit: (args.limit as number) || 10,
    });

    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(
            {
              selected: result.selected
                ? {
                    id: result.selected.id,
                    sku: result.selected.sku,
                    label: result.selected.label,
                    confidence: result.selected.confidence,
                  }
                : null,
              matches: result.matches.map((m) => ({
                id: m.id,
                sku: m.sku,
                label: m.label,
                confidence: m.confidence,
              })),
              count: result.matches.length,
              searchPlan: result.plan,
            },
            null,
            2
          ),
        },
      ],
    };
  },

  async families_list(args, client) {
    const body: Record<string, unknown> = {
      pagination: {
        page: (args.page as number) || 1,
        page_size: (args.page_size as number) || 25,
      },
    };

    if (args.query) {
      body.filters = [[{ field: 'name', operator: 'like', value: args.query }]];
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
  },

  async families_get(args, client) {
    const familyId = args.family_id as string;
    const result = await client.getFamily(familyId);

    if (!result.data?.[0]) {
      return {
        content: [{ type: 'text', text: `Family not found: ${familyId}` }],
        isError: true,
      };
    }

    return {
      content: [{ type: 'text', text: JSON.stringify(result.data[0], null, 2) }],
    };
  },

  async attributes_list(args, client) {
    const { system, custom } = await client.getProductAttributes();
    const includeOptions = args.include_options !== false;

    const result = {
      system_attributes: system,
      custom_attributes: custom.map((attr) => ({
        key: attr.field,
        label: attr.label,
        type: attr.type,
        ...(includeOptions && attr.options ? { options: attr.options } : {}),
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
  },

  async attributes_filters(args, client) {
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
  },

  async attributes_get(args, client) {
    const label = args.label as string;
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
  },

  async attributes_get_options(args, client) {
    const label = args.label as string;
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
  },

  async products_set_attribute(args, client) {
    const productId = args.product_id as string;
    const attributeLabel = stripAttributesPrefix(args.attribute_label as string);
    const value = args.value;

    if (!attributeLabel) {
      return {
        content: [{ type: 'text', text: 'attribute_label cannot be empty' }],
        isError: true,
      };
    }

    if (value === null) {
      return {
        content: [{ type: 'text', text: 'Value cannot be null. Use products_clear_attribute instead.' }],
        isError: true,
      };
    }

    const attribute = await client.getAttributeByLabel(attributeLabel);
    if (!attribute) {
      return {
        content: [{ type: 'text', text: `Attribute not found: ${attributeLabel}` }],
        isError: true,
      };
    }

    const validationError = validateAttributeValue(attribute, value);
    if (validationError) {
      return {
        content: [{ type: 'text', text: validationError }],
        isError: true,
      };
    }

    const result = await client.updateProduct(productId, {
      attributes: { [attributeLabel]: value },
    });
    const updated = result.data?.[0];

    if (!updated?.id) {
      return {
        content: [{ type: 'text', text: `Attribute write may have failed: no response for ${productId}` }],
        isError: true,
      };
    }

    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(
            {
              success: true,
              product_id: productId,
              attribute_label: attributeLabel,
              action: 'set',
              modified: updated.modified,
            },
            null,
            2
          ),
        },
      ],
    };
  },

  async products_clear_attribute(args, client) {
    const productId = args.product_id as string;
    const attributeLabel = stripAttributesPrefix(args.attribute_label as string);

    if (!attributeLabel) {
      return {
        content: [{ type: 'text', text: 'attribute_label cannot be empty' }],
        isError: true,
      };
    }

    const attribute = await client.getAttributeByLabel(attributeLabel);
    if (!attribute) {
      return {
        content: [{ type: 'text', text: `Attribute not found: ${attributeLabel}` }],
        isError: true,
      };
    }

    const result = await client.updateProduct(productId, {
      attributes: { [attributeLabel]: null },
    });
    const updated = result.data?.[0];

    if (!updated?.id) {
      return {
        content: [{ type: 'text', text: `Attribute clear may have failed: no response for ${productId}` }],
        isError: true,
      };
    }

    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(
            {
              success: true,
              product_id: productId,
              attribute_label: attributeLabel,
              action: 'cleared',
              modified: updated.modified,
            },
            null,
            2
          ),
        },
      ],
    };
  },

  async products_create(args, client) {
    const sku = args.sku as string;
    const label = args.label as string | undefined;
    const status = args.status as string | undefined;
    const attributes = args.attributes as Record<string, unknown> | undefined;
    const categoryIds = args.category_ids as string[] | undefined;
    const assetIds = args.asset_ids as string[] | undefined;

    const data: Parameters<typeof client.createProduct>[0] = { sku };
    if (label !== undefined) data.label = label;
    if (status !== undefined) data.status = status;
    if (attributes !== undefined) data.attributes = attributes;
    if (categoryIds?.length) data.categories = categoryIds.map((id) => ({ id }));
    if (assetIds?.length) data.assets = assetIds.map((id) => ({ id }));

    const result = await client.createProduct(data);
    const created = result.data?.[0];

    if (!created?.id) {
      return {
        content: [{ type: 'text', text: 'Product creation failed: no ID returned from API' }],
        isError: true,
      };
    }

    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(
            {
              success: true,
              id: created.id,
              created: created.created,
            },
            null,
            2
          ),
        },
      ],
    };
  },

  async products_update(args, client) {
    const productId = args.product_id as string;
    const label = args.label as string | undefined;
    const status = args.status as string | undefined;
    const attributes = args.attributes as Record<string, unknown> | undefined;

    const data: Parameters<typeof client.updateProduct>[1] = {};
    if (label !== undefined) data.label = label;
    if (status !== undefined) data.status = status;
    if (attributes !== undefined) data.attributes = attributes;

    if (Object.keys(data).length === 0) {
      return {
        content: [{ type: 'text', text: 'No fields provided to update' }],
        isError: true,
      };
    }

    const result = await client.updateProduct(productId, data);
    const updated = result.data?.[0];

    if (!updated?.id) {
      return {
        content: [{ type: 'text', text: `Product update failed: no response for ${productId}` }],
        isError: true,
      };
    }

    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(
            {
              success: true,
              id: updated.id,
              modified: updated.modified,
            },
            null,
            2
          ),
        },
      ],
    };
  },

  async products_assign_family(args, client) {
    const productId = args.product_id as string;
    const familyId = args.family_id as string;

    const result = await client.assignProductFamily(productId, familyId);
    const updated = result.data?.[0];

    if (!updated?.id) {
      return {
        content: [{ type: 'text', text: `Family assignment failed: no response for ${productId}` }],
        isError: true,
      };
    }

    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(
            {
              success: true,
              id: updated.id,
              family_id: familyId || null,
              action: familyId ? 'assigned' : 'unassigned',
              modified: updated.modified,
            },
            null,
            2
          ),
        },
      ],
    };
  },

  async assets_list(args, client) {
    const productId = args.product_id as string;
    const result = await client.getProductAssets(productId);

    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(
            {
              assets: result.data,
              count: result.data?.length ?? 0,
            },
            null,
            2
          ),
        },
      ],
    };
  },

  async assets_link(args, client) {
    const productId = args.product_id as string;
    const assetId = args.asset_id as string;
    const attributeLabel = args.attribute_label as string | undefined;

    const result = await client.linkProductAsset(productId, assetId, attributeLabel);
    const linked = result.data?.[0];

    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(
            {
              success: true,
              product_id: productId,
              asset: linked ? { id: linked.id, name: linked.name, url: linked.url } : { id: assetId },
              ...(attributeLabel ? { attribute_label: attributeLabel } : {}),
            },
            null,
            2
          ),
        },
      ],
    };
  },

  async assets_unlink(args, client) {
    const productId = args.product_id as string;
    const assetId = args.asset_id as string;

    await client.unlinkProductAsset(productId, assetId);

    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(
            {
              success: true,
              product_id: productId,
              asset_id: assetId,
              action: 'unlinked',
            },
            null,
            2
          ),
        },
      ],
    };
  },

  async categories_list(args, client) {
    const productId = args.product_id as string;
    const result = await client.getProductCategories(productId);

    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(
            {
              categories: result.data,
              count: result.data?.length ?? 0,
            },
            null,
            2
          ),
        },
      ],
    };
  },

  async categories_link(args, client) {
    const productId = args.product_id as string;
    const categoryId = args.category_id as string;

    const result = await client.linkProductCategory(productId, categoryId);
    const linked = result.data?.[0];

    if (!linked?.id) {
      return {
        content: [{ type: 'text', text: `Category link failed: no response for product ${productId}, category ${categoryId}` }],
        isError: true,
      };
    }

    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(
            {
              success: true,
              product_id: productId,
              category: { id: linked.id, name: linked.name, path: linked.path },
            },
            null,
            2
          ),
        },
      ],
    };
  },

  async categories_unlink(args, client) {
    const productId = args.product_id as string;
    const categoryId = args.category_id as string;

    await client.unlinkProductCategory(productId, categoryId);

    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(
            {
              success: true,
              product_id: productId,
              category_id: categoryId,
              action: 'unlinked',
            },
            null,
            2
          ),
        },
      ],
    };
  },

  async variants_list(args, client) {
    const productId = args.product_id as string;
    const result = await client.getProductVariants(productId);

    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(
            {
              variants: result.data,
              count: result.data?.length ?? 0,
            },
            null,
            2
          ),
        },
      ],
    };
  },

  async variants_resync(args, client) {
    const parentProductId = args.parent_product_id as string;
    const attributeLabels = args.attribute_labels as string[];
    const variantIds = args.variant_ids as string[];

    await client.resyncVariants(parentProductId, attributeLabels, variantIds);

    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(
            {
              success: true,
              parent_product_id: parentProductId,
              attributes_reset: attributeLabels,
              variants_affected: variantIds.length,
            },
            null,
            2
          ),
        },
      ],
    };
  },

  async relationships_link_product(args, client) {
    const productId = args.product_id as string;
    const relationshipId = args.relationship_id as string;
    const relatedProductId = args.related_product_id as string;
    const quantity = args.quantity as number | undefined;

    await client.linkProductRelationship(productId, relationshipId, [
      {
        product_id: relatedProductId,
        ...(quantity !== undefined ? { quantity } : {}),
      },
    ]);

    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(
            {
              success: true,
              action: 'linked',
              product_id: productId,
              relationship_id: relationshipId,
              related_product_id: relatedProductId,
              ...(quantity !== undefined ? { quantity } : {}),
            },
            null,
            2
          ),
        },
      ],
    };
  },

  async relationships_unlink_product(args, client) {
    const productId = args.product_id as string;
    const relationshipId = args.relationship_id as string;
    const relatedProductId = args.related_product_id as string;

    await client.unlinkProductRelationship(productId, relationshipId, [relatedProductId]);

    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(
            {
              success: true,
              action: 'unlinked',
              product_id: productId,
              relationship_id: relationshipId,
              related_product_id: relatedProductId,
            },
            null,
            2
          ),
        },
      ],
    };
  },

  async relationships_set_quantity(args, client) {
    const productId = args.product_id as string;
    const relationshipId = args.relationship_id as string;
    const relatedProductId = args.related_product_id as string;
    const quantity = args.quantity as number;

    await client.updateProductRelationship(productId, relationshipId, [
      { product_id: relatedProductId, quantity },
    ]);

    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(
            {
              success: true,
              action: 'quantity_updated',
              product_id: productId,
              relationship_id: relationshipId,
              related_product_id: relatedProductId,
              quantity,
            },
            null,
            2
          ),
        },
      ],
    };
  },
};

// ─────────────────────────────────────────────────────────────
// MCP Protocol Handler
// ─────────────────────────────────────────────────────────────

async function handleMcpRequest(
  request: JsonRpcRequest,
  client: WorkerPlytixClient | null
): Promise<JsonRpcResponse> {
  const { id, method, params } = request;

  try {
    switch (method) {
      case 'initialize': {
        return {
          jsonrpc: '2.0',
          id: id ?? null,
          result: {
            protocolVersion: '2024-11-05',
            capabilities: {
              tools: {},
            },
            serverInfo: {
              name: 'plytix-mcp',
              version: '0.2.0',
            },
          },
        };
      }

      case 'tools/list': {
        return {
          jsonrpc: '2.0',
          id: id ?? null,
          result: {
            tools: TOOLS,
          },
        };
      }

      case 'tools/call': {
        if (!client) {
          return {
            jsonrpc: '2.0',
            id: id ?? null,
            error: {
              code: -32600,
              message: 'Authentication required for tool calls. Provide API credentials.',
            },
          };
        }

        const toolName = (params?.name as string) ?? '';
        const args = (params?.arguments as Record<string, unknown>) ?? {};

        const handler = toolHandlers[toolName];
        if (!handler) {
          return {
            jsonrpc: '2.0',
            id: id ?? null,
            error: {
              code: -32601,
              message: `Unknown tool: ${toolName}`,
            },
          };
        }

        try {
          const result = await handler(args, client);
          return {
            jsonrpc: '2.0',
            id: id ?? null,
            result,
          };
        } catch (error) {
          return {
            jsonrpc: '2.0',
            id: id ?? null,
            result: {
              content: [
                {
                  type: 'text',
                  text: `Error: ${error instanceof Error ? error.message : 'Unknown error'}`,
                },
              ],
              isError: true,
            },
          };
        }
      }

      case 'notifications/initialized':
      case 'ping': {
        // Notifications don't require a response, but we'll acknowledge ping
        if (method === 'ping') {
          return {
            jsonrpc: '2.0',
            id: id ?? null,
            result: {},
          };
        }
        return {
          jsonrpc: '2.0',
          id: id ?? null,
          result: {},
        };
      }

      default: {
        return {
          jsonrpc: '2.0',
          id: id ?? null,
          error: {
            code: -32601,
            message: `Method not found: ${method}`,
          },
        };
      }
    }
  } catch (error) {
    return {
      jsonrpc: '2.0',
      id: id ?? null,
      error: {
        code: -32603,
        message: error instanceof Error ? error.message : 'Internal error',
      },
    };
  }
}

// ─────────────────────────────────────────────────────────────
// Request Handler
// ─────────────────────────────────────────────────────────────

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const corsHeaders = getCorsHeaders(request);

    // Handle CORS preflight
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders });
    }

    // Health check
    if (url.pathname === '/health') {
      return new Response(JSON.stringify({ status: 'ok', timestamp: new Date().toISOString() }), {
        headers: { 'Content-Type': 'application/json', ...corsHeaders },
      });
    }

    // Server info
    if (url.pathname === '/' && request.method === 'GET') {
      return new Response(
        JSON.stringify({
          name: 'plytix-mcp',
          version: '0.2.0',
          description: 'Remote MCP server for Plytix PIM',
          endpoints: {
            mcp: '/mcp',
            health: '/health',
          },
          authentication: {
            methods: [
              {
                type: 'headers',
                required: ['X-Plytix-API-Key', 'X-Plytix-API-Password'],
              },
              {
                type: 'bearer',
                format: 'Bearer <api_key>:<api_password>',
                note: 'For Craft Agents and other MCP clients',
              },
            ],
          },
        }),
        {
          headers: { 'Content-Type': 'application/json', ...corsHeaders },
        }
      );
    }

    // MCP endpoint
    if (url.pathname === '/mcp' && request.method === 'POST') {
      // Parse JSON-RPC request first to check if auth is needed
      let body: JsonRpcRequest | JsonRpcRequest[];
      let bodyText: string;
      try {
        bodyText = await request.text();
        body = JSON.parse(bodyText);
      } catch {
        return new Response(
          JSON.stringify({
            jsonrpc: '2.0',
            id: null,
            error: { code: -32700, message: 'Parse error: Invalid JSON' },
          }),
          {
            status: 400,
            headers: { 'Content-Type': 'application/json', ...corsHeaders },
          }
        );
      }

      // Methods that don't require authentication (for MCP client discovery)
      const publicMethods = ['initialize', 'notifications/initialized', 'tools/list'];
      const requests = Array.isArray(body) ? body : [body];
      const allPublic = requests.every(
        (req) => req && typeof req === 'object' && typeof req.method === 'string' && publicMethods.includes(req.method)
      );

      // Extract API credentials from headers
      // Supports two formats:
      // 1. Custom headers: X-Plytix-API-Key and X-Plytix-API-Password
      // 2. Bearer token: Authorization: Bearer <api_key>:<api_password>
      let apiKey = request.headers.get('X-Plytix-API-Key');
      let apiPassword = request.headers.get('X-Plytix-API-Password');

      // Fallback to Bearer token format for Craft Agents compatibility
      if (!apiKey || !apiPassword) {
        const authHeader = request.headers.get('Authorization');
        if (authHeader?.startsWith('Bearer ')) {
          const token = authHeader.slice(7); // Remove 'Bearer ' prefix
          const colonIndex = token.indexOf(':');
          if (colonIndex > 0) {
            apiKey = token.slice(0, colonIndex);
            apiPassword = token.slice(colonIndex + 1);
          }
        }
      }

      // Only require auth for non-public methods
      if (!allPublic && (!apiKey || !apiPassword)) {
        return new Response(
          JSON.stringify({
            jsonrpc: '2.0',
            id: null,
            error: {
              code: -32600,
              message:
                'Missing Plytix API credentials. Provide either X-Plytix-API-Key and X-Plytix-API-Password headers, or Authorization: Bearer <api_key>:<api_password>',
            },
          }),
          {
            status: 401,
            headers: { 'Content-Type': 'application/json', ...corsHeaders },
          }
        );
      }

      // Create client with request credentials (only if we have them)
      let client: WorkerPlytixClient | null = null;
      if (apiKey && apiPassword) {
        try {
          client = new WorkerPlytixClient({
            apiKey,
            apiPassword,
            baseUrl: env.PLYTIX_API_BASE,
            authUrl: env.PLYTIX_AUTH_URL,
          });
        } catch (error) {
          return new Response(
            JSON.stringify({
              jsonrpc: '2.0',
              id: null,
              error: {
                code: -32600,
                message: error instanceof Error ? error.message : 'Failed to initialize client',
              },
            }),
            {
              status: 400,
              headers: { 'Content-Type': 'application/json', ...corsHeaders },
            }
          );
        }
      }

      // Handle batch requests
      if (Array.isArray(body)) {
        const responses = await Promise.all(
          body.map((req) => handleMcpRequest(req, client))
        );
        return new Response(JSON.stringify(responses), {
          headers: { 'Content-Type': 'application/json', ...corsHeaders },
        });
      }

      // Handle single request
      const response = await handleMcpRequest(body, client);
      return new Response(JSON.stringify(response), {
        headers: { 'Content-Type': 'application/json', ...corsHeaders },
      });
    }

    // 404 for unknown paths
    return new Response(JSON.stringify({ error: 'Not found' }), {
      status: 404,
      headers: { 'Content-Type': 'application/json', ...corsHeaders },
    });
  },
};
