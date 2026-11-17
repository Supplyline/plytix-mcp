import { objectId, result } from './catalog-tools.js';
import { PlytixError } from './types.js';
import type { PlytixProduct, ProductCreateData, PlytixResult } from './types.js';

export interface CreateProductInput {
  sku: string;
  label?: string;
  status?: string;
  attributes?: Record<string, unknown>;
  category_ids?: string[];
  asset_ids?: string[];
  thumbnail_id?: string;
}

export async function createProductWithLinks(
  client: {
    createProduct(data: ProductCreateData): Promise<PlytixResult<PlytixProduct>>;
    getProduct(id: string): Promise<PlytixResult<PlytixProduct>>;
  },
  input: CreateProductInput,
) {
  const { category_ids, asset_ids, thumbnail_id, sku, label, status, attributes } = input;
  const data: ProductCreateData = { sku };
  if (label !== undefined) data.label = label;
  if (status !== undefined) data.status = status;
  if (attributes !== undefined) data.attributes = attributes;
  if (category_ids?.length) data.categories = category_ids.map((id) => ({ id }));
  if (asset_ids?.length) data.assets = asset_ids.map((id) => ({ id }));
  if (thumbnail_id !== undefined) data.thumbnail = { id: objectId.parse(thumbnail_id) };

  let created: PlytixProduct | undefined;
  try {
    created = (await client.createProduct(data)).data?.[0];
  } catch (e) {
    if (
      thumbnail_id === undefined ||
      (e instanceof PlytixError && e.status && e.status >= 400 && e.status < 500)
    )
      throw e;
    return result({ sku, outcome: 'unverified', retry: 'reconcile by exact SKU before replay' }, true);
  }
  if (!created?.id && thumbnail_id !== undefined)
    return result({ sku, outcome: 'unverified', retry: 'reconcile by exact SKU before replay' }, true);
  if (!created?.id)
    return {
      content: [{ type: 'text' as const, text: 'Product creation failed: no ID returned from API' }],
      isError: true,
    };
  if (thumbnail_id !== undefined) {
    let observed: PlytixProduct | undefined;
    for (let attempt = 0; attempt < 3; attempt++) {
      if (attempt) await new Promise((resolve) => setTimeout(resolve, 250 * attempt));
      try {
        observed = (await client.getProduct(created.id)).data[0];
        const thumbnail = observed?.thumbnail;
        if (
          observed?.id === created.id &&
          observed.sku === sku &&
          typeof thumbnail === 'object' &&
          thumbnail !== null &&
          'id' in thumbnail &&
          thumbnail.id === data.thumbnail?.id
        )
          return result({ success: true, id: created.id, created: created.created, thumbnail_id });
      } catch {
        // The creation has already been submitted. Only repeat the read.
      }
    }
    return result(
      {
        id: created.id,
        outcome: 'unverified',
        requested_thumbnail_id: thumbnail_id,
        observed_thumbnail: observed?.thumbnail,
        retry: 'reconcile the existing product before replay',
      },
      true,
    );
  }
  return result({ success: true, id: created.id, created: created.created });
}
