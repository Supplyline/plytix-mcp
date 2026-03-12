# Plytix MCP Scope Revision — Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add 17 new operational tools to the Plytix MCP (variants lifecycle, asset ops, category search, relationship discovery, family ops, filter discovery split) while maintaining dual-runtime parity (stdio + worker).

**Architecture:** Each new tool follows the established pattern: (1) add client method to `client.ts` + `worker-client.ts`, (2) register tool in `src/tools/*.ts`, (3) add worker handler to `src/worker.ts`. All new tools use the existing `registerTool()` wrapper and match the JSON response shape convention (`{ success, action, ...ids }` for writes, raw data for reads).

**Tech Stack:** TypeScript, Zod, MCP SDK, Vitest, Cloudflare Workers

**Dual-runtime note:** Every client method added to `client.ts` MUST also be added to `worker-client.ts`. Every tool registered in `src/tools/*.ts` MUST also get a handler in `src/worker.ts`. The worker uses inline JSON Schema (not Zod) for tool definitions.

**API endpoint verification:** Some endpoints in this plan come from the spec and have not been verified against the live Plytix API. Endpoints marked with ⚠️ should be tested manually before implementation. If an endpoint returns 404, check Plytix API docs for the correct path.

---

## File Structure

**Files to modify:**

| File | Changes |
|------|---------|
| `src/types.ts` | Add `PlytixRelationshipDefinition` type |
| `src/client.ts` | Add ~15 new client methods |
| `src/worker-client.ts` | Mirror all new client methods |
| `src/tools/variants.ts` | Add `variants_create`, `variants_link`, `variants_unlink` |
| `src/tools/assets.ts` | Add `assets_get`, `assets_search`, `assets_update` |
| `src/tools/categories.ts` | Add `categories_search` |
| `src/tools/relationships.ts` | Add `relationships_get`, `relationships_search` |
| `src/tools/families.ts` | Add `families_create`, `families_link_attribute`, `families_unlink_attribute`, `families_list_attributes`, `families_list_all_attributes` |
| `src/tools/attributes.ts` | Deprecate `attributes_filters`, add `products_filters`, `assets_filters`, `relationships_filters` |
| `src/worker.ts` | Add all 17 new tool definitions + handlers, deprecate old filter tool |
| `CLAUDE.md` | Update tool tables |

---

## Phase 1: Types + Client Methods (all plumbing, no tools yet)

### Task 1: Add PlytixRelationshipDefinition type

**Files:**
- Modify: `src/types.ts`

- [ ] **Step 1: Add type after `PlytixRelationship` interface (~line 117)**

```typescript
export interface PlytixRelationshipDefinition {
  id: string;
  label: string;
  name?: string;
  created?: string;
  modified?: string;
  [key: string]: unknown;
}
```

- [ ] **Step 2: Typecheck**

Run: `npm run typecheck`
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add src/types.ts
git commit -m "feat: add PlytixRelationshipDefinition type"
```

### Task 2: Add variant lifecycle client methods

**Files:**
- Modify: `src/client.ts` (after `resyncVariants`, ~line 602)
- Modify: `src/worker-client.ts` (after `resyncVariants`, ~line 584)

⚠️ **Endpoint note:** Variant link/unlink use singular `/variant/{id}` — verify against Plytix API. If Plytix uses plural `/variants/{id}`, update the path.

- [ ] **Step 1: Add to client.ts**

```typescript
async createVariant(
  parentProductId: string,
  data: { sku: string; label?: string; attributes?: Record<string, unknown> }
): Promise<PlytixResult<PlytixProduct>> {
  return this.request<PlytixProduct>(
    `/api/v1/products/${encodeURIComponent(parentProductId)}/variants`,
    { method: 'POST', body: JSON.stringify(data) }
  );
}

async linkVariant(
  parentProductId: string,
  variantProductId: string
): Promise<PlytixResult<PlytixProduct>> {
  return this.request<PlytixProduct>(
    `/api/v1/products/${encodeURIComponent(parentProductId)}/variant/${encodeURIComponent(variantProductId)}`,
    { method: 'POST' }
  );
}

async unlinkVariant(
  parentProductId: string,
  variantProductId: string
): Promise<PlytixResult<void>> {
  return this.request<void>(
    `/api/v1/products/${encodeURIComponent(parentProductId)}/variant/${encodeURIComponent(variantProductId)}`,
    { method: 'DELETE' }
  );
}
```

- [ ] **Step 2: Mirror identical methods in worker-client.ts**

- [ ] **Step 3: Typecheck + commit**

```bash
npm run typecheck
git add src/client.ts src/worker-client.ts
git commit -m "feat: add variant create/link/unlink client methods"
```

### Task 3: Add asset operation client methods

**Files:**
- Modify: `src/client.ts` (after `searchAssets`, ~line 396)
- Modify: `src/worker-client.ts` (after `searchAssets`, ~line 563)

- [ ] **Step 1: Add to client.ts**

```typescript
async getAsset(assetId: string): Promise<PlytixResult<PlytixAsset>> {
  return this.request<PlytixAsset>(`/api/v2/assets/${encodeURIComponent(assetId)}`);
}

