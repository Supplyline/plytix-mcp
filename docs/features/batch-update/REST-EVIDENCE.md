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

## Addendum 2026-06-10 — independent probe results (conclusion unchanged)

Recorded from a separate audit session; all probes were read-only (GET, or POST to
`/search`-style list endpoints with a 1-row pagination body — the same class of call the
search tools make). No write-method probing was performed.

- The **official public Postman collection** behind apidocs.plytix.com (fetched raw from
  `apidocs.plytix.com/api/collections/42465620/2sBXijJrz3`, 88 endpoints) contains **zero**
  bulk/job/task endpoints — independently confirms the scrape above.
- `GET /api/v1/jobs/{id}` and `POST /api/v1/jobs/search` return **403 Forbidden** — the
  route family exists but is permission-gated for this account's API credential (403 even
  for a nonexistent job id). All other guessed roots return generic 404s:
  `/api/v1|v2/tasks`, `/api/v2/jobs`, `/api/v1/bulk_actions`, `/api/v1/processes`,
  `/api/v2/products/bulk` (GET resolves to the `products/:id` route).
- Implication: if Plytix ever exposes the async bulk API to this account, the job-status
  family is `/api/v1/jobs/...`, and the **API credential needs the jobs permission
  enabled** (Plytix settings or support) before any async implementation could even poll.
- Per the implementation rule above, an undocumented permission-gated route is NOT
  `async_endpoint_confirmed`. **Conclusion remains `use_patch_loop`.**
