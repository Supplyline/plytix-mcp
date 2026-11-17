import { z } from 'zod';
import {
  catalogTool,
  objectId,
  page,
  pageSize,
  post,
  result,
  type CatalogClient,
} from './catalog-tools.js';
import { authorizeDelete, makeDryRunResult, reserveDeleteSlot } from './safety.js';
import { PlytixError } from './types.js';

type Row = Record<string, unknown> & { id: string };
const routes = {
  assets: '/api/v1/assets',
  asset_categories: '/api/v1/categories/file',
  categories: '/api/v1/categories/product',
  families: '/api/v1/product_families',
  relationship_types: '/api/v1/relationships',
  attribute_groups: '/api/v1/attribute-groups/product',
} as const;
type Resource = keyof typeof routes;
const name = z.string().trim().min(1);
const categoryFields = ['name', 'path', 'parents_ids', 'order', 'n_children'];
const isCategory = (resource: Resource) => resource === 'categories' || resource === 'asset_categories';

async function readEntity(client: CatalogClient, resource: Resource, id: string): Promise<Row | null> {
  try {
    const response = isCategory(resource)
      ? await client.call<Row>(
          routes[resource] + '/search',
          post({
            attributes: categoryFields,
            filters: [[{ field: 'id', operator: 'eq', value: id }]],
            pagination: { page: 1, page_size: 1 },
          }),
        )
      : await client.call<Row>(routes[resource] + '/' + id);
    const row = response.data[0];
    if (row && row.id !== id) throw new Error('Upstream read returned a different resource');
    return row ?? null;
  } catch (e) {
    if (!isCategory(resource) && e instanceof PlytixError && e.status === 404) return null;
    throw e;
  }
}

async function writeAndVerify(
  client: CatalogClient,
  resource: Resource,
  path: string,
  body: Record<string, unknown>,
  id: string | undefined,
  matches: (row: Row) => boolean,
) {
  let failure: string | undefined;
  try {
    const response = await client.call<Row>(path, {
      method: id ? 'PATCH' : 'POST',
      body: JSON.stringify(body),
    });
    id ??= response.data?.[0]?.id;
  } catch (e) {
    if (e instanceof PlytixError && e.status && e.status >= 400 && e.status < 500) throw e;
    failure = 'Upstream submission outcome unknown';
  }
  if (!id || !objectId.safeParse(id).success)
    return result(
      {
        outcome: 'unverified',
        error: failure ?? 'No canonical ID returned',
        retry: 'reconcile before replay',
      },
      true,
    );
  let observed: Row | null = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    if (attempt) await new Promise((resolve) => setTimeout(resolve, 250 * attempt));
    try {
      observed = await readEntity(client, resource, id);
      if (observed && matches(observed))
        return result({ id, outcome: 'verified', observed, submission_error: failure });
    } catch {
      // Retry only the independent read. Preserve the last successfully observed row.
    }
  }
  return result(
    {
      id,
      outcome: 'unverified',
      observed,
      error: failure ?? 'Readback did not confirm the requested state',
    },
    true,
  );
}

const groupOrder = z.number().int().nonnegative().optional();
function writeGroup(client: CatalogClient, body: { name?: string; order?: number }, id?: string) {
  if (!Object.keys(body).length) throw new Error('Supply name or order');
  return writeAndVerify(
    client,
    'attribute_groups',
    routes.attribute_groups + (id ? '/' + id : ''),
    body,
    id,
    (row) =>
      (body.name === undefined || row.name === body.name) &&
      (body.order === undefined || String(row.order) === String(body.order)),
  );
}

function namedUpdate(tool: string, resource: Resource) {
  return catalogTool(
    tool,
    'Rename one ' + resource + ' record by ID and read it back.',
    { id: objectId, name },
    (a, c) =>
      writeAndVerify(
        c,
        resource,
        routes[resource] + '/' + a.id,
        { name: a.name },
        a.id,
        (row) => row.name === a.name,
      ),
  );
}