async updateAsset(
  assetId: string,
  data: { filename?: string; categories?: string[] }
): Promise<PlytixResult<PlytixAsset>> {
  return this.request<PlytixAsset>(`/api/v2/assets/${encodeURIComponent(assetId)}`, {
    method: 'PATCH',
    body: JSON.stringify(data),
  });
}
```

- [ ] **Step 2: Mirror in worker-client.ts**

- [ ] **Step 3: Typecheck + commit**

```bash
npm run typecheck
git add src/client.ts src/worker-client.ts
git commit -m "feat: add asset get/update client methods"
```

### Task 4: Add category search client method

**Files:**
- Modify: `src/client.ts` (after `unlinkProductCategory`)
- Modify: `src/worker-client.ts`

⚠️ **Endpoint note:** `POST /api/v1/categories/product/search` — verify this path exists in Plytix API. May be `/api/v2/categories/search` instead.

- [ ] **Step 1: Add to client.ts**

```typescript
async searchCategories(body?: PlytixSearchBody): Promise<PlytixResult<PlytixCategory>> {
  return this.request<PlytixCategory>('/api/v1/categories/product/search', {
    method: 'POST',
    body: JSON.stringify(body ?? {}),
  });
}
```

- [ ] **Step 2: Mirror in worker-client.ts**

- [ ] **Step 3: Typecheck + commit**

```bash
npm run typecheck
git add src/client.ts src/worker-client.ts
git commit -m "feat: add category search client method"
```

### Task 5: Add relationship discovery client methods

**Files:**
- Modify: `src/client.ts` (before `linkProductRelationship`)
- Modify: `src/worker-client.ts`

⚠️ **Endpoint note:** `GET /api/v1/relationships/{id}` and `POST /api/v1/relationships/search` — these are for relationship *definitions*, not product-relationship instances. Verify these standalone endpoints exist.

- [ ] **Step 1: Add to client.ts** (update import to include `PlytixRelationshipDefinition`)

```typescript
async getRelationship(relationshipId: string): Promise<PlytixResult<PlytixRelationshipDefinition>> {
  return this.request<PlytixRelationshipDefinition>(
    `/api/v1/relationships/${encodeURIComponent(relationshipId)}`
  );
}

async searchRelationships(body?: PlytixSearchBody): Promise<PlytixResult<PlytixRelationshipDefinition>> {
  return this.request<PlytixRelationshipDefinition>('/api/v1/relationships/search', {
    method: 'POST',
    body: JSON.stringify(body ?? {}),
  });
}
```

- [ ] **Step 2: Mirror in worker-client.ts** (update import too)

- [ ] **Step 3: Typecheck + commit**

```bash
npm run typecheck
git add src/client.ts src/worker-client.ts
git commit -m "feat: add relationship get/search client methods"
```

### Task 6: Add family operation client methods

**Files:**
- Modify: `src/client.ts` (after `getFamily`)
- Modify: `src/worker-client.ts`

- [ ] **Step 1: Add to client.ts** (update import to include `PlytixFamilyAttribute`)

```typescript
async createFamily(data: { name: string; parent_id?: string }): Promise<PlytixResult<PlytixFamily>> {
  return this.request<PlytixFamily>('/api/v1/product_families', {
    method: 'POST',
    body: JSON.stringify(data),
  });
}

async linkFamilyAttributes(
  familyId: string,
  attributeLabels: string[]
): Promise<PlytixResult<void>> {
  return this.request<void>(
    `/api/v1/product_families/${encodeURIComponent(familyId)}/attributes/link`,
    { method: 'POST', body: JSON.stringify({ attributes: attributeLabels }) }
  );
}

async unlinkFamilyAttributes(
  familyId: string,
  attributeLabels: string[]
): Promise<PlytixResult<void>> {
  return this.request<void>(
    `/api/v1/product_families/${encodeURIComponent(familyId)}/attributes/unlink`,
    { method: 'POST', body: JSON.stringify({ attributes: attributeLabels }) }
  );
}

async getFamilyAttributes(familyId: string): Promise<PlytixResult<PlytixFamilyAttribute>> {
  return this.request<PlytixFamilyAttribute>(
    `/api/v1/product_families/${encodeURIComponent(familyId)}/attributes`
  );
}

async getFamilyAllAttributes(familyId: string): Promise<PlytixResult<PlytixFamilyAttribute>> {
  return this.request<PlytixFamilyAttribute>(
    `/api/v1/product_families/${encodeURIComponent(familyId)}/all_attributes`
  );
}
```

- [ ] **Step 2: Mirror in worker-client.ts** (update import too)

- [ ] **Step 3: Typecheck + commit**

```bash
npm run typecheck
git add src/client.ts src/worker-client.ts
git commit -m "feat: add family create/link-attr/unlink-attr/list-attrs client methods"
```

### Task 7: Add filter discovery client methods

**Files:**
- Modify: `src/client.ts` (after `getAvailableFilters`)
- Modify: `src/worker-client.ts`

⚠️ **Endpoint note:** `GET /api/v1/assets/search/filters` and `GET /api/v1/relationships/search/filters` — parallel pattern to existing product filters endpoint. Verify these exist.

- [ ] **Step 1: Add to client.ts**

```typescript
async getAssetFilters(): Promise<PlytixResult<PlytixFilterDefinition>> {
  return this.request<PlytixFilterDefinition>('/api/v1/assets/search/filters');
}

