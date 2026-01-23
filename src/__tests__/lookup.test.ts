import { describe, it, expect, vi, afterEach } from 'vitest';
import type { PlytixSearchBody } from '../types.js';
import type { PlytixClient } from '../client.js';
import { PlytixLookup } from '../lookup/lookup.js';

describe('PlytixLookup MPN/MNO label fallbacks', () => {
  const originalMpnLabels = process.env.PLYTIX_MPN_LABELS;
  const originalMnoLabels = process.env.PLYTIX_MNO_LABELS;

  afterEach(() => {
    if (originalMpnLabels === undefined) {
      delete process.env.PLYTIX_MPN_LABELS;
    } else {
      process.env.PLYTIX_MPN_LABELS = originalMpnLabels;
    }

    if (originalMnoLabels === undefined) {
      delete process.env.PLYTIX_MNO_LABELS;
    } else {
      process.env.PLYTIX_MNO_LABELS = originalMnoLabels;
    }
  });

  it('uses default MPN labels when searchFields exclude attributes', async () => {
    delete process.env.PLYTIX_MPN_LABELS;
    delete process.env.PLYTIX_MNO_LABELS;

    const searchCalls: PlytixSearchBody[] = [];
    const client = {
      searchProducts: vi.fn(async (body: PlytixSearchBody) => {
        searchCalls.push(body);
        return { data: [] };
      }),
    } as unknown as PlytixClient;

    const lookup = new PlytixLookup(client, {
      searchFields: ['sku', 'label', 'gtin'],
      cacheEnabled: false,
    });

    await lookup.findByIdentifier('ABC-123', 'mpn', 5);

    const hasMpnFilter = searchCalls.some((body) =>
      body.filters?.some((group) => group.some((filter) => filter.field === 'attributes.mpn'))
    );

    expect(hasMpnFilter).toBe(true);
  });
});