function namedCreate(tool: string, resource: Resource) {
  return catalogTool(tool, 'Create one ' + resource + ' record and read it back.', { name }, (a, c) =>
    writeAndVerify(
      c,
      resource,
      routes[resource],
      { name: a.name },
      undefined,
      (row) => row.name === a.name,
    ),
  );
}

async function usage(client: CatalogClient, resource: Resource, row: Row) {
  if (resource === 'families') return { products: row.total_products };
  if (resource === 'assets') return { products: row.n_products, catalogs: row.n_catalogs };
  if (resource === 'attribute_groups') {
    if (!Array.isArray(row.attribute_labels)) throw new Error('Missing attribute membership');
    return { labels: [...row.attribute_labels].sort() };
  }
  const relation = resource === 'relationship_types';
  const response = await client.call(
    relation ? '/api/v1/products/search' : '/api/v1/assets/search',
    post({
      ...(relation
        ? { relationship_filters: [[{ relationship_id: row.id, operator: 'exists' }]] }
        : { filters: [[{ field: 'categories', operator: 'in', value: [row.id] }]] }),
      pagination: { page: 1, page_size: 1 },
    }),
  );
  return relation
    ? { linked_sources: response.pagination?.count }
    : { children: row.n_children, assets: response.pagination?.count };
}

function gatedDelete(resource: Exclude<Resource, 'categories'>) {
  const tool = resource + '_delete';
  return catalogTool(
    tool,
    'Preview and confirm deletion by exact ID. Reports dependencies before removal.',
    { id: objectId, dry_run: z.boolean().optional(), confirm_token: z.string().optional() },
    async (a, c) => {
      const row = await readEntity(c, resource, a.id);
      if (!row) return result({ id: a.id, outcome: 'absent' }, !!a.dry_run);
      const dependencies = await usage(c, resource, row);
      // Group deletion removes the grouping, not the definitions. For cascades, a count
      // alone cannot identify which dependents are covered by a confirmation token.
      for (const [kind, count] of Object.entries(dependencies)) {
        if (kind === 'labels') continue;
        if (count !== 0)
          return result(
            {
              id: a.id,
              outcome: 'refused',
              dependencies,
              reason: 'Deletion requires confirmed zero dependent records',
            },
            true,
          );
      }
      const preview = { id: a.id, name: row.name ?? row.filename, dependencies };
      if (a.dry_run) {
        const gate = makeDryRunResult(tool, a.id, preview);
        return gate.ok ? result(gate.result) : result({ error: gate.reason }, true);
      }
      const gate = authorizeDelete(tool, a.id, a.confirm_token);
      if (!gate.ok) return result({ error: gate.reason }, true);
      if (JSON.stringify(preview) !== JSON.stringify(gate.preview))
        return result({ outcome: 'conflict', preview }, true);
      const slot = reserveDeleteSlot();
      if (!slot.ok) return result({ error: slot.reason }, true);
      let submissionError: string | undefined;
      try {
        await c.call(routes[resource] + '/' + a.id, { method: 'DELETE' });
      } catch (e) {
        if (e instanceof PlytixError && e.status && e.status >= 400 && e.status < 500) {
          slot.releaseUnused();
          if (e.status === 404) return result({ id: a.id, outcome: 'absent' });
          throw e;
        }
        submissionError = 'Uncertain delete response';
      }
      for (let attempt = 0; attempt < 3; attempt++) {
        if (attempt) await new Promise((resolve) => setTimeout(resolve, 250 * attempt));
        try {
          if (!(await readEntity(c, resource, a.id))) {
            return result({ id: a.id, outcome: 'verified_absent', submission_error: submissionError });
          }
        } catch {
          /* Retry the read only. */
        }
      }
      return result({ id: a.id, outcome: 'unverified', submission_error: submissionError }, true);
    },
  );
}

