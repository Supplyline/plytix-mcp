/**
 * Identifier Detection
 *
 * Pattern-based detection of product identifier types with confidence scoring.
 * Used by PlytixLookup to determine search strategies.
 */

export type IdentifierType = 'id' | 'sku' | 'mpn' | 'mno' | 'gtin' | 'label' | 'unknown';

export interface DetectionResult {
  type: IdentifierType;
  confidence: number;
}

/**
 * Auto-detects the type of identifier based on format patterns
 *
 * Confidence scores:
 * - 1.0: MongoDB ObjectId (24-char hex)
 * - 0.95: GTIN (8/12/13/14 digits)
 * - 0.9: Label (contains spaces)
 * - 0.8: MPN (dashed alphanumeric, no vendor prefix)
 * - 0.7: SKU (alphanumeric with separators)
 * - 0.6: MNO (pure alphanumeric)
 */
export function detectIdentifierType(raw: string): DetectionResult {
  const s = raw.trim();

  if (!s) {
    return { type: 'unknown', confidence: 0 };
  }

  // MongoDB ObjectId: 24-character hex string
  if (/^[0-9a-f]{24}$/i.test(s)) {
    return { type: 'id', confidence: 1.0 };
  }

  // GTIN: 8, 12, 13, or 14 digits (UPC, EAN, etc.)
  if (/^\d{8}$|^\d{12}$|^\d{13}$|^\d{14}$/.test(s)) {
    return { type: 'gtin', confidence: 0.95 };
  }

  // Contains spaces - likely a label/description
  if (/\s/.test(s)) {
    return { type: 'label', confidence: 0.9 };
  }

  // Contains dashes inside alphanumeric - likely MPN (e.g., "PD041-828SI", "ABC-123-XYZ")
  // But not if it starts with a vendor prefix like "LMI-" (3+ letters followed by dash)
  if (/^[A-Z0-9]+(?:-[A-Z0-9]+)+$/i.test(s) && !/^[A-Z]{3,}-/i.test(s)) {
    return { type: 'mpn', confidence: 0.8 };
  }

  // Alphanumeric with dots, underscores, or dashes - likely SKU (e.g., "LMI-PD041828SI")
  if (/^[A-Z0-9][A-Z0-9._-]*$/i.test(s)) {
    return { type: 'sku', confidence: 0.7 };
  }

  // Pure alphanumeric without separators - could be MNO or simple SKU
  if (/^[A-Z0-9]+$/i.test(s)) {
    return { type: 'mno', confidence: 0.6 };
  }

  return { type: 'unknown', confidence: 0 };
}

/**
 * Normalizes a string for comparison by removing special characters
 * and converting to uppercase
 */
export function normalize(value: string): string {
  return value.replace(/[^A-Za-z0-9]/g, '').toUpperCase();
}

/**
 * Calculates similarity score between two strings using normalized comparison
 *
 * @returns Score between 0 and 1
 */
export function calculateSimilarity(a: string, b: string): number {
  const normalizedA = normalize(a);
  const normalizedB = normalize(b);

  if (!normalizedA || !normalizedB) return 0;
  if (normalizedA === normalizedB) return 1.0;

  // Substring matching for partial similarity
  const longer = normalizedA.length > normalizedB.length ? normalizedA : normalizedB;
  const shorter = normalizedA.length > normalizedB.length ? normalizedB : normalizedA;

  if (longer.includes(shorter)) {
    return shorter.length / longer.length;
  }

  return 0;
}

