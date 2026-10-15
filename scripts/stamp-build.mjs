// Stamp dist/ with the source it was compiled from. Runs as `postbuild`.
//
// The stdio server serves the gitignored dist/, which only `npm run build` refreshes; in October
// 2026 every client was still running an 8 August build of a much newer source tree. A consumer
// (supplyline-etl's `plytix_manifest_transport check-build`) compares `src_tree` with
// `git rev-parse HEAD:src` to prove the build current without trusting file times.
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';

const git = (...args) => {
  try {
    return execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    return null;
  }
};

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
const status = git('status', '--porcelain', '--', 'src');
const info = {
  schema: 'plytix-mcp-build/1',
  built_at: new Date().toISOString(),
  version: pkg.version,
  commit: git('rev-parse', 'HEAD'),
  src_tree: git('rev-parse', 'HEAD:src'),
  src_dirty: status === null ? null : status !== '',
};
const out = process.env.PLYTIX_MCP_STAMP_OUT ?? new URL('../dist/BUILD_INFO.json', import.meta.url);
writeFileSync(out, `${JSON.stringify(info, null, 2)}\n`);
console.log(`stamped ${typeof out === 'string' ? out : out.pathname}: ${info.src_tree ?? 'no git'}`);
