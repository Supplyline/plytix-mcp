import { describe, it, expect, vi, afterEach } from 'vitest';
import { PlytixLookup, DEFAULT_SEARCH_FIELDS } from '../lookup/lookup.js';
import { WorkerPlytixLookup } from '../worker-lookup.js';
import type { PlytixClient } from '../client.js';
import type { WorkerPlytixClient } from '../worker-client.js';

const originalSearchFieldsEnv = process.env.PLYTIX_SEARCH_FIELDS;

const makeClient = () => ({
  searchProducts: vi.fn().mockResolvedValue({ data: [] }),
  getProduct: vi.fn().mockResolvedValue({ data: [] }),
});

afterEach(() => {
  if (originalSearchFieldsEnv === undefined) {
    delete process.env.PLYTIX_SEARCH_FIELDS;
  } else {
    process.env.PLYTIX_SEARCH_FIELDS = originalSearchFieldsEnv;
  }
});

describe('search field sanitization', () => {
  it('filters non-string search fields from config', async () => {
    const client = makeClient();
    const lookup = new PlytixLookup(client as unknown as PlytixClient, {
      searchFields: [123, null, ' sku ', 'attributes.mpn', false] as unknown as string[],
    });

    await lookup.findProducts({ mpn: 'ABC' });

    const call = client.searchProducts.mock.calls[0][0];
    expect(call.attributes).toEqual(['sku', 'attributes.mpn']);
    expect(call.filters?.[0]?.[0]?.field).toBe('attributes.mpn');
  });

  it('falls back to defaults when no valid fields provided', async () => {
    delete process.env.PLYTIX_SEARCH_FIELDS;
    const client = makeClient();
    const lookup = new PlytixLookup(client as unknown as PlytixClient, {
      searchFields: [123, null] as unknown as string[],
    });

    await lookup.findProducts({});

    const call = client.searchProducts.mock.calls[0][0];
    expect(call.attributes).toEqual(DEFAULT_SEARCH_FIELDS);
  });

  it('filters non-string search fields from env var', async () => {
    process.env.PLYTIX_SEARCH_FIELDS = JSON.stringify([123, null, 'sku', 'attributes.mpn']);
    const client = makeClient();
    const lookup = new PlytixLookup(client as unknown as PlytixClient);

    await lookup.findProducts({ mpn: 'ABC' });

    const call = client.searchProducts.mock.calls[0][0];
    expect(call.attributes).toEqual(['sku', 'attributes.mpn']);
  });

  it('filters non-string search fields in worker config', async () => {
    const client = makeClient();
    const lookup = new WorkerPlytixLookup(client as unknown as WorkerPlytixClient, {
      searchFields: [123, ' attributes.mpn ', null, 'sku'] as unknown as string[],
    });

    await lookup.findProducts({ mpn: 'ABC' });

    const call = client.searchProducts.mock.calls[0][0];
    expect(call.attributes).toEqual(['attributes.mpn', 'sku']);
    expect(call.filters?.[0]?.[0]?.field).toBe('attributes.mpn');
  });
});
