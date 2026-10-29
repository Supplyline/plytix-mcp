#!/usr/bin/env node
/** Supplyline-only adapter. Existing MCP processes and default tools are untouched. */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile, mkdir } from 'node:fs/promises';
import { isAbsolute, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { PlytixClient } from '../client.js';
import { PlytixError, type PlytixProduct } from '../types.js';
import { executeManifestUpdate, manifestResponse } from '../batch/manifest-submit.js';
import { readBatchManifest, writeExclusiveFile } from '../batch/manifest.js';

const runFile = promisify(execFile);
interface AttemptContext {
  schema: 'supplyline-submit/1';
  run_id: string;
  ledger_path: string;
  chunk_name: string;
  manifest_path: string;
  manifest_sha256: string;
  dry_run: boolean;
  created_at: string;
  expires_at: number;
  state: 'reserved';
  artifact_dir: string;
}
interface AdapterOptions { context: string; python: string; etlRoot: string }

export function parseAdapterArgs(args: string[]): AdapterOptions {
  const fields = new Map<string, string>();
  for (let i = 0; i < args.length; i += 2) {
    const name = args[i];
    if (!['--context', '--python', '--etl-root'].includes(name) || !args[i + 1] || fields.has(name)) {
      throw new Error('Usage: --context <absolute path> --python <absolute path> --etl-root <absolute path>');
    }
    fields.set(name, args[i + 1]);
  }
  const context = fields.get('--context'), python = fields.get('--python'), etlRoot = fields.get('--etl-root');
  if (!context || !python || !etlRoot || ![context, python, etlRoot].every(isAbsolute)) {
    throw new Error('Context, Python executable, and ETL root must be absolute paths');
  }
  return { context, python, etlRoot };
}

function validateContext(value: unknown): AttemptContext {
  if (!value || typeof value !== 'object') throw new Error('Invalid attempt context');
  const c = value as AttemptContext;
  if (c.schema !== 'supplyline-submit/1' || c.state !== 'reserved' || typeof c.dry_run !== 'boolean'
      || !/^[a-f0-9]{64}$/.test(c.manifest_sha256) || !Number.isFinite(c.expires_at)
      || typeof c.run_id !== 'string' || !c.run_id || typeof c.chunk_name !== 'string' || !c.chunk_name
      || typeof c.created_at !== 'string' || !Number.isFinite(Date.parse(c.created_at))
      || ![c.ledger_path, c.manifest_path, c.artifact_dir].every(p => typeof p === 'string' && isAbsolute(p))) {
    throw new Error('Invalid reserved submission context');
  }
  return c;
}

/** argv is fixed in code; neither the manifest nor context can choose executable/module/flags. */
export async function runSupplylineGate(options: AdapterOptions, admit = false): Promise<void> {
  try {
    await runFile(options.python, ['-m', 'skills.primitives.writes.plytix_manifest_submit',
      'gate', '--attempt', options.context, ...(admit ? ['--admit'] : [])], {
      cwd: options.etlRoot,
      env: { ...process.env, PYTHONPATH: options.etlRoot },
      timeout: 30_000,
      maxBuffer: 64 * 1024,
    });
  } catch (error) {
    const e = error as Error & { stdout?: string; stderr?: string };
    throw new Error(`Submission gate refused: ${(e.stderr || e.stdout || e.message).slice(0, 4000)}`);
  }
}

/** Injectable dependencies let tests prove refusals and retention without API/network access. */
export async function runSupplylineSubmission(options: AdapterOptions, deps?: {
  client?: Pick<PlytixClient, 'batchUpdateProducts' | 'getProduct'>;
  gate?: (admit?: boolean) => Promise<void>;
}): Promise<Record<string, unknown>> {
  const context = validateContext(JSON.parse(await readFile(options.context, 'utf8')));
  const gate = () => deps?.gate ? deps.gate() : runSupplylineGate(options);
  // Validate even dry attempts through the same maintained ETL entrypoint; its dry branch must
  // not require a lease. Do this before constructing an authenticated client.
  await mkdir(context.artifact_dir, { recursive: true });
  // A reserved attempt is single-use, even if the adapter crashes before its final receipt.
  // Never reclaim this marker on a timer: the orchestrator must reconcile that attempt.
  await writeExclusiveFile(resolve(context.artifact_dir, 'adapter-started.json'), JSON.stringify({
    pid: process.pid, started_at: new Date().toISOString(), context_path: options.context,
  }) + '\n');
  if (deps?.gate) await deps.gate(true);
  else await runSupplylineGate(options, true);
  const manifest = await readBatchManifest(context.manifest_path);
  if (manifest.metadata.manifest_sha256 !== context.manifest_sha256) throw new Error('Reserved manifest changed');
  await mkdir(context.artifact_dir, { recursive: true });
  const client = deps?.client ?? new PlytixClient();
  const result = await executeManifestUpdate(client, context.manifest_path, {
    dryRun: context.dry_run,
    returnSuccesses: true,
    writeReceipt: true,
    compact: true,
    requireReceipt: true,
    expectedSha256: context.manifest_sha256,
    beforeMutation: context.dry_run ? undefined : gate,
  });
  const summary = manifestResponse(result, true) as Record<string, unknown>;
  if (context.dry_run) return { ...summary, verification_required: false };

  const ids = new Set<string>();
  for (const item of manifest.items) if (item.product_id) ids.add(item.product_id);
  for (const entry of [...('successes' in result ? result.successes ?? [] : []), ...result.failures]) {
    if (entry.product_id) ids.add(entry.product_id);
  }
  const products: PlytixProduct[] = [];
  const errors: { product_id: string; error: string }[] = [];
  const rawPaths: string[] = [];
  let index = 0;
  for (const id of ids) {
    const rawPath = resolve(context.artifact_dir, `readback-${String(++index).padStart(3, '0')}.json`);
    try {
      const response = await client.getProduct(id);
      // Persist the full raw response before interpreting it or moving to the next item.
      await writeExclusiveFile(rawPath, JSON.stringify({ captured_at: new Date().toISOString(), product_id: id, response }, null, 2) + '\n');
      rawPaths.push(rawPath);
      const product = response.data?.[0];
      if (!product || product.id !== id) throw new Error('By-ID readback returned no matching product');
      products.push(product);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      errors.push({ product_id: id, error: message });
      // Keep API failure bodies too; a failed/error read is not an absent product.
      try {
        const errorPath = `${rawPath}.error.json`;
        await writeExclusiveFile(errorPath, JSON.stringify({ captured_at: new Date().toISOString(),
          product_id: id, error: message,
          ...(error instanceof PlytixError ? { status: error.status, response: error.response } : {}),
        }, null, 2) + '\n');
        rawPaths.push(errorPath);
      } catch (persistError) {
        errors.push({ product_id: id, error: `Cannot retain readback error: ${persistError instanceof Error ? persistError.message : String(persistError)}` });
      }
    }
  }
  const readbackPath = resolve(context.artifact_dir, 'readback.json');
  const report = { captured_at: new Date().toISOString(), products, errors, raw_response_paths: rawPaths };
  try {
    await writeExclusiveFile(readbackPath, JSON.stringify(report, null, 2) + '\n');
  } catch (error) {
    // Return full API result on evidence failure, so a compact response never hides successes.
    return { ...result, readback_error: error instanceof Error ? error.message : String(error),
      verification_required: true, execution_evidence_incomplete: true };
  }
  return { ...summary, readback_path: readbackPath, readback_count: products.length,
    readback_errors: errors, verification_required: true,
    execution_evidence_incomplete: Boolean(result.receipt_error) || errors.length > 0 };
}

async function main(): Promise<void> {
  try {
    const result = await runSupplylineSubmission(parseAdapterArgs(process.argv.slice(2)));
    process.stdout.write(JSON.stringify(result) + '\n');
    // A nonzero exit never authorizes replay: the retained attempt/result must be reconciled.
    if (result.execution_evidence_incomplete || result.status === 'rejected') process.exitCode = 1;
  } catch (error) {
    process.stdout.write(JSON.stringify({ status: 'error',
      error: error instanceof Error ? error.message : String(error),
      outcome: 'unknown_until_attempt_reconciled' }) + '\n');
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) await main();