async getRelationshipFilters(): Promise<PlytixResult<PlytixFilterDefinition>> {
  return this.request<PlytixFilterDefinition>('/api/v1/relationships/search/filters');
}
```

- [ ] **Step 2: Mirror in worker-client.ts**

- [ ] **Step 3: Typecheck + commit**

```bash
npm run typecheck
git add src/client.ts src/worker-client.ts
git commit -m "feat: add asset and relationship filter discovery client methods"
```

---

## Phase 2: Variant Lifecycle Tools (stdio)

### Task 8: Add variants_create tool

**Files:**
- Modify: `src/tools/variants.ts`

- [ ] **Step 1: Add tool after `variants_resync`**

```typescript
// CREATE variant under parent
registerTool<{ parent_product_id: string; sku: string; label?: string; attributes?: Record<string, unknown> }>(
  server,
  'variants_create',
  {
    title: 'Create Variant',
    description: 'Create a new variant beneath a parent product. Inherits family and attributes from parent.',
    inputSchema: {
      parent_product_id: z.string().min(1).describe('The parent product ID'),
      sku: z.string().min(1).describe('SKU for the new variant'),
      label: z.string().optional().describe('Optional label for the variant'),
      attributes: z.record(z.unknown()).optional().describe('Optional attributes to override on the variant'),
    },
  },
  async ({ parent_product_id, sku, label, attributes }) => {
    try {
      const data: { sku: string; label?: string; attributes?: Record<string, unknown> } = { sku };
      if (label !== undefined) data.label = label;
      if (attributes !== undefined) data.attributes = attributes;

      const result = await client.createVariant(parent_product_id, data);
      const variant = result.data?.[0];

      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            success: true, action: 'created', parent_product_id,
            variant: variant ? { id: variant.id, sku: variant.sku, label: variant.label } : undefined,
          }, null, 2),
        }],
      };
    } catch (error) {
      return {
        content: [{ type: 'text', text: `Error creating variant: ${error instanceof Error ? error.message : 'Unknown error'}` }],
        isError: true,
      };
    }
  }
);
```

- [ ] **Step 2: Typecheck**

Run: `npm run typecheck`

- [ ] **Step 3: Commit**

```bash
git add src/tools/variants.ts
git commit -m "feat: add variants_create tool"
```

### Task 9: Add variants_link tool

**Files:**
- Modify: `src/tools/variants.ts`

- [ ] **Step 1: Add tool**

```typescript
// LINK existing product as variant
registerTool<{ parent_product_id: string; variant_product_id: string }>(
  server,
  'variants_link',
  {
    title: 'Link Variant',
    description: 'Convert an existing standalone product into a variant of a parent product.',
    inputSchema: {
      parent_product_id: z.string().min(1).describe('The parent product ID'),
      variant_product_id: z.string().min(1).describe('The existing product ID to link as a variant'),
    },
  },
  async ({ parent_product_id, variant_product_id }) => {
    try {
      await client.linkVariant(parent_product_id, variant_product_id);
      return {
        content: [{
          type: 'text',
          text: JSON.stringify({ success: true, action: 'linked', parent_product_id, variant_product_id }, null, 2),
        }],
      };
    } catch (error) {
      return {
        content: [{ type: 'text', text: `Error linking variant: ${error instanceof Error ? error.message : 'Unknown error'}` }],
        isError: true,
      };
    }
  }
);
```

- [ ] **Step 2: Typecheck + commit**

```bash
npm run typecheck
git add src/tools/variants.ts
git commit -m "feat: add variants_link tool"
```

### Task 10: Add variants_unlink tool

**Files:**
- Modify: `src/tools/variants.ts`

- [ ] **Step 1: Add tool**

```typescript
// UNLINK variant from parent (product not deleted)
registerTool<{ parent_product_id: string; variant_product_id: string }>(
  server,
  'variants_unlink',
  {
    title: 'Unlink Variant',
    description: 'Unlink a variant from its parent product. The underlying product is not deleted.',
    inputSchema: {
      parent_product_id: z.string().min(1).describe('The parent product ID'),
      variant_product_id: z.string().min(1).describe('The variant product ID to unlink'),
    },
  },
  async ({ parent_product_id, variant_product_id }) => {
    try {
      await client.unlinkVariant(parent_product_id, variant_product_id);
      return {
        content: [{
          type: 'text',
          text: JSON.stringify({ success: true, action: 'unlinked', parent_product_id, variant_product_id }, null, 2),
        }],
      };
    } catch (error) {
      return {
        content: [{ type: 'text', text: `Error unlinking variant: ${error instanceof Error ? error.message : 'Unknown error'}` }],
        isError: true,
      };
    }
  }
);
```

- [ ] **Step 2: Typecheck + commit**

```bash
npm run typecheck
git add src/tools/variants.ts
git commit -m "feat: add variants_unlink tool"
```

---

## Phase 3: Asset Operation Tools (stdio)

### Task 11: Add assets_get tool

**Files:**
- Modify: `src/tools/assets.ts` (before `assets_link`)

- [ ] **Step 1: Add tool**

```typescript
// GET single asset by ID
registerTool<{ asset_id: string }>(
  server,
  'assets_get',
  {
    title: 'Get Asset',
    description: 'Get a single asset by ID with full metadata.',
    inputSchema: {
      asset_id: z.string().min(1).describe('The asset ID'),
    },
  },
  async ({ asset_id }) => {
    try {
      const result = await client.getAsset(asset_id);
      const asset = result.data?.[0];
      if (!asset) {
        return { content: [{ type: 'text', text: `Asset not found: ${asset_id}` }], isError: true };
      }
      return { content: [{ type: 'text', text: JSON.stringify(asset, null, 2) }] };
    } catch (error) {
      return {
        content: [{ type: 'text', text: `Error fetching asset: ${error instanceof Error ? error.message : 'Unknown error'}` }],
        isError: true,
      };
    }
  }
);
```

- [ ] **Step 2: Typecheck + commit**

```bash
npm run typecheck
git add src/tools/assets.ts
git commit -m "feat: add assets_get tool"
```

### Task 12: Add assets_search tool

**Files:**
- Modify: `src/tools/assets.ts`

- [ ] **Step 1: Add tool**

```typescript
// SEARCH assets
registerTool<{
  filters?: Array<Array<{ field: string; operator: string; value?: unknown }>>;
  pagination?: { page?: number; page_size?: number };
  sort?: unknown;
}>(
  server,
  'assets_search',
  {
    title: 'Search Assets',
    description: 'Search assets with filters, pagination, and sorting.',
    inputSchema: {
      filters: z.array(z.array(z.object({
        field: z.string(), operator: z.string(), value: z.unknown().optional(),
      }))).optional().describe('Search filters (AND groups of OR conditions)'),
      pagination: z.object({
        page: z.number().int().positive().optional(),
        page_size: z.number().int().positive().max(100).optional(),
      }).optional().describe('Pagination options'),
      sort: z.unknown().optional().describe('Sort options'),
    },
  },
  async ({ filters, pagination, sort }) => {
    try {
      const body: Record<string, unknown> = {};
      if (filters) body.filters = filters;
      if (pagination) body.pagination = pagination;
      if (sort) body.sort = sort;

      const result = await client.searchAssets(body);
      return {
        content: [{
          type: 'text',
          text: JSON.stringify({ assets: result.data, pagination: result.pagination }, null, 2),
        }],
      };
    } catch (error) {
      return {
        content: [{ type: 'text', text: `Error searching assets: ${error instanceof Error ? error.message : 'Unknown error'}` }],
        isError: true,
      };
    }
  }
);
```

- [ ] **Step 2: Typecheck + commit**

```bash
npm run typecheck
git add src/tools/assets.ts
git commit -m "feat: add assets_search tool"
```

### Task 13: Add assets_update tool

**Files:**
- Modify: `src/tools/assets.ts`

**Guardrail:** Only `filename` and `categories` are patchable — enforced at type level, schema level, and handler validation.

- [ ] **Step 1: Add tool**

```typescript
// UPDATE asset metadata (filename and categories only)
registerTool<{ asset_id: string; filename?: string; categories?: string[] }>(
  server,
  'assets_update',
  {
    title: 'Update Asset',
    description: 'Update asset metadata. Only filename and categories can be changed. No binary replacement.',
    inputSchema: {
      asset_id: z.string().min(1).describe('The asset ID'),
      filename: z.string().optional().describe('New filename for the asset'),
      categories: z.array(z.string()).optional().describe('Asset categories to set'),
    },
  },
  async ({ asset_id, filename, categories }) => {
    try {
      if (filename === undefined && categories === undefined) {
        return {
          content: [{ type: 'text', text: 'Error: At least one of filename or categories must be provided' }],
          isError: true,
        };
      }

      const data: { filename?: string; categories?: string[] } = {};
      if (filename !== undefined) data.filename = filename;
      if (categories !== undefined) data.categories = categories;

      await client.updateAsset(asset_id, data);
      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            success: true, action: 'updated', asset_id,
            ...(filename !== undefined ? { filename } : {}),
            ...(categories !== undefined ? { categories } : {}),
          }, null, 2),
        }],
      };
    } catch (error) {
      return {
        content: [{ type: 'text', text: `Error updating asset: ${error instanceof Error ? error.message : 'Unknown error'}` }],
        isError: true,
      };
    }
  }
);
```

- [ ] **Step 2: Typecheck + commit**

```bash
npm run typecheck
git add src/tools/assets.ts
git commit -m "feat: add assets_update tool"
```

---

## Phase 4: Category Search + Relationship Discovery Tools (stdio)

### Task 14: Add categories_search tool

**Files:**
- Modify: `src/tools/categories.ts` (before `categories_link`)

- [ ] **Step 1: Add tool**

```typescript
// SEARCH categories
registerTool<{ query?: string; pagination?: { page?: number; page_size?: number } }>(
  server,
  'categories_search',
  {
    title: 'Search Categories',
    description: 'Search existing product categories by name.',
    inputSchema: {
      query: z.string().optional().describe('Search query to filter categories by name'),
      pagination: z.object({
        page: z.number().int().positive().optional(),
        page_size: z.number().int().positive().max(100).optional(),
      }).optional().describe('Pagination options'),
    },
  },
  async ({ query, pagination }) => {
    try {
      const body: Record<string, unknown> = {};
      if (pagination) body.pagination = pagination;
      if (query) body.filters = [[{ field: 'name', operator: 'like', value: query }]];

      const result = await client.searchCategories(body);
      return {
        content: [{
          type: 'text',
          text: JSON.stringify({ categories: result.data, pagination: result.pagination }, null, 2),
        }],
      };
    } catch (error) {
      return {
        content: [{ type: 'text', text: `Error searching categories: ${error instanceof Error ? error.message : 'Unknown error'}` }],
        isError: true,
      };
    }
  }
);
```

- [ ] **Step 2: Typecheck + commit**

```bash
npm run typecheck
git add src/tools/categories.ts
git commit -m "feat: add categories_search tool"
```

### Task 15: Add relationships_get tool

**Files:**
- Modify: `src/tools/relationships.ts` (at top of function, before existing tools)

- [ ] **Step 1: Add tool**

```typescript
// GET relationship definition by ID
registerTool<{ relationship_id: string }>(
  server,
  'relationships_get',
  {
    title: 'Get Relationship',
    description: 'Get a relationship definition by ID.',
    inputSchema: {
      relationship_id: z.string().min(1).describe('The relationship definition ID'),
    },
  },
  async ({ relationship_id }) => {
    try {
      const result = await client.getRelationship(relationship_id);
      const rel = result.data?.[0];
      if (!rel) {
        return { content: [{ type: 'text', text: `Relationship not found: ${relationship_id}` }], isError: true };
      }
      return { content: [{ type: 'text', text: JSON.stringify(rel, null, 2) }] };
    } catch (error) {
      return {
        content: [{ type: 'text', text: `Error fetching relationship: ${error instanceof Error ? error.message : 'Unknown error'}` }],
        isError: true,
      };
    }
  }
);
```

- [ ] **Step 2: Typecheck + commit**

```bash
npm run typecheck
git add src/tools/relationships.ts
git commit -m "feat: add relationships_get tool"
```

### Task 16: Add relationships_search tool

**Files:**
- Modify: `src/tools/relationships.ts`

- [ ] **Step 1: Add tool**

```typescript
// SEARCH relationship definitions
registerTool<{ query?: string; pagination?: { page?: number; page_size?: number } }>(
  server,
  'relationships_search',
  {
    title: 'Search Relationships',
    description: 'Search or list available relationship definitions.',
    inputSchema: {
      query: z.string().optional().describe('Search query to filter relationships by name'),
      pagination: z.object({
        page: z.number().int().positive().optional(),
        page_size: z.number().int().positive().max(100).optional(),
      }).optional().describe('Pagination options'),
    },
  },
  async ({ query, pagination }) => {
    try {
      const body: Record<string, unknown> = {};
      if (pagination) body.pagination = pagination;
      if (query) body.filters = [[{ field: 'label', operator: 'like', value: query }]];

      const result = await client.searchRelationships(body);
      return {
        content: [{
          type: 'text',
          text: JSON.stringify({ relationships: result.data, pagination: result.pagination }, null, 2),
        }],
      };
    } catch (error) {
      return {
        content: [{ type: 'text', text: `Error searching relationships: ${error instanceof Error ? error.message : 'Unknown error'}` }],
        isError: true,
      };
    }
  }
);
```

- [ ] **Step 2: Typecheck + commit**

```bash
npm run typecheck
git add src/tools/relationships.ts
git commit -m "feat: add relationships_search tool"
```

---

## Phase 5: Family Operation Tools (stdio)

### Task 17: Add families_create tool

**Files:**
- Modify: `src/tools/families.ts`

- [ ] **Step 1: Add tool**

```typescript
// CREATE family
registerTool<{ name: string; parent_id?: string }>(
  server,
  'families_create',
  {
    title: 'Create Product Family',
    description: 'Create a new product family. Optionally specify a parent family for inheritance.',
    inputSchema: {
      name: z.string().min(1).describe('Name for the new family'),
      parent_id: z.string().optional().describe('Optional parent family ID for inheritance'),
    },
  },
  async ({ name, parent_id }) => {
    try {
      const data: { name: string; parent_id?: string } = { name };
      if (parent_id !== undefined) data.parent_id = parent_id;

      const result = await client.createFamily(data);
      const family = result.data?.[0];
      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            success: true, action: 'created',
            family: family ? { id: family.id, name: family.name } : undefined,
          }, null, 2),
        }],
      };
    } catch (error) {
      return {
        content: [{ type: 'text', text: `Error creating family: ${error instanceof Error ? error.message : 'Unknown error'}` }],
        isError: true,
      };
    }
  }
);
```

- [ ] **Step 2: Typecheck + commit**

```bash
npm run typecheck
git add src/tools/families.ts
git commit -m "feat: add families_create tool"
```

### Task 18: Add families_link_attribute + families_unlink_attribute tools

**Files:**
- Modify: `src/tools/families.ts`

- [ ] **Step 1: Add both tools**

```typescript
// LINK attributes to family
registerTool<{ family_id: string; attribute_labels: string[] }>(
  server,
  'families_link_attribute',
  {
    title: 'Link Attribute to Family',
    description: 'Link one or more attributes to a product family.',
    inputSchema: {
      family_id: z.string().min(1).describe('The product family ID'),
      attribute_labels: z.array(z.string()).min(1).describe('Attribute labels to link (snake_case identifiers)'),
    },
  },
  async ({ family_id, attribute_labels }) => {
    try {
      await client.linkFamilyAttributes(family_id, attribute_labels);
      return {
        content: [{
          type: 'text',
          text: JSON.stringify({ success: true, action: 'linked', family_id, attribute_labels, count: attribute_labels.length }, null, 2),
        }],
      };
    } catch (error) {
      return {
        content: [{ type: 'text', text: `Error linking attributes: ${error instanceof Error ? error.message : 'Unknown error'}` }],
        isError: true,
      };
    }
  }
);

