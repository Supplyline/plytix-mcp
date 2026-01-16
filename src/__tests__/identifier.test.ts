import { describe, it, expect } from 'vitest';
import {
  detectIdentifierType,
  normalize,
  calculateSimilarity,
} from '../lookup/identifier.js';

describe('detectIdentifierType', () => {
  describe('MongoDB ObjectId detection', () => {
    it('detects 24-char hex as ID with confidence 1.0', () => {
      // Must be exactly 24 hex characters
      const result = detectIdentifierType('66b4e2da76dbf112847cf170');
      expect(result.type).toBe('id');
      expect(result.confidence).toBe(1.0);
    });

    it('detects lowercase hex ID', () => {
      const result = detectIdentifierType('507f1f77bcf86cd799439011');
      expect(result.type).toBe('id');
      expect(result.confidence).toBe(1.0);
    });

    it('detects uppercase hex ID', () => {
      const result = detectIdentifierType('507F1F77BCF86CD799439011');
      expect(result.type).toBe('id');
      expect(result.confidence).toBe(1.0);
    });

    it('does not detect 23-char string as ID', () => {
      const result = detectIdentifierType('66b4e2da76dbf112847cf17');
      expect(result.type).not.toBe('id');
    });
  });

  describe('GTIN detection', () => {
    it('detects 8-digit GTIN (EAN-8)', () => {
      const result = detectIdentifierType('12345678');
      expect(result.type).toBe('gtin');
      expect(result.confidence).toBe(0.95);
    });

    it('detects 12-digit GTIN (UPC-A)', () => {
      const result = detectIdentifierType('123456789012');
      expect(result.type).toBe('gtin');
      expect(result.confidence).toBe(0.95);
    });

    it('detects 13-digit GTIN (EAN-13)', () => {
      const result = detectIdentifierType('1234567890123');
      expect(result.type).toBe('gtin');
      expect(result.confidence).toBe(0.95);
    });

    it('detects 14-digit GTIN (ITF-14)', () => {
      const result = detectIdentifierType('12345678901234');
      expect(result.type).toBe('gtin');
      expect(result.confidence).toBe(0.95);
    });
  });

  describe('Label detection', () => {
    it('detects strings with spaces as labels', () => {
      const result = detectIdentifierType('Metering Pump LMI Series');
      expect(result.type).toBe('label');
      expect(result.confidence).toBe(0.9);
    });

    it('detects product names with multiple spaces', () => {
      const result = detectIdentifierType('Blue White C-6125 Flex Pump');
      expect(result.type).toBe('label');
      expect(result.confidence).toBe(0.9);
    });
  });

  describe('MPN detection', () => {
    it('detects dashed alphanumeric as MPN', () => {
      const result = detectIdentifierType('PD041-828SI');
      expect(result.type).toBe('mpn');
      expect(result.confidence).toBe(0.8);
    });

    it('does not detect vendor-prefixed SKU as MPN', () => {
      // ABC- is only 3 letters, so it matches vendor prefix exclusion
      const result = detectIdentifierType('LMI-PD041828SI');
      expect(result.type).toBe('sku');
      expect(result.confidence).toBe(0.7);
    });
  });

  describe('SKU detection', () => {
    it('detects vendor-prefixed codes as SKU', () => {
      const result = detectIdentifierType('LMI-PD041828SI');
      expect(result.type).toBe('sku');
      expect(result.confidence).toBe(0.7);
    });

    it('detects codes with dots as SKU', () => {
      const result = detectIdentifierType('BWI.C6125');
      expect(result.type).toBe('sku');
      expect(result.confidence).toBe(0.7);
    });

    it('detects codes with underscores as SKU', () => {
      const result = detectIdentifierType('PUMP_123_A');
      expect(result.type).toBe('sku');
      expect(result.confidence).toBe(0.7);
    });

    it('detects multi-part dashed codes with vendor prefix as SKU', () => {
      // ABC-123-XYZ matches the SKU pattern (alphanumeric with separators)
      // The MPN pattern excludes 3+ letter prefixes
      const result = detectIdentifierType('ABC-123-XYZ');
      expect(result.type).toBe('sku');
      expect(result.confidence).toBe(0.7);
    });

    it('detects pure alphanumeric as SKU (higher priority than MNO)', () => {
      // Pure alphanumeric matches SKU pattern before reaching MNO check
      const result = detectIdentifierType('A148');
      expect(result.type).toBe('sku');
      expect(result.confidence).toBe(0.7);
    });

    it('detects model-like codes as SKU', () => {
      const result = detectIdentifierType('C6125P');
      expect(result.type).toBe('sku');
      expect(result.confidence).toBe(0.7);
    });
  });

  describe('Edge cases', () => {
    it('returns unknown for empty string', () => {
      const result = detectIdentifierType('');
      expect(result.type).toBe('unknown');
      expect(result.confidence).toBe(0);
    });

    it('handles whitespace trimming', () => {
      const result = detectIdentifierType('  507f1f77bcf86cd799439011  ');
      expect(result.type).toBe('id');
    });
  });
});

describe('normalize', () => {
  it('removes special characters', () => {
    expect(normalize('LMI-PD041-828SI')).toBe('LMIPD041828SI');
  });

  it('converts to uppercase', () => {
    expect(normalize('abc123')).toBe('ABC123');
  });

  it('removes spaces', () => {
    expect(normalize('ABC 123 XYZ')).toBe('ABC123XYZ');
  });

  it('removes dots and underscores', () => {
    expect(normalize('A.B_C')).toBe('ABC');
  });
});

describe('calculateSimilarity', () => {
  it('returns 1.0 for exact match after normalization', () => {
    expect(calculateSimilarity('LMI-PD041', 'LMIPD041')).toBe(1.0);
  });

  it('returns 0 for completely different strings', () => {
    expect(calculateSimilarity('ABC', 'XYZ')).toBe(0);
  });

  it('returns partial score for substring match', () => {
    const score = calculateSimilarity('PD041', 'LMIPD041828SI');
    expect(score).toBeGreaterThan(0);
    expect(score).toBeLessThan(1);
  });

  it('handles empty strings', () => {
    expect(calculateSimilarity('', 'ABC')).toBe(0);
    expect(calculateSimilarity('ABC', '')).toBe(0);
  });
});
