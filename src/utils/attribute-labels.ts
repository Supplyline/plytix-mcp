/**
 * Attribute label helpers shared across stdio and worker runtimes.
 */

export function stripAttributesPrefix(label: string): string {
  const trimmed = label.trim();
  return trimmed.startsWith('attributes.') ? trimmed.slice('attributes.'.length) : trimmed;
}