// UNLINK attributes from family
registerTool<{ family_id: string; attribute_labels: string[] }>(
  server,
  'families_unlink_attribute',
  {
    title: 'Unlink Attribute from Family',
    description: 'Remove one or more attributes from a product family.',
    inputSchema: {
      family_id: z.string().min(1).describe('The product family ID'),
      attribute_labels: z.array(z.string()).min(1).describe('Attribute labels to unlink (snake_case identifiers)'),
    },
  },
  async ({ family_id, attribute_labels }) => {
    try {
      await client.unlinkFamilyAttributes(family_id, attribute_labels);
      return {
        content: [{
          type: 'text',
          text: JSON.stringify({ success: true, action: 'unlinked', family_id, attribute_labels, count: attribute_labels.length }, null, 2),
        }],
      };
    } catch (error) {
      return {
        content: [{ type: 'text', text: `Error unlinking attributes: ${error instanceof Error ? error.message : 'Unknown error'}` }],
        isError: true,
      };
    }
  }
);
```

- [ ] **Step 2: Typecheck + commit**

```bash
npm run typecheck
git add src/tools/families.ts
git commit -m "feat: add families_link_attribute and families_unlink_attribute tools"
```

### Task 19: Add families_list_attributes + families_list_all_attributes tools

**Files:**
- Modify: `src/tools/families.ts`

- [ ] **Step 1: Add both tools**

```typescript
// LIST family attributes (directly linked only)
registerTool<{ family_id: string }>(
  server,
  'families_list_attributes',
  {
    title: 'List Family Attributes',
    description: 'List attributes directly linked to a family (not inherited from parent).',
    inputSchema: {
      family_id: z.string().min(1).describe('The product family ID'),
    },
  },
  async ({ family_id }) => {
    try {
      const result = await client.getFamilyAttributes(family_id);
      return {
        content: [{
          type: 'text',
          text: JSON.stringify({ family_id, attributes: result.data, count: result.data?.length ?? 0 }, null, 2),
        }],
      };
    } catch (error) {
      return {
        content: [{ type: 'text', text: `Error listing family attributes: ${error instanceof Error ? error.message : 'Unknown error'}` }],
        isError: true,
      };
    }
  }
);