export const adminTools = [
  catalogTool(
    'attribute_groups_create',
    'Create a product attribute group with optional zero-based order.',
    { name, order: groupOrder },
    (a, c) => writeGroup(c, a),
  ),
  catalogTool(
    'attribute_groups_update',
    'Rename or reorder a product attribute group and check the resulting position.',
    { id: objectId, name: name.optional(), order: groupOrder },
    ({ id, ...body }, c) => writeGroup(c, body, id),
  ),
  namedCreate('relationship_types_create', 'relationship_types'),
  namedUpdate('relationship_types_update', 'relationship_types'),
  namedUpdate('families_update', 'families'),
  ...(['families', 'assets', 'attribute_groups', 'relationship_types', 'asset_categories'] as const).map(
    gatedDelete,
  ),
  catalogTool('categories_get', 'Get a product category by exact ID.', { id: objectId }, async (a, c) =>
    result({ category: await readEntity(c, 'categories', a.id) }),
  ),
  catalogTool(
    'categories_get_membership',
    'Get one product/category membership. The returned category describes the tree node.',
    { product_id: objectId, category_id: objectId },
    async (a, c) =>
      result(await c.call('/api/v1/products/' + a.product_id + '/categories/' + a.category_id)),
  ),
  catalogTool(
    'asset_categories_get',
    'Get a DAM category by exact ID.',
    { id: objectId },
    async (a, c) => result({ category: await readEntity(c, 'asset_categories', a.id) }),
  ),
  catalogTool(
    'asset_categories_search',
    'Page through DAM categories, optionally filtering by name.',
    { query: name.optional(), page, page_size: pageSize },
    async (a, c) =>
      result(
        await c.call(
          routes.asset_categories + '/search',
          post({
            attributes: categoryFields,
            filters: a.query ? [[{ field: 'name', operator: 'like', value: a.query }]] : [],
            pagination: { page: a.page, page_size: a.page_size },
          }),
        ),
      ),
  ),
  catalogTool(
    'asset_categories_create',
    'Create a root or child DAM category.',
    { name, parent_id: objectId.optional() },
    (a, c) =>
      writeAndVerify(
        c,
        'asset_categories',
        routes.asset_categories + (a.parent_id ? '/' + a.parent_id : ''),
        { name: a.name },
        undefined,
        (row) =>
          row.name === a.name &&
          Array.isArray(row.parents_ids) &&
          (row.parents_ids.slice(-1)[0] ?? '') === (a.parent_id ?? ''),
      ),
  ),
  catalogTool(
    'asset_categories_update',
    'Rename or move a DAM category. Use an empty parent_id for root.',
    { id: objectId, name: name.optional(), parent_id: z.union([objectId, z.literal('')]).optional() },
    async ({ id, ...body }, c) => {
      if (!Object.keys(body).length) throw new Error('Supply name or parent_id');
      return writeAndVerify(
        c,
        'asset_categories',
        routes.asset_categories + '/' + id,
        body,
        id,
        (row) =>
          (body.name === undefined || row.name === body.name) &&
          (body.parent_id === undefined ||
            (Array.isArray(row.parents_ids) && (row.parents_ids.slice(-1)[0] ?? '') === body.parent_id)),
      );
    },
  ),
  catalogTool(
    'assets_create',
    'Create a DAM file from a public HTTP(S) URL or up to 4 MiB of base64 text with filename.',
    {
      url: z.url({ protocol: /^https?$/ }).optional(),
      content: z
        .string()
        .min(4)
        .max(4 * 1024 * 1024)
        .base64()
        .optional(),
      filename: name.optional(),
    },
    async (a, c) => {
      if ((a.url === undefined) === (a.content === undefined))
        throw new Error('Supply exactly one of url or content');
      if (a.content && !a.filename) throw new Error('Content requires filename');
      return writeAndVerify(
        c,
        'assets',
        routes.assets,
        a,
        undefined,
        (row) =>
          (a.filename === undefined || row.filename === a.filename) &&
          (a.content === undefined ||
            row.file_size === (a.content.length / 4) * 3 - (a.content.match(/=+$/)?.[0].length ?? 0)),
      );
    },
  ),
];
