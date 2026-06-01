# "Could not attach to MCP server plytix" — transports, reboot flakiness, auth

_Diagnosed 2026-06-01._

## TL;DR

A "Could not attach to MCP server plytix" toast after a reboot is **not** a code
regression in the worker. The `plytix` server is the **remote Cloudflare Worker**,
reached through an `mcp-remote` stdio→HTTP bridge launched by `npx`. The toast is a
transient cold-start race (npx resolving `mcp-remote@latest` against the npm registry
before the network is fully up) and self-heals on the next launch. The worker itself
was healthy throughout (HTTP 200, sub-second).

## How `plytix` is actually wired (this is the surprising part)

There are **two** transports in this repo, and the one Claude Desktop uses is the
remote one — not the local build:

| Name seen by the client | Transport | Entry point |
|---|---|---|
| `plytix` (Claude **Desktop** / local-agent-mode) | remote HTTP via `mcp-remote` | `~/.claude/mcp-remote-plytix.sh` → `npx -y mcp-remote https://plytix-mcp.supplyline.workers.dev/mcp` |
| local stdio (CLI `npm start`, `npm run test:mcp`) | stdio | `node dist/index.js` (`src/index.ts`) |

Key gotcha: the Desktop config lives in
`~/Library/Application Support/Claude/claude_desktop_config.json`, **not** in
`~/.claude.json`. That is why `claude mcp list` (the CLI) does not show `plytix`
even though a Desktop/local-agent-mode session has the `mcp__plytix__*` tools.
`src/worker.ts` (the Cloudflare Worker) is what serves the remote endpoint; the
"worker auth flakiness" commits touch that path, **not** the local stdio server.

## Diagnosing an attach failure

1. **Is the worker up?** `curl` the endpoint — a healthy worker answers `initialize`
   in well under a second:
   ```bash
   curl -s -o /dev/null -w "HTTP %{http_code} total=%{time_total}s\n" \
     -X POST https://plytix-mcp.supplyline.workers.dev/mcp \
     -H "Content-Type: application/json" \
     -H "Accept: application/json, text/event-stream" \
     --data '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"diag","version":"0"}}}'
   ```
   `HTTP 200` ⇒ the remote side is fine; the failure is in the local launch chain.

2. **Is the bridge launchable?** The wrapper is `npx -y mcp-remote`. `node`/`npx`
   must be resolvable from the wrapper's `PATH` (`/usr/local/bin/node` is used, not
   nvm). `mcp-remote` is cached under `~/.npm/_npx/`; `~/.mcp-auth/` holds its state.

3. **Run the worker suite** with credentials in `.env`:
   ```bash
   set -a; source .env; set +a
   node test-worker.js https://plytix-mcp.supplyline.workers.dev   # NOTE: base URL, no /mcp
   ```

## Why pinning the npx version does NOT fix the cold-start race

`npx` keys its cache by the exact spec string. `npx mcp-remote@0.1.38` maps to a
**different** cache key than the unpinned `npx mcp-remote` that populated the cache,
so the pinned form still tries to reach the registry (verified: `npx --offline
mcp-remote@0.1.38` reports "package not found, will be installed"). Pinning the
version in the wrapper therefore does not remove the boot-time network dependency.

The fix is to take `npx` (and the registry) out of the boot path entirely — install
`mcp-remote` once and call the binary directly. A self-contained prefix avoids `sudo`
and an unstable npx cache path:

```bash
npm install -g mcp-remote@0.1.38 --prefix "$HOME/.claude/mcp-tools"
# wrapper then execs the absolute path, with an npx fallback if the install is missing:
#   MCP_REMOTE="$HOME/.claude/mcp-tools/bin/mcp-remote"
#   [ -x "$MCP_REMOTE" ] && exec "$MCP_REMOTE" "$@" || exec npx -y mcp-remote "$@"
```

This removes the npm-registry round-trip (the cold-boot race). It does **not** remove
the dependency on `node` itself: the installed `mcp-remote` bin is a Node script
(`#!/usr/bin/env node` → `dist/proxy.js`), so `node` must be resolvable by the launched
process. Under a Claude Desktop / macOS GUI launch the login shell and nvm are **not**
sourced, so the wrapper's `export PATH="/usr/local/bin:/bin:/usr/bin:$PATH"` line — which
puts a current `node` on `PATH` — is load-bearing and must stay. (`--prefix` only
stabilizes the `mcp-remote` *binary* path; it does nothing for `node` resolution.)

With both in place, startup is just `node <local-file>` (verified ~2.3s to connect, no
registry round-trip), so the cold-boot race no longer occurs. The remote connection
itself still needs the network to be up, but that is the actual work, not a resolution race.

## Auth model (verified, intentional — not a bypass)

`src/worker.ts` defines:

```js
const publicMethods = ['initialize', 'notifications/initialized', 'tools/list'];
// ... later: reject if !allPublic && missing credentials
```

So unauthenticated `initialize`/`tools/list` correctly return **200** (a client must
handshake and discover tools before it has anything to authenticate with), while any
`tools/call` without credentials is rejected with
`-32600 "Missing Plytix API credentials"`. Verified live: no PIM data leaks through the
public URL. `test-worker.js` previously asserted `initialize` → 401, which was a stale
assertion; it now asserts the 200 handshake **and** that an unauthenticated `tools/call`
is rejected (the real auth boundary / regression guard).

## Keeping credentials out of `argv`

`mcp-remote` substitutes `${VAR}` in header **values** from `process.env`:

```js
headers[key] = value.replace(/\$\{([^}]+)}/g, (m, name) => process.env[name] ?? ...)
```

So credentials should be passed as the literal placeholders
`--header "X-Plytix-API-Key: ${PLYTIX_API_KEY}"` (no secret in `argv` / `ps aux`), with
the real values loaded from a `chmod 600` file into the wrapper's environment:

- `~/.claude/plytix-mcp.env` (0600): `PLYTIX_API_KEY='…'`, `PLYTIX_API_PASSWORD='…'`
  (single-quote the password — it contains `! / ; % &`).
- `~/.claude/mcp-remote-plytix.sh`: `set -a; . "$CRED_FILE"; set +a` before `exec npx … mcp-remote "$@"`.
- Desktop config `args`: only the URL + the literal `${…}` header placeholders.

Verified end-to-end: spawning the exact config entry with a minimal env (no `PLYTIX_*`)
still authenticates (creds resolve from the cred file), and `ps` shows only the
`${PLYTIX_API_KEY}` placeholder, never the secret.