// LIST all family attributes (including inherited)
registerTool<{ family_id: string }>(
  server,
  'families_list_all_attributes',
  {
    title: 'List All Family Attributes',
    description: 'List all attributes for a family, including those inherited from parent families.',
    inputSchema: {
      family_id: z.string().min(1).describe('The product family ID'),
    },
  },
  async ({ family_id }) => {
    try {
      const result = await client.getFamilyAllAttributes(family_id);
      return {
        content: [{
          type: 'text',
          text: JSON.stringify({ family_id, attributes: result.data, count: result.data?.length ?? 0 }, null, 2),
        }],
      };
    } catch (error) {
      return {
        content: [{ type: 'text', text: `Error listing all family attributes: ${error instanceof Error ? error.message : 'Unknown error'}` }],
        isError: true,
      };
    }
  }
);
```

- [ ] **Step 2: Typecheck + commit**

```bash
npm run typecheck
git add src/tools/families.ts
git commit -m "feat: add families_list_attributes and families_list_all_attributes tools"
```

---

## Phase 6: Filter Discovery Split (stdio)

### Task 20: Deprecate attributes_filters, add products_filters + assets_filters + relationships_filters

**Files:**
- Modify: `src/tools/attributes.ts`

**Strategy:** Keep `attributes_filters` as a deprecated alias (returns product filters with a deprecation notice). Add three new explicit filter tools.

- [ ] **Step 1: Replace the `attributes_filters` registration (~line 193-233) with four tools**

```typescript
// ─────────────────────────────────────────────────────────────
// attributes_filters (DEPRECATED - use products_filters instead)
// ─────────────────────────────────────────────────────────────

