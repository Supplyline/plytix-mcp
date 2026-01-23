/**
 * Identifier Tools
 *
 * Atomic primitives for identifier detection, normalization, and matching.
 * Exposes internal lookup logic as standalone tools for agent composition.
 */

import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import {
  detectIdentifierType,
  normalize,
  calculateSimilarity,
  type IdentifierType,
} from '../lookup/identifier.js';

// Pattern descriptions for detection results
const PATTERN_DESCRIPTIONS: Record<IdentifierType, string> = {
  id: 'MongoDB ObjectId (24-character hex)',
  gtin: 'GTIN/UPC/EAN (8/12/13/14 digits)',
  label: 'Product label (contains spaces)',
  mpn: 'Manufacturer part number (dashed alphanumeric)',
  sku: 'SKU (alphanumeric with separators)',
  mno: 'Model number (pure alphanumeric)',
  unknown: 'Unrecognized format',
};

export function registerIdentifierTools(server: McpServer) {
  // ─────────────────────────────────────────────────────────────
  // identifier.detect - Detect identifier type from raw value
  // ─────────────────────────────────────────────────────────────

  server.registerTool(
    'identifier_detect',
    {
      title: 'Detect Identifier Type',
      description:
        'Detect the type of a product identifier based on format patterns. ' +
        'Returns type (id, sku, mpn, mno, gtin, label) with confidence score. ' +
        'Use this to understand what kind of identifier you have before searching.',
      inputSchema: {
        value: z.string().describe('The identifier value to analyze'),
      },
    },
    async ({ value }) => {
      const result = detectIdentifierType(value);

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(
              {
                input: value,
                type: result.type,
                confidence: result.confidence,
                pattern_matched: PATTERN_DESCRIPTIONS[result.type],
              },
              null,
              2
            ),
          },
        ],
      };
    }
  );

  // ─────────────────────────────────────────────────────────────
  // identifier.normalize - Normalize identifier for comparison
  // ─────────────────────────────────────────────────────────────

  server.registerTool(
    'identifier_normalize',
    {
      title: 'Normalize Identifier',
      description:
        'Normalize a product identifier for comparison by removing special ' +
        'characters and converting to uppercase. Use this when comparing ' +
        'identifiers that may have different formatting.',
      inputSchema: {
        value: z.string().describe('The identifier value to normalize'),
      },
    },
    async ({ value }) => {
      const normalized = normalize(value);

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(
              {
                input: value,
                normalized,
              },
              null,
              2
            ),
          },
        ],
      };
    }
  );

  // ─────────────────────────────────────────────────────────────
  // match.score - Score a match between identifier and product data
  // ─────────────────────────────────────────────────────────────

  server.registerTool(
    'match_score',
    {
      title: 'Score Match',
      description:
        'Calculate match confidence between an identifier and product data. ' +
        'Checks common fields (sku, label, gtin, mpn) and returns the best match. ' +
        'Use this to verify if a product is a good match for an identifier.',
      inputSchema: {
        identifier: z.string().describe('The identifier to match'),
        product_data: z
          .record(z.unknown())
          .describe('Product data object with fields to check (sku, label, gtin, attributes.mpn, etc.)'),
        fields: z
          .array(z.string())
          .optional()
          .describe('Specific fields to check (defaults to sku, label, gtin)'),
      },
    },
    async ({ identifier, product_data, fields }) => {
      const fieldsToCheck = fields ?? ['sku', 'label', 'gtin'];
      let bestMatch = {
        confidence: 0,
        matched_field: null as string | null,
        matched_value: null as string | null,
        reason: 'No match found',
      };

      for (const field of fieldsToCheck) {
        // Support nested fields like "attributes.mpn"
        const value = getNestedValue(product_data, field);
        if (typeof value !== 'string') continue;

        const similarity = calculateSimilarity(identifier, value);

        if (similarity > bestMatch.confidence) {
          bestMatch = {
            confidence: similarity,
            matched_field: field,
            matched_value: value,
            reason:
              similarity === 1.0
                ? 'Exact match (normalized)'
                : 'Partial match (substring)',
          };
        }
      }

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(
              {
                identifier,
                ...bestMatch,
                fields_checked: fieldsToCheck,
              },
              null,
              2
            ),
          },
        ],
      };
    }
  );
}

/**
 * Get a nested value from an object using dot notation
 * e.g., getNestedValue({a: {b: 1}}, "a.b") => 1
 */
function getNestedValue(obj: Record<string, unknown>, path: string): unknown {
  const parts = path.split('.');
  let current: unknown = obj;

  for (const part of parts) {
    if (current === null || typeof current !== 'object') {
      return obj[path];
    }
    current = (current as Record<string, unknown>)[part];
  }

  return current ?? obj[path];
}
