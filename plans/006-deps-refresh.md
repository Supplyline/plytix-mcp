# Plan 006: Dependency refresh (MCP SDK → 1.29.x, wrangler → 4.99.x; zod stays v3)

> **Executor instructions**: Follow step by step; verify each step; on any STOP condition,
> stop and report. Update `plans/README.md` when done.
>
> **Drift check (run first)**: `git diff --stat 18ded4c..HEAD -- package.json package-lock.json`

## Status

- **Priority**: P3
- **Effort**: S
- **Risk**: LOW-MED (SDK minor versions have changed transport behavior before; full gate
  required)
- **Depends on**: none
- **Category**: deps
- **Planned at**: commit `18ded4c`, 2026-06-10

## Why this matters

`@modelcontextprotocol/sdk` is specified `^1.1.0` with 1.25.2 installed while 1.29.0 is
current — months of protocol fixes behind, on the package that defines the server's wire
behavior. `wrangler` (devDep) is 40 minors behind (4.59.2 → 4.99.x). `npm audit` is
currently clean, so this is hygiene, not an emergency. **Explicitly out**: zod v4 (the MCP
SDK peer-depends on zod 3; `src/tools/register.ts` exists precisely to tame SDK×zod
generics — do not disturb).

## Current state

- `package.json:56` `"@modelcontextprotocol/sdk": "^1.1.0"` (installed 1.25.2)
- `package.json:66` `"wrangler": "^4.59.2"` (installed 4.59.2)
- SDK usage surface: `McpServer`, `StdioServerTransport`
  (`src/index.ts:10-11`), `server.registerTool` via the type-erasing wrapper
  (`src/tools/register.ts:30-39`). The worker does NOT use the SDK (hand-rolled JSON-RPC).

## Commands you will need

| Purpose | Command | Expected |
|---------|---------|----------|
| Update SDK | `npm install @modelcontextprotocol/sdk@^1.29.0` | exit 0 |
| Update wrangler | `npm install -D wrangler@^4.99.0` | exit 0 |
| Full gate | `npm run test:all` | all pass |
| Worker typecheck | `npm run typecheck:worker` | exit 0 |
| Worker dev smoke | `npm run dev:worker` (manual, optional) | starts without error |
| Audit | `npm audit` | 0 vulnerabilities |

## Scope

**In scope**: `package.json`, `package-lock.json`.
**Out of scope**: zod major version; any source change EXCEPT compile fixes forced by the
SDK bump (if more than ~10 lines of source change are needed, STOP — that's a migration,
not a refresh).

## Steps

1. `npm install @modelcontextprotocol/sdk@^1.29.0` → `npm run test:all` green.
2. `npm install -D wrangler@^4.99.0` → `npm run typecheck:worker` green; `npm run
   build:worker` green.
3. `npm audit` → 0 vulnerabilities. Commit lockfile + manifest together.

## Done criteria

- [ ] `npm run test:all` exits 0 on the new lockfile
- [ ] `npm ls @modelcontextprotocol/sdk` shows ≥1.29.0
- [ ] `plans/README.md` updated

## STOP conditions

- SDK bump breaks `registerTool` typing or the stdio handshake (`npm run test:mcp` fails)
  after one reasonable fix attempt.
- wrangler bump changes `wrangler.toml` schema expectations (build errors referencing
  config keys).

## Maintenance notes

- Re-run this hygiene quarterly; zod 4 only when the MCP SDK supports it.