registerTool<Record<string, never>>(
  server,
  'attributes_filters',
  {
    title: 'Get Search Filters (Deprecated)',
    description:
      'DEPRECATED: Use products_filters, assets_filters, or relationships_filters instead. Returns product search filters for backwards compatibility.',
    inputSchema: {},
  },
  async () => {
    try {
      const result = await client.getAvailableFilters();
      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            deprecated: true,
            message: 'Use products_filters, assets_filters, or relationships_filters instead.',
            filters: result.data,
            count: result.data?.length ?? 0,
          }, null, 2),
        }],
      };
    } catch (error) {
      return {
        content: [{ type: 'text', text: `Error fetching filters: ${error instanceof Error ? error.message : 'Unknown error'}` }],
        isError: true,
      };
    }
  }
);

// ─────────────────────────────────────────────────────────────
// products_filters - Product search filter discovery
// ─────────────────────────────────────────────────────────────

registerTool<Record<string, never>>(
  server,
  'products_filters',
  {
    title: 'Product Search Filters',
    description: 'Get available product search filter fields, types, and operators.',
    inputSchema: {},
  },
  async () => {
    try {
      const result = await client.getAvailableFilters();
      return {
        content: [{
          type: 'text',
          text: JSON.stringify({ resource: 'products', filters: result.data, count: result.data?.length ?? 0 }, null, 2),
        }],
      };
    } catch (error) {
      return {
        content: [{ type: 'text', text: `Error fetching product filters: ${error instanceof Error ? error.message : 'Unknown error'}` }],
        isError: true,
      };
    }
  }
);

