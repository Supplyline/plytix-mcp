import { Env, HydratedRef, Product, RelationshipName } from "./types.js";
import { PlytixClient } from "./plytixClient.js";
import { mapToHydratedRef } from "./mappers.js";

const REL_FIELDS: RelationshipName[] = [
  "replaces",
  "includes",
  "modules",
  "has_optional_accessory",
];

export async function hydrateRelationships(
  product: Product,
  opts: { relationshipFilter?: RelationshipName[]; client: PlytixClient; env: Env }
): Promise<Product> {
  const { relationshipFilter, client, env } = opts;
  const fields =
    relationshipFilter?.filter((f): f is RelationshipName =>
      (REL_FIELDS as string[]).includes(f)
    ) ?? REL_FIELDS;

  const idSet = new Set<string>();
  const fieldIds = new Map<RelationshipName, string[]>();

  for (const f of fields) {
    const arr = product[f] as string[] | undefined;
    if (Array.isArray(arr) && arr.length) {
      const ids = arr.filter((x): x is string => typeof x === "string");
      fieldIds.set(f, ids);
      ids.forEach((id) => idSet.add(id));
    }
  }

  if (idSet.size === 0) return product;

  const ids = Array.from(idSet);
  const fetched = await client.getProductsByIds(ids);
  const byId = new Map<string, HydratedRef>();
  for (const p of fetched) {
    byId.set(p.id, mapToHydratedRef(p, env));
  }

  const out: Product = { ...product };
  for (const [f, ids] of fieldIds) {
    const hyd = ids
      .map((id) => byId.get(id))
      .filter((h): h is HydratedRef => !!h);
    (out as any)[f] = hyd;
  }
  return out;
}
