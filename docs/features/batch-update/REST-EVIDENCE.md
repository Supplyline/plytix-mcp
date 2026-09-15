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

## Addendum 2026-09-15 — first-party bulk documentation received; route confirmed live

**Source:** `plytix-bulk-actions-draft-2021.pdf` (this directory), provided by Plytix customer
success on request, 2026-09-15. Title:
"Bulk actions for public API — Draft documentation of product bulk actions", Plytix Aps 2021.
This is the first-party evidence the implementation rule above was waiting for, with one
caveat: it is marked **draft** and is not on apidocs.plytix.com.

**What it documents:**

- `POST /api/v1/bulk/products` — body `{ "action": "update", "products": [ { "id" | "sku",
  "data": { "label"?, "status"?, "attributes": { <user attribute label>: <value> } } } ] }`.
  Max **1,000 products per operation**. System attributes: only `label` and `status`. User
  attributes go under `attributes` keyed by label. Multiselect = JSON array; decimals unquoted
  with `.`; dates `yyyy-mm-dd`. Returns `200` with a job record:
  `{ id (job_id), state: "QUEUED", by_user, created_at, modified, display_name, is_system, source }`.
- `GET /api/v1/bulk/products/<job_id>` — job summary: `status` (`FINISHED`), `summary: { ok, error }`,
  `products: [{id, sku}]`, and `errors: [{ sku, errors: [{ <attribute label>: <message> }] }]`.
  Per-row, per-attribute error reporting — which the PATCH loop had to synthesize.

**Why every June probe missed it:** the path is `/api/v1/bulk/products` (singular `bulk`,
resource *after*). June guessed `/api/v2/products/bulk`, `/api/v1/bulk_actions`, and the
`/jobs` family; today's first pass guessed `/bulks`. The job-status GET lives under the same
`bulk/products/` prefix, **not** under `/api/v1/jobs/…` — so the 403 on `/jobs` is unrelated
and does not block this.

**Live probe, read-only, 2026-09-15 (GET only; no POST was made):**

| Request | Status | Body |
|---|---|---|
| `GET /api/v1/bulk/products/000000000000000000000000` | 404 | `{"error":{"errors":[{"field":"id","msg":"product does not exist"}]}}` |
| `GET /api/v1/bulk/products` | 422 | `ProductsBulkApi.get() missing 1 required positional argument: 'job_id'` |
| `GET /api/v1/bulk` | 404 | generic route-miss |

The 404 is a handler response for an unknown id, and the 422 names the handler class — the
route family exists and **this credential is authorized** (contrast the 403 on `/api/v1/jobs`).

**Controlled write, 2026-09-15 (authorized; 4 Archived standalone products, one text
attribute set from null to a value; plus one job with a nonexistent SKU):**

| Step | Observed |
|---|---|
| `POST /api/v1/bulk/products` (4 rows by `sku`) | `200` in ~0.7 s. Job record `state: "CREATED"` (draft says `QUEUED`), plus `external_process_id` (= `id`). |
| First `GET …/<job_id>` at ~0.4 s | `status: "Finished"` — but `summary: {ok:"0", error:"0", cancelled:"0"}` and `products: []`. |
| Same GET minutes later | `status: "Finished"`, `summary.ok: "4"`, `products: [{id, sku} ×4]`. |
| Product read-back (v2 GET) | attribute set on all 4; `modified` bumped; no other attribute changed; `overwritten_attributes` unchanged. |
| Bad-SKU job | `In progress` at 0.4 s → `Finished` at 1.5 s; `errors: [{sku, errors: [{sku: "sku does not exist"}]}]`, `summary.error: "1"`. No product created. |

Draft-vs-live differences a client must handle:

- Status strings are Title-case: `"Finished"`, `"In progress"` (draft: `FINISHED`). Submit state is
  `"CREATED"` (draft: `QUEUED`). `summary` has a third counter, `cancelled`. Counters are strings.
- **`Finished` arrives before the summary is written.** The writes had landed, but `ok` and
  `products` lagged the status by more than the first poll. A terminal condition must be
  `status == Finished` **and** `ok + error + cancelled == rows submitted`, with a bounded
  re-poll — or read the products back, which is what the batch runner's guard reads do anyway.
- Error rows carry `{<field>: message}` pairs under `errors[].errors[]`, keyed by the field the
  server objected to (`sku` for an unknown SKU), exactly as the draft shows for attributes.

**Status of the implementation rule:** `async_endpoint_confirmed`. First-party document, route
live, credential authorized, request and response shapes verified by a real write. What the
endpoint does **not** provide — optimistic-concurrency guards, a `FAILED` state, cancel, listing,
or per-row success detail beyond `{id, sku}` — is the design input for adopting it.
