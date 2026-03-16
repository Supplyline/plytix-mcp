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
    description: 'Find the best product match for an identifier.',
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
    description: 'Get one product by ID.',
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
    description: 'Get one product with related data.',
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
    description: 'Search products with filters.',
    inputSchema: {
      type: 'object',
      properties: {
        attributes: {
          type: 'array',
          items: { type: 'string' },
          description: 'Attributes to return (max 50). Prefix custom attrs with "attributes." e.g. "attributes.head_material".',
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
    description: 'Find products by common identifiers.',
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
    description: 'List product families.',
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
    description: 'Get one product family.',
    inputSchema: {
      type: 'object',
      properties: {
        family_id: { type: 'string', description: 'The product family ID' },
      },
      required: ['family_id'],
    },
  },
  {
    name: 'families_create',
    description: 'Create a product family.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Name for the new family' },
        parent_id: { type: 'string', description: 'Optional parent family ID' },
      },
      required: ['name'],
    },
  },
  {
    name: 'families_link_attribute',
    description: 'Link attributes to a family.',
    inputSchema: {
      type: 'object',
      properties: {
        family_id: { type: 'string', description: 'The product family ID' },
        attribute_labels: {
          type: 'array',
          items: { type: 'string' },
          description: 'Attribute labels to link to the family',
        },
      },
      required: ['family_id', 'attribute_labels'],
    },
  },
  {
    name: 'families_unlink_attribute',
    description: 'Unlink attributes from a family.',
    inputSchema: {
      type: 'object',
      properties: {
        family_id: { type: 'string', description: 'The product family ID' },
        attribute_labels: {
          type: 'array',
          items: { type: 'string' },
          description: 'Attribute labels to unlink from the family',
        },
      },
      required: ['family_id', 'attribute_labels'],
    },
  },
  {
    name: 'families_list_attributes',
    description: 'List direct family attributes.',
    inputSchema: {
      type: 'object',
      properties: {
        family_id: { type: 'string', description: 'The product family ID' },
      },
      required: ['family_id'],
    },
  },
  {
    name: 'families_list_all_attributes',
    description: 'List all family attributes.',
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
    description: 'List product attributes.',
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
    description: 'Get one attribute.',
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
    description: 'List allowed values for an attribute.',
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
    description: 'Deprecated alias for product filters.',
    inputSchema: {
      type: 'object',
      properties: {},
    },
  },
  {
    name: 'products_filters',
    description: 'List product search filters.',
    inputSchema: {
      type: 'object',
      properties: {},
    },
  },
  {
    name: 'assets_filters',
    description: 'List asset search filters.',
    inputSchema: {
      type: 'object',
      properties: {},
    },
  },
  {
    name: 'relationships_filters',
    description: 'List relationship search filters.',
    inputSchema: {
      type: 'object',
      properties: {},
    },
  },
  {
    name: 'products_set_attribute',
    description: 'Set one product attribute.',
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
    description: 'Clear one product attribute.',
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
    description: 'Create a product.',
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
    description: 'Update a product.',
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
    description: 'Assign or unassign a family.',
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
    name: 'assets_get',
    description: 'Get one asset by ID.',
    inputSchema: {
      type: 'object',
      properties: {
        asset_id: { type: 'string', description: 'The asset ID' },
      },
      required: ['asset_id'],
    },
  },
  {
    name: 'assets_search',
    description: 'Search assets.',
    inputSchema: {
      type: 'object',
      properties: {
        filters: {
          type: 'array',
          description: 'Search filters in Plytix OR-of-ANDs format',
        },
        pagination: {
          type: 'object',
          properties: {
            page: { type: 'number' },
            page_size: { type: 'number' },
            order: { type: 'string' },
          },
        },
        sort: { description: 'Optional sort payload' },
      },
    },
  },
  {
    name: 'assets_update',
    description: 'Update asset filename or categories.',
    inputSchema: {
      type: 'object',
      properties: {
        asset_id: { type: 'string', description: 'The asset ID' },
        filename: { type: 'string', description: 'New filename for the asset' },
        categories: {
          type: 'array',
          items: { type: 'string' },
          description: 'Category IDs to assign to the asset',
        },
      },
      required: ['asset_id'],
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
    description: 'Link an asset to a product.',
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
    description: 'Unlink an asset from a product.',
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
    name: 'categories_search',
    description: 'Search product categories.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Search query to filter categories by name' },
        pagination: {
          type: 'object',
          properties: {
            page: { type: 'number' },
            page_size: { type: 'number' },
          },
        },
      },
    },
  },
  {
    name: 'categories_list',
    description: 'List categories linked to a product.',
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
    description: 'Link a category to a product.',
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
    description: 'Unlink a category from a product.',
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
    name: 'variants_create',
    description: 'Create a variant under a parent product.',
    inputSchema: {
      type: 'object',
      properties: {
        parent_product_id: { type: 'string', description: 'The parent product ID' },
        sku: { type: 'string', description: 'SKU for the new variant' },
        label: { type: 'string', description: 'Optional label for the new variant' },
        attributes: { description: 'Optional attributes to set or override on the variant' },
      },
      required: ['parent_product_id', 'sku'],
    },
  },
  {
    name: 'variants_link',
    description: 'Link an existing product as a variant.',
    inputSchema: {
      type: 'object',
      properties: {
        parent_product_id: { type: 'string', description: 'The parent product ID' },
        variant_product_id: {
          type: 'string',
          description: 'The existing product ID to link as a variant',
        },
      },
      required: ['parent_product_id', 'variant_product_id'],
    },
  },
  {
    name: 'variants_unlink',
    description: 'Unlink a variant from its parent.',
    inputSchema: {
      type: 'object',
      properties: {
        parent_product_id: { type: 'string', description: 'The parent product ID' },
        variant_product_id: { type: 'string', description: 'The variant product ID to unlink' },
      },
      required: ['parent_product_id', 'variant_product_id'],
    },
  },
  {
    name: 'variants_list',
    description: 'List variants for a product.',
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
    description: 'Resync variant inheritance from the parent.',
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
    name: 'relationships_get',
    description: 'Get one relationship definition.',
    inputSchema: {
      type: 'object',
      properties: {
        relationship_id: { type: 'string', description: 'The relationship definition ID' },
      },
      required: ['relationship_id'],
    },
  },
  {
    name: 'relationships_search',
    description: 'Search relationship definitions.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Search query to filter relationships by label' },
        pagination: {
          type: 'object',
          properties: {
            page: { type: 'number' },
            page_size: { type: 'number' },
          },
        },
      },
    },
  },
  {
    name: 'relationships_link_product',
    description: 'Link a related product.',
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
    description: 'Unlink a related product.',
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
    description: 'Set quantity on a related product row.',
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
    const errMsg = (e: unknown) => e instanceof Error ? e.message : String(e);

    const family =
      familyResult.status === 'fulfilled'
        ? (familyResult.value?.data?.[0] ?? null)
        : (errors.push(`family: ${errMsg(familyResult.reason)}`), null);

    const variants =
      variantsResult.status === 'fulfilled'
        ? (variantsResult.value?.data ?? [])
        : (errors.push(`variants: ${errMsg(variantsResult.reason)}`), []);

    const categories =
      categoriesResult.status === 'fulfilled'
        ? (categoriesResult.value?.data ?? [])
        : (errors.push(`categories: ${errMsg(categoriesResult.reason)}`), []);

    const assets =
      assetsResult.status === 'fulfilled'
        ? (assetsResult.value?.data ?? [])
        : (errors.push(`assets: ${errMsg(assetsResult.reason)}`), []);

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
    // Normalize filter shorthand: LLMs may pass ["field","op","value"] tuples
    // instead of the required {field, operator, value} objects.
    if (Array.isArray(args.filters)) {
      args.filters = (args.filters as unknown[][]).map((group) => {
        if (!Array.isArray(group)) return group;
        return group.map((item) => {
          if (Array.isArray(item) && item.length >= 2 && typeof item[0] === 'string') {
            return { field: item[0], operator: item[1], value: item[2] };
          }
          return item;
        });
      });
    }

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

  async families_create(args, client) {
    const result = await client.createFamily({
      name: args.name as string,
      ...(args.parent_id !== undefined ? { parent_id: args.parent_id as string } : {}),
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
  },

  async families_link_attribute(args, client) {
    const familyId = args.family_id as string;
    const attributeLabels = args.attribute_labels as string[];

    await client.linkFamilyAttributes(familyId, attributeLabels);

    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(
            {
              success: true,
              action: 'linked',
              family_id: familyId,
              attribute_labels: attributeLabels,
              count: attributeLabels.length,
            },
            null,
            2
          ),
        },
      ],
    };
  },

  async families_unlink_attribute(args, client) {
    const familyId = args.family_id as string;
    const attributeLabels = args.attribute_labels as string[];

    await client.unlinkFamilyAttributes(familyId, attributeLabels);

    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(
            {
              success: true,
              action: 'unlinked',
              family_id: familyId,
              attribute_labels: attributeLabels,
              count: attributeLabels.length,
            },
            null,
            2
          ),
        },
      ],
    };
  },

  async families_list_attributes(args, client) {
    const familyId = args.family_id as string;
    const result = await client.getFamilyAttributes(familyId);

    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(
            {
              family_id: familyId,
              attributes: result.data,
              count: result.data?.length ?? 0,
            },
            null,
            2
          ),
        },
      ],
    };
  },

  async families_list_all_attributes(args, client) {
    const familyId = args.family_id as string;
    const result = await client.getFamilyAllAttributes(familyId);

    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(
            {
              family_id: familyId,
              attributes: result.data,
              count: result.data?.length ?? 0,
            },
            null,
            2
          ),
        },
      ],
    };
  },

  async attributes_list(args, client) {
    const { system, custom } = await client.getProductAttributes();
    const includeOptions = args.include_options !== false;

    const result = {
      system_attributes: system,
      custom_attributes: custom.map((attr) => ({
        key: attr.key ?? attr.field,
        label: attr.label,
        type: attr.filter_type ?? attr.type,
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
  },

  async products_filters(args, client) {
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
  },

  async assets_filters(args, client) {
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
  },

  async relationships_filters(args, client) {
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

  async assets_get(args, client) {
    const assetId = args.asset_id as string;
    const result = await client.getAsset(assetId);
    const asset = result.data?.[0];

    if (!asset) {
      return {
        content: [{ type: 'text', text: `Asset not found: ${assetId}` }],
        isError: true,
      };
    }

    return {
      content: [{ type: 'text', text: JSON.stringify(asset, null, 2) }],
    };
  },

  async assets_search(args, client) {
    const body: Record<string, unknown> = {};

    if (args.filters !== undefined) {
      body.filters = args.filters;
    }
    if (args.pagination !== undefined) {
      body.pagination = args.pagination;
    }
    if (args.sort !== undefined) {
      body.sort = args.sort;
    }

    const result = await client.searchAssets(body);

    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(
            {
              assets: result.data,
              pagination: result.pagination,
            },
            null,
            2
          ),
        },
      ],
    };
  },

  async assets_update(args, client) {
    const assetId = args.asset_id as string;
    const filename = args.filename as string | undefined;
    const categories = args.categories as string[] | undefined;

    if (filename === undefined && categories === undefined) {
      return {
        content: [
          {
            type: 'text',
            text: 'Error updating asset: provide at least one of filename or categories',
          },
        ],
        isError: true,
      };
    }

    await client.updateAsset(assetId, {
      ...(filename !== undefined ? { filename } : {}),
      ...(categories !== undefined ? { categories } : {}),
    });

    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(
            {
              success: true,
              action: 'updated',
              asset_id: assetId,
              ...(filename !== undefined ? { filename } : {}),
              ...(categories !== undefined ? { categories } : {}),
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

  async categories_search(args, client) {
    const body: Record<string, unknown> = {};

    if (args.pagination !== undefined) {
      body.pagination = args.pagination;
    }
    if (args.query) {
      body.filters = [[{ field: 'name', operator: 'like', value: args.query }]];
    }

    const result = await client.searchCategories(body);

    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(
            {
              categories: result.data,
              pagination: result.pagination,
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

  async variants_create(args, client) {
    const parentProductId = args.parent_product_id as string;
    const result = await client.createVariant(parentProductId, {
      sku: args.sku as string,
      ...(args.label !== undefined ? { label: args.label as string } : {}),
      ...(args.attributes !== undefined ? { attributes: args.attributes as Record<string, unknown> } : {}),
    });
    const variant = result.data?.[0];

    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(
            {
              success: true,
              action: 'created',
              parent_product_id: parentProductId,
              variant: variant
                ? { id: variant.id, sku: variant.sku, label: variant.label }
                : undefined,
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

  async variants_link(args, client) {
    const parentProductId = args.parent_product_id as string;
    const variantProductId = args.variant_product_id as string;

    await client.linkVariant(parentProductId, variantProductId);

    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(
            {
              success: true,
              action: 'linked',
              parent_product_id: parentProductId,
              variant_product_id: variantProductId,
            },
            null,
            2
          ),
        },
      ],
    };
  },

  async variants_unlink(args, client) {
    const parentProductId = args.parent_product_id as string;
    const variantProductId = args.variant_product_id as string;

    await client.unlinkVariant(parentProductId, variantProductId);

    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(
            {
              success: true,
              action: 'unlinked',
              parent_product_id: parentProductId,
              variant_product_id: variantProductId,
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

  async relationships_get(args, client) {
    const relationshipId = args.relationship_id as string;
    const result = await client.getRelationship(relationshipId);
    const relationship = result.data?.[0];

    if (!relationship) {
      return {
        content: [{ type: 'text', text: `Relationship not found: ${relationshipId}` }],
        isError: true,
      };
    }

    return {
      content: [{ type: 'text', text: JSON.stringify(relationship, null, 2) }],
    };
  },

  async relationships_search(args, client) {
    const body: Record<string, unknown> = {};

    if (args.pagination !== undefined) {
      body.pagination = args.pagination;
    }
    if (args.query) {
      body.filters = [[{ field: 'label', operator: 'like', value: args.query }]];
    }

    const result = await client.searchRelationships(body);

    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(
            {
              relationships: result.data,
              pagination: result.pagination,
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
