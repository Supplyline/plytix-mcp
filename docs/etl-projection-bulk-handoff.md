# Handoff: bulk product update — lessons + contract from the ETL B-projection backfill

**From:** supplyline-etl, Track B / B-projection (the 620-SKU LMI-PD `box_n`/`opt_n`/`google_detail` backfill that retires the GMC Excel)
**To:** the `products_bulk_update` / `products_bulk_status` design in this repo
**Date:** 2026-06-08
**Status of the proposed design:** reviewed from the ETL consumer's side — **it's solid.** Notes below are affirmations + a few targeted adds, not a redesign.

---

## TL;DR — the one load-bearing lesson

**Don't thread the validated payload bytes through the LLM.** This is the wall the ETL hit and the real reason "620 individual writes" failed — not HTTP round-trips, but **~1.5 MB of payloads (620 × a ~2.5 KB `google_detail` each) flowing through the model's context.**

Your `products_bulk_update(items, ...)` with an inline `items` array is the **correct general primitive**, but be explicit that the 620-row backfill must **not** be driven by an agent constructing a 620-item inline call — that just moves the same 1.5 MB into one giant tool call. The backfill submitter has to read the payloads **from disk**. Two viable shapes (either is fine; flag which you intend):

1. **Deterministic script** (likely ETL-side): reads the validated `{sku}.idc-push.json` files and calls `bulkUpdateProducts()` directly — no agent, no model context. Cleanest for a one-shot backfill.
2. **A manifest-path variant of the tool**: the agent passes a *path* (not 620 inline items); the tool reads the files and submits. Keeps it MCP-native while staying out of the model's context.

The inline-array tool stays perfect for interactive/small batches. Just don't let "the agent assembles 620 items inline" be the backfill path.

---

## Feedback on the proposed design (your 4 sections)

**§1 Scope — APPROVE.** Update-only (no bulk create/delete) matches Plytix's own bulk component and our need. Exactly-one-of `id`/`sku` + at-least-one update field, rejected up front with the offending index — good. **The ETL keys by `sku`** (our SKUs are unique, exact-match), so the sku path is our primary; `id` is a nice-to-have.

**§2 Hybrid flow + auto-chunk + bounded wait — APPROVE.** Note our scale: **620 fits in ONE ≤1000 chunk → one job.** The job-set/auto-chunk machinery is right for headroom (LMI-PD is the first of many series), but our first real run is a single job. The bounded-inline-wait-then-handle is the right Worker-budget design. **Per-SKU `failures[]` keyed by the sku/id we sent is the single most important property for us** — a backfill must report *which* rows failed and why (e.g. an enum or char-limit reject Plytix raises that our pre-validator didn't), not pass/fail. Keep that prominent.

**§3 File plan (dual surface, pure helpers) — APPROVE.** Pure chunk/validate/aggregate helpers shared by both clients is exactly right.

**§4 Testing — APPROVE.** Your chunking/validation/aggregation/bounded-wait matrix covers it. **Step 0 (confirm the real submit + job-status REST paths via the Postman collection or a live capture before building) is the correct de-risk** — don't guess the path. We confirmed the *capability* (async job, id-or-sku, ≤1000, poll `FINISHED`) from the elastic.io wrapper + Plytix help docs but also couldn't scrape the literal URL from the JS-SPA apidocs.

**Auth:** your `client.ts` already does the key+password→JWT exchange (`get-token`, `access_token`/`expires_in`) and the **no-trailing-slash** strip (the redirect-drops-Authorization gotcha). The bulk endpoints inherit that `request()` path, so nothing new there. (Flagging only because the ETL's *own* stale `skills/plytix_client/client.py` got this wrong — raw bearer vs `api.plytix.com/v1` — and is being retired; yours is correct.)

---

## The ETL → bulk contract (what we hand you)

`supplyline-etl`'s `cli.idc project-batch` already does the deterministic, gated work — derive the catalog, read live, classify, run the **mandatory payload validator**, apply the gate ladder (audit verdict, whole-SKU box-change hold, etc.) — and emits per-SKU validated payload files. For the bulk handoff it produces:

```
outputs/<series>/idc-projection/
  <sku>.idc-push.json        # { "attributes": { "opt_1": "...", ..., "google_detail": "..." } }  (already exists)
  bulk-manifest.json         # the submit set:
    {
      "series_id": "LMI-PD",
      "config_snapshot_hash": "<hash>",          // the plan version — see idempotency note
      "items": [ { "sku": "LMI-PD041929NI", "product_id": "5e0110bb…", "attributes": { … } }, … ]
    }
```

- Items are keyed by **`sku`** (`product_id` included when known, but sku is canonical for us).
- `attributes` is the exact, already-validated write body — your tool should NOT re-validate format (we own that gate), but DO surface Plytix's own per-row rejects.
- You return per-sku results; **we** record the `did_push` ledger keyed by `(sku, config_snapshot_hash)`.

## Idempotency note (a real bug we want to avoid)

Our re-runs key idempotency by **`config_snapshot_hash`** (the grammar/plan version), NOT by "sku was ever pushed." The flow is: *audit → fix grammar in Airtable → re-project → re-push*. If a SKU is skipped purely because it has *any* prior `did_push`, a **corrected** projection silently never lands. So: your per-sku result just needs to report success/failure per sku; the **version-aware skip lives in our ledger** (`(sku, snapshot_hash)`), and we'll only ask you to write the rows that changed. Nothing for you to implement here — just don't assume "pushed once = done forever" anywhere in the tool's own state.

## Concrete gotchas from the actual run

- **Payload size:** `google_detail` is GMC product_detail XML, ~2.3–2.6 KB per SKU; `opt_n` are short. ≤1000/job is comfortable, but the submitter streams from disk (see TL;DR).
- **`google_detail` is the customer-facing Google Merchant feed** — treat bulk writes here as production/outward-facing. Per-row error reporting matters precisely because a silent partial failure ships bad feed entries.
- **Plytix omits empty/absent custom attributes from search responses.** If `products_bulk_status` (or any read-back) diffs results, an attr that's *absent* vs *empty* reads the same — don't infer "unchanged" from absence.
- **Already proven on 4 SKUs** via the synchronous single `PATCH /api/v2/products/{id}` `{attributes}` path (the same auth your client uses). The bulk endpoint is the async-job equivalent of that same write; the 4 live rows confirm the payload shape Plytix accepts (pipe-delimited `opt_n` like `"Base Model | Series | PD Series"`, GMC `google_detail`).

## Net

Build the two tools as designed (with Step 0 first). The ETL keeps projection + gating + the version-aware ledger and produces the manifest above; the only cross-repo coupling is that manifest shape + your per-sku `failures[]`. The single thing to be deliberate about is **not letting an agent assemble the 620 inline** — submit from disk.
