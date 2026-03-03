/**
 * Attribute value validation shared across stdio and worker runtimes.
 */

import type { PlytixAttributeDetail } from '../types.js';

/**
 * Validate a value against an attribute's type and allowed options.
 * Returns an error message string if invalid, null if valid.
 */
export function validateAttributeValue(attribute: PlytixAttributeDetail, value: unknown): string | null {
  const options = attribute.options ?? [];

  if (options.length === 0) {
    return null;
  }

  if (attribute.type_class === 'DropdownAttribute') {
    if (typeof value !== 'string') {
      return `Attribute "${attribute.label}" expects a single string option`;
    }
    if (!options.includes(value)) {
      return `Invalid value for "${attribute.label}". Allowed options: ${options.join(', ')}`;
    }
    return null;
  }

  if (attribute.type_class === 'MultiSelectAttribute') {
    if (!Array.isArray(value) || value.some((v) => typeof v !== 'string')) {
      return `Attribute "${attribute.label}" expects an array of string options`;
    }

    const invalid = value.filter((v) => !options.includes(v));
    if (invalid.length > 0) {
      return `Invalid option(s) for "${attribute.label}": ${invalid.join(', ')}`;
    }
  }

  return null;
}
