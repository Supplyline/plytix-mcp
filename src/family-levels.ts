import { z } from 'zod';
import { ATTRIBUTE_LEVELS } from './schema-writes.js';
import { catalogTool, objectId, post, result, type CatalogClient } from './catalog-tools.js';
import { PlytixError } from './types.js';

export const familyLevel = z.enum(ATTRIBUTE_LEVELS);
const label = z.string().min(1);
const identity = {family_id: objectId, attribute_label: label};
type Level = z.infer<typeof familyLevel>;

async function observe(client: CatalogClient, family: string, labels: string[]) {
  const {data} = await client.getFamilyAttributes(family);
  return Promise.all(labels.map(async attribute_label => {
    const link = data.find(row => row.label === attribute_label);
    const id = link?.id ?? (await client.getAttributeByLabel(attribute_label))?.id;
    if (!id) throw new Error('Unknown attribute: ' + attribute_label);
    return {family_id: family, attribute_label, attribute_id: id,
      level: link ? familyLevel.parse(link.attribute_level) : null};
  }));
}

export async function changeFamilyLevel(client: CatalogClient, family: string, labels: string[],
  target: Level, operation: 'link' | 'edit', expected?: Level, dryRun = false) {
  objectId.parse(family);
  familyLevel.parse(target);
  const exact = [...new Set(z.array(label).min(1).parse(labels))];
  const before = await observe(client, family, exact);
  const conflict = before.some(row => operation === 'link'
    ? row.level !== null && row.level !== target
    : row.level === null || (expected !== undefined && expected !== row.level));
  const context = {family_id: family, requested_level: target, before};
  if (conflict) return result({...context, outcome: 'conflict'}, true);
  const changes = before.filter(row => row.level !== target);
  if (!changes.length || dryRun) return result({...context, outcome: changes.length ? 'preview' : 'no_op'});
  const body = operation === 'link'
    ? {attributes: changes.map(row => row.attribute_id), attributes_level: target}
    : {[target]: changes.map(row => 'attributes.' + row.attribute_label)};
  let writeError: string | undefined;
  try {
    await client.call('/api/v1/product_families/' + family + '/attributes/' + operation, post(body));
  } catch (error) {
    if (error instanceof PlytixError && error.status && error.status >= 400 && error.status < 500) throw error;
    writeError = String(error);
  }
  let after;
  let readError;
  for (let attempt = 0; attempt < 3; attempt++) {
    if (attempt) await new Promise(resolve => setTimeout(resolve, 500 * attempt));
    try {
      after = await observe(client, family, exact);
      if (after.every(row => row.level === target)) {
        return result({...context, after, outcome: 'verified', write_error: writeError});
      }
    } catch (error) { readError = String(error); }
  }
  return result({...context, after, write_error: writeError, read_error: readError, outcome: 'unverified'}, true);
}

export const familyTools = [
  catalogTool('families_get_attribute_level', 'Read one direct family association. A null level means unlinked.', identity,
    async (args, client) => result((await observe(client, args.family_id, [args.attribute_label]))[0])),
  catalogTool('families_set_attribute_level', 'Change an existing direct family association and read back its level.',
    {...identity, level: familyLevel, expected_level: familyLevel.optional(), dry_run: z.boolean().optional()},
    (args, client) => changeFamilyLevel(client, args.family_id, [args.attribute_label], args.level, 'edit', args.expected_level, args.dry_run)),
];