// ─────────────────────────────────────────────────────────────
// assets_filters - Asset search filter discovery
// ─────────────────────────────────────────────────────────────

registerTool<Record<string, never>>(
  server,
  'assets_filters',
  {
    title: 'Asset Search Filters',
    description: 'Get available asset search filter fields, types, and operators.',
    inputSchema: {},
  },
  async () => {
    try {
      const result = await client.getAssetFilters();
      return {
        content: [{
          type: 'text',
          text: JSON.stringify({ resource: 'assets', filters: result.data, count: result.data?.length ?? 0 }, null, 2),
        }],
      };
    } catch (error) {
      return {
        content: [{ type: 'text', text: `Error fetching asset filters: ${error instanceof Error ? error.message : 'Unknown error'}` }],
        isError: true,
      };
    }
  }
);

// ─────────────────────────────────────────────────────────────
// relationships_filters - Relationship search filter discovery
// ─────────────────────────────────────────────────────────────

registerTool<Record<string, never>>(
  server,
  'relationships_filters',
  {
    title: 'Relationship Search Filters',
    description: 'Get available relationship search filter fields, types, and operators.',
    inputSchema: {},
  },
  async () => {
    try {
      const result = await client.getRelationshipFilters();
      return {
        content: [{
          type: 'text',
          text: JSON.stringify({ resource: 'relationships', filters: result.data, count: result.data?.length ?? 0 }, null, 2),
        }],
      };
    } catch (error) {
      return {
        content: [{ type: 'text', text: `Error fetching relationship filters: ${error instanceof Error ? error.message : 'Unknown error'}` }],
        isError: true,
      };
    }
  }
);
```

- [ ] **Step 2: Typecheck + commit**

```bash
npm run typecheck
git add src/tools/attributes.ts
git commit -m "feat: deprecate attributes_filters, add products_filters/assets_filters/relationships_filters"
```

---

## Phase 7: Worker Parity — Variant + Asset Tools

### Task 21: Add variant lifecycle tool definitions to worker.ts

**Files:**
- Modify: `src/worker.ts`

- [ ] **Step 1: Add `variants_create`, `variants_link`, `variants_unlink` tool definitions and handlers**

Follow the existing worker pattern: add a `ToolDefinition` entry with JSON Schema `inputSchema`, and a handler that calls `WorkerPlytixClient` methods. Match the response shapes from the stdio tools.

- [ ] **Step 2: Typecheck**

Run: `npm run typecheck`

- [ ] **Step 3: Commit**

```bash
git add src/worker.ts
git commit -m "feat: add variant lifecycle tools to worker runtime"
```

### Task 22: Add asset operation tool definitions to worker.ts

**Files:**
- Modify: `src/worker.ts`

- [ ] **Step 1: Add `assets_get`, `assets_search`, `assets_update` tool definitions and handlers**

Ensure `assets_update` handler enforces the same filename+categories-only restriction.

- [ ] **Step 2: Typecheck + commit**

```bash
npm run typecheck
git add src/worker.ts
git commit -m "feat: add asset operation tools to worker runtime"
```

---

## Phase 8: Worker Parity — Category, Relationship, Family Tools

### Task 23: Add category search tool definition to worker.ts

**Files:**
- Modify: `src/worker.ts`

- [ ] **Step 1: Add `categories_search` tool definition and handler**

- [ ] **Step 2: Typecheck + commit**

```bash
npm run typecheck
git add src/worker.ts
git commit -m "feat: add categories_search tool to worker runtime"
```

### Task 24: Add relationship discovery tool definitions to worker.ts

**Files:**
- Modify: `src/worker.ts`

- [ ] **Step 1: Add `relationships_get`, `relationships_search` tool definitions and handlers**

- [ ] **Step 2: Typecheck + commit**

```bash
npm run typecheck
git add src/worker.ts
git commit -m "feat: add relationship discovery tools to worker runtime"
```

### Task 25: Add family operation tool definitions to worker.ts

**Files:**
- Modify: `src/worker.ts`

- [ ] **Step 1: Add `families_create`, `families_link_attribute`, `families_unlink_attribute`, `families_list_attributes`, `families_list_all_attributes` tool definitions and handlers**

- [ ] **Step 2: Typecheck + commit**

```bash
npm run typecheck
git add src/worker.ts
git commit -m "feat: add family operation tools to worker runtime"
```

---

## Phase 9: Worker Parity — Filter Discovery Split

### Task 26: Deprecate + replace filter tools in worker.ts

**Files:**
- Modify: `src/worker.ts`

- [ ] **Step 1: Mark existing `attributes_filters` as deprecated in worker, add `products_filters`, `assets_filters`, `relationships_filters`**

Keep `attributes_filters` handler with deprecation notice in response (same as stdio).

- [ ] **Step 2: Typecheck + commit**

```bash
npm run typecheck
git add src/worker.ts
git commit -m "feat: deprecate attributes_filters, add split filter tools to worker runtime"
```

---

## Phase 10: Build + Integration Verification

### Task 27: Full build

- [ ] **Step 1: Build**

Run: `npm run build`
Expected: Clean build, no errors

- [ ] **Step 2: Run unit tests**

Run: `npm test -- --run`
Expected: All existing tests pass

### Task 28: MCP handshake verification

- [ ] **Step 1: Run MCP handshake test**

Run: `npm run test:mcp`
Expected: All tools listed including new ones

- [ ] **Step 2: Verify tool count**

Stdio runtime should list ~49 tools:
- 30 existing (including deprecated `attributes_filters`)
- +3 variant tools
- +3 asset tools
- +1 category tool
- +2 relationship tools
- +7 family tools (create + link_attr + unlink_attr + list_attrs + list_all_attrs + ... wait, 5 not 7)
- +3 filter tools

Corrected: 30 existing + 17 new = 47 stdio tools (keeping deprecated `attributes_filters`).

Worker runtime: 27 existing + 17 new = 44 worker tools.

### Task 29: Run full test suite

- [ ] **Step 1: Run all tests**

Run: `npm run test:all`
Expected: All pass (build + unit + integration + MCP)

---

## Phase 11: Documentation Update

### Task 30: Update CLAUDE.md tool tables

**Files:**
- Modify: `CLAUDE.md`

- [ ] **Step 1: Add new tools to Read Operations table**

Add: `assets_get`, `assets_search`, `categories_search`, `relationships_get`, `relationships_search`, `families_list_attributes`, `families_list_all_attributes`, `products_filters`, `assets_filters`, `relationships_filters`

- [ ] **Step 2: Add new tools to Write Operations table**

Add: `variants_create`, `variants_link`, `variants_unlink`, `assets_update`, `families_create`, `families_link_attribute`, `families_unlink_attribute`

- [ ] **Step 3: Mark `attributes_filters` as deprecated in the table**

- [ ] **Step 4: Commit**

```bash
git add CLAUDE.md
git commit -m "docs: update CLAUDE.md with new MCP tool surface"
```

---

## Deprecated Tools

| Old Tool | Status | Replacement |
|----------|--------|------------|
| `attributes_filters` | Deprecated (kept for backwards compat) | `products_filters` |

## New Tools Summary (17)

| Tool | Type | Phase |
|------|------|-------|
| `variants_create` | Write | 2 |
| `variants_link` | Write | 2 |
| `variants_unlink` | Write | 2 |
| `assets_get` | Read | 3 |
| `assets_search` | Read | 3 |
| `assets_update` | Write | 3 |
| `categories_search` | Read | 4 |
| `relationships_get` | Read | 4 |
| `relationships_search` | Read | 4 |
| `families_create` | Write | 5 |
| `families_link_attribute` | Write | 5 |
| `families_unlink_attribute` | Write | 5 |
| `families_list_attributes` | Read | 5 |
| `families_list_all_attributes` | Read | 5 |
| `products_filters` | Read | 6 |
| `assets_filters` | Read | 6 |
| `relationships_filters` | Read | 6 |

## Safety Guardrails

| Guardrail | Enforcement |
|-----------|------------|
| No product delete | No `products_delete` tool exists |
| No asset binary ops | `assets_update` restricted to `filename` + `categories` only |
| No category admin | Only search + link/unlink; no create/update/delete |
| No relationship def CRUD | Only get + search; no create/update/delete |
| No family delete | No `families_delete` tool exists |
| No attribute schema mutation | No `attributes_update` tool exists |
| No account admin | No auth/membership tools exposed |
| Variant unlink ≠ delete | `variants_unlink` detaches without deleting the product |
| Filter deprecation | `attributes_filters` kept as deprecated alias, not removed |

## Unverified API Endpoints

These endpoints come from the spec and should be manually verified before implementation:

| Endpoint | Tool | Concern |
|----------|------|---------|
| `POST /api/v1/products/{id}/variant/{id}` | `variants_link` | Singular `/variant/` vs plural `/variants` |
| `DELETE /api/v1/products/{id}/variant/{id}` | `variants_unlink` | Same singular/plural concern |
| `POST /api/v1/categories/product/search` | `categories_search` | Standalone category search path unverified |
| `GET /api/v1/relationships/{id}` | `relationships_get` | Standalone relationship def endpoint unverified |
| `POST /api/v1/relationships/search` | `relationships_search` | Same |
| `GET /api/v1/assets/search/filters` | `assets_filters` | Parallel to product filters, unverified |
| `GET /api/v1/relationships/search/filters` | `relationships_filters` | Same |
