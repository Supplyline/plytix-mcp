# Plan 004: Unify the dual-surface core (shared client/lookup, single tool registry)

> **Executor instructions**: This is the largest refactor in the set. Follow steps in
> order; the codebase must typecheck and pass tests after EVERY step. On any STOP
> condition, stop and report. Update `plans/README.md` when done.
>
> **Drift check (run first)**: `git diff --stat 18ded4c..HEAD -- src/`
> Plans 001–003 land before this one — re-read the live files; the *shape* described here
> must still hold (twin clients, twin lookups, hand-mirrored TOOLS/handlers). If a partial
> consolidation already happened, STOP and reconcile with the operator.

## Status

- **Priority**: P2
- **Effort**: L (multi-day)
- **Risk**: MED-HIGH (touches every tool; mitigated by plan 002's client tests + stepwise
  verification)
- **Depends on**: plans/002-stdio-client-hardening.md (client tests are the safety net;
  002 also re-converges the twins' behavior so this merge is mechanical)
- **Category**: tech-debt
- **Planned at**: commit `18ded4c`, 2026-06-10

## Why this matters

The repo maintains two parallel implementations of everything: `src/client.ts` (757 lines)
vs `src/worker-client.ts` (798), `src/lookup/lookup.ts` (597) vs `src/worker-lookup.ts`
(471), and 47 stdio tool registrations in `src/tools/*.ts` vs a hand-written 44-entry
`TOOLS` JSON-schema array plus 44-entry `toolHandlers` record inside the 2,995-line
`src/worker.ts`. Parity is currently maintained **by hand and is currently exact** (audit
2026-06-10 against pre-batch main: 47 stdio = 44 worker + 3 intentionally local-only
identifier utilities; the batch PRs #24–#27 then added 4 stdio / 2 worker tools — recount
at execution time, the *structure* is unchanged), but
the twins have already drifted behaviorally once (fixed by plan 002), and every new tool —
e.g. plan 001's two bulk tools — must be written twice in different schema dialects.

## Current state

- `src/client.ts` / `src/worker-client.ts`: same method surface; differences are (1)
  dotenv/env-var defaults vs constructor-only config, (2) stdio has 5-min TTL attribute
  cache, worker is per-request with no TTL, (3) worker tracks a SHA-256 credential digest
  for request-scoped cache keying.
- `src/lookup/lookup.ts` / `src/worker-lookup.ts`: same pipeline (detect → staged search →
  score); stdio version reads `PLYTIX_SEARCH_FIELDS`/`PLYTIX_MPN_LABELS`/`PLYTIX_MNO_LABELS`
  env vars in `initSearchFields/initMpnFields/initMnoFields` (lookup.ts:140-183); worker
  version takes config only.
- `src/tools/*.ts`: zod `ZodRawShape` schemas via `registerTool` (`src/tools/register.ts`
  — type-erasing wrapper around `server.registerTool`).
- `src/worker.ts:291-926`: `TOOLS: ToolDefinition[]` — raw JSON Schema `inputSchema`.
  `src/worker.ts:927-2344`: `toolHandlers` — `(args, client) => {content, isError?}`.
- Two tsconfigs: `tsconfig.json` (excludes worker files), `tsconfig.worker.json` (worker
  files only). Worker cannot import `dotenv` or anything using `process.env` at module
  scope.

## Target architecture

1. **Shared core client** `src/core/client.ts`: env-agnostic class taking full config via
   constructor (creds, base/auth URLs, timeout, cache TTL policy). `PlytixClient` becomes a
   thin subclass adding dotenv/env defaults; `WorkerPlytixClient` a thin subclass adding the
   credential-digest request scoping. Target: ≥90% of method bodies live once in core.
2. **Shared lookup** `src/core/lookup.ts`: config-only; stdio wrapper supplies env-derived
   config.
3. **Single tool registry** `src/core/tools/*.ts`: each tool defined ONCE as
   `{ name, description, zodShape, handler(client, args) }`. Two adapters:
   - stdio: `registerTool(server, name, {description, inputSchema: zodShape}, args => handler(client, args))`
   - worker: derive JSON Schema from the zod shape via `zod-to-json-schema` (add as
     dependency — verify its output matches the current hand-written schemas for 3 sample
     tools before converting all) and build `TOOLS`/`toolHandlers` mechanically.
4. `src/worker.ts` shrinks to: Env/CORS/OAuth/HTTP routing + `buildWorkerTools(registry)`.

## Commands you will need

| Purpose | Command | Expected |
|---------|---------|----------|
| Typecheck both | `npm run typecheck && npm run typecheck:worker` | exit 0 |
| Tests | `npm test` | all pass |
| Full gate | `npm run test:all` | all pass |
| Tool parity check | `node -e` script comparing stdio registry names vs worker TOOLS names | sets equal (modulo the 3 identifier utils) |

## Scope

**In scope**: everything under `src/` except the OAuth/HTTP-routing half of `worker.ts`;
`package.json` (add `zod-to-json-schema`); both tsconfigs (path includes).

**Out of scope**: behavior changes of any tool (descriptions/schemas/outputs must be
byte-identical where feasible — this is a pure refactor); OAuth endpoints; `scripts/`.

## Steps (each must leave the repo green)

1. Extract `src/core/client.ts` from the post-002 twins; make both existing classes
   subclasses; delete duplicated bodies. Verify: typecheck both + `npm test`.
2. Same for lookup. Verify: typecheck both + `npm test` (lookup tests).
3. Build the registry for ONE tool family (products) + both adapters; assert with a
   snapshot test that the worker `tools/list` JSON for those tools is unchanged from
   pre-refactor (capture the before JSON first). Verify: `npm run test:mcp` + snapshot.
4. Convert remaining families one commit each (families, attributes, assets, categories,
   variants, relationships, product-attributes, bulk). Verify after each.
5. Keep the 3 identifier utilities stdio-only via a registry flag (`surfaces: ['stdio']`).
6. Delete `src/worker-client.ts`/`src/worker-lookup.ts` bodies (now shims or removed),
   update imports, update CLAUDE.md project-structure section.

## Test plan

- Before any conversion: record `tools/list` output of both surfaces to JSON fixtures;
  after each step, diff against fixtures (only intended changes: none).
- Plan 002's `client.test.ts` must pass against the core class unchanged.

## Done criteria

- [ ] `npm run test:all` green; `npm run typecheck:worker` green
- [ ] `wc -l src/worker.ts` < 1200
- [ ] No tool definition appears in more than one file (`grep -c "products_lookup"` across
      src → registry + ≤1 adapter reference)
- [ ] `tools/list` fixtures byte-identical pre/post (modulo agreed exceptions: none)
- [ ] `plans/README.md` updated

## STOP conditions

- `zod-to-json-schema` output diverges from the hand-written worker schemas in ways that
  change client-visible validation (sample check in step 3 fails) — report options instead
  of forcing it.
- Any single step cannot end green — shrink the step, or stop.
- Bundle size or worker startup regresses (wrangler dev fails or build output grows >25%).

## Maintenance notes

- After this lands, adding a tool = one registry entry; README/CLAUDE tool tables remain
  manual (consider generating them in a later pass).
- The OAuth half of worker.ts is plan-003 territory; resist the urge to move it during
  this refactor.
