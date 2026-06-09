# REST Evidence - Batch Product Update

> **Conclusion:** `use_patch_loop`
> **Date:** 2026-06-09

The local API scrape in `docs/solutions/api-quirks/plytix-api.md` confirms documented
single-product product APIs:

- `POST /api/v2/products`
- `GET /api/v2/products/:product_id`
- `PATCH /api/v2/products/:product_id`
- `DELETE /api/v2/products/:product_id`
- `POST /api/v2/products/search`

It does not document a public async bulk product update endpoint, job submit endpoint, job
status endpoint, CSV-import execution endpoint, or import-profile REST API.

Implementation rule:

- Only a supported first-party public API endpoint can switch the implementation to
  `async_endpoint_confirmed`.
- A browser capture of private UI/import endpoints is evidence only and does not justify
  shipping a public MCP tool against that endpoint.
- Third-party wrapper behavior is not enough to select an async implementation.

Until first-party evidence proves otherwise, v1 uses bounded, paced single-product PATCH
calls behind the batch-update contract.
