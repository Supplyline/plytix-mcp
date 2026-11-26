import { unlink } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import type { PlytixClient } from '../client.js';
import type { BatchUpdateResult, MutationGuard } from '../types.js';
import { MANIFEST_MAX_ITEMS } from './helpers.js';
import { readBatchManifest, writeBatchReceipt, writeExclusiveFile } from './manifest.js';

export type ManifestResult = BatchUpdateResult & { receipt_path?: string; receipt_error?: string };
export interface ManifestSubmitOptions {
  dryRun?: boolean;
  returnSuccesses?: boolean;
  writeReceipt?: boolean;
  compact?: boolean;
  /** Only for a trusted caller that already owns the submission attempt. */
  beforeMutation?: MutationGuard;
  expectedSha256?: string;
  requireReceipt?: boolean;
}

/** One maintained manifest executor, shared by the MCP tool and deployment adapters. */
export async function executeManifestUpdate(
  client: Pick<PlytixClient, 'batchUpdateProducts'>,
  manifestPath: string,
  options: ManifestSubmitOptions = {}
): Promise<ManifestResult> {
  const manifest = await readBatchManifest(manifestPath);
  if (options.expectedSha256 && manifest.metadata.manifest_sha256 !== options.expectedSha256) {
    throw new Error('Manifest hash differs from the reserved submission');
  }
  if (options.compact && options.writeReceipt === false) {
    throw new Error('Compact response requires retained full receipt');
  }
  if (options.requireReceipt) {
    // Fail before API work when the evidence directory is already unwritable. A later disk
    // failure remains possible; it must return the full result and an explicit receipt_error.
    const probe = `${manifestPath}.receipt-probe.${randomUUID()}`;
    await writeExclusiveFile(probe, 'receipt preflight\n');
    await unlink(probe);
  }
  // A receipt always carries the success rows: a caller's ledger reconciles from it, and a
  // receipt without them leaves a fully landed chunk unknown. `returnSuccesses` only decides
  // whether the rows are also echoed in the response (see manifestResponse).
  const keepsReceipt = options.writeReceipt !== false || options.requireReceipt === true;
  const result: ManifestResult = await client.batchUpdateProducts(manifest.items, {
    dryRun: options.dryRun === true,
    returnSuccesses: options.returnSuccesses === true || keepsReceipt,
    maxItems: MANIFEST_MAX_ITEMS,
    metadata: manifest.metadata,
    beforeMutation: options.beforeMutation,
  });
  if (keepsReceipt) {
    try {
      result.receipt_path = await writeBatchReceipt(manifestPath, result, {
        dryRun: options.dryRun === true,
        manifestSha256: manifest.metadata.manifest_sha256,
      });
    } catch (error) {
      // Never discard already-landed outcomes merely because persistence failed.
      result.receipt_error = error instanceof Error ? error.message : String(error);
    }
  }
  return result;
}

/**
 * Elide successes only after the complete result is durable; failure falls back to full.
 * `echoSuccesses: false` is a caller that did not ask for the rows: they stay in the receipt
 * and out of the response, as before receipts always carried them.
 */
export function manifestResponse(result: ManifestResult, compact = false, echoSuccesses = true): unknown {
  if ((!compact && echoSuccesses) || !result.receipt_path || result.receipt_error) return result;
  const { successes: _successes, ...summary } = result as ManifestResult & { successes?: unknown };
  return compact
    ? { ...summary, response_mode: 'compact', full_result_retained: true }
    : { ...summary, full_result_retained: true };
}
