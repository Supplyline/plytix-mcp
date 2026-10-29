import type { PlytixProduct } from '../types.js';

export const PRODUCT_GET_MAX_ATTRIBUTE_LABELS = 50;
export const PRODUCT_GET_DESCRIPTION =
  'Get one product by ID. Omit attribute_labels for the unchanged full product; ' +
  'provide it for an explicit local custom-attribute projection wrapper. Native fields remain unchanged.';
export const PRODUCT_GET_ATTRIBUTE_LABELS_DESCRIPTION =
  'Optional exact unprefixed custom attribute labels (max 50). [] omits all custom attribute values. ' +
  'Returns {product, projection}; missing_labels means absent in the fetched attributes, not null. ' +
  'Native fields and all overwritten_attributes remain. Local output filtering only, not an API query or size cap.';

/** Shared runtime gate: Worker discovery schemas are not execution validation. */
export function validateProductGetAttributeLabels(value: unknown): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length > PRODUCT_GET_MAX_ATTRIBUTE_LABELS) {
    throw new Error(`attribute_labels must be an array of at most ${PRODUCT_GET_MAX_ATTRIBUTE_LABELS} labels`);
  }
  for (const label of value) {
    if (typeof label !== 'string' || label.trim().length === 0 || label.startsWith('attributes.')) {
      throw new Error('attribute_labels must contain nonempty exact unprefixed custom attribute labels');
    }
  }
  // Enforce the input cap before deduplication. Never trim or case-fold label identity.
  return [...new Set(value as string[])];
}

export interface ProductGetProjection {
  product: PlytixProduct;
  projection: {
    scope: 'custom_attributes';
    requested_labels: string[];
    missing_labels: string[];
    source: 'local_response';
  };
}

/**
 * Display-only projection after the direct GET. Internal client, guard, and export
 * consumers keep the complete response. Labels must first pass the shared gate.
 */
export function projectProductGet(
  product: PlytixProduct,
  labels: string[] | undefined
): PlytixProduct | ProductGetProjection {
  if (labels === undefined) return product;
  const ownsAttributes = Object.prototype.hasOwnProperty.call(product, 'attributes');
  const attributes = ownsAttributes ? product.attributes : undefined;
  if (ownsAttributes && attributes !== null && (
    typeof attributes !== 'object' || Array.isArray(attributes) ||
    (Object.getPrototypeOf(attributes) !== Object.prototype && Object.getPrototypeOf(attributes) !== null)
  )) {
    throw new Error('Cannot project product: attributes must be an object, null, or absent');
  }
  const selected: Array<[string, unknown]> = [];
  const missing: string[] = [];
  for (const label of labels) {
    if (attributes && Object.prototype.hasOwnProperty.call(attributes, label)) {
      selected.push([label, attributes[label]]);
    } else {
      missing.push(label);
    }
  }
  return {
    product: {
      ...product,
      // Preserve absent/null distinctly. fromEntries safely owns __proto__/constructor.
      ...(attributes ? { attributes: Object.fromEntries(selected) } : {}),
    },
    projection: {
      scope: 'custom_attributes',
      requested_labels: [...labels],
      missing_labels: missing,
      source: 'local_response',
    },
  };
}
