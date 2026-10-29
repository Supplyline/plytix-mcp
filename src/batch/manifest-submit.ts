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
  const result: ManifestResult = await client.batchUpdateProducts(manifest.items, {
    dryRun: options.dryRun === true,
    returnSuccesses: options.returnSuccesses === true || options.compact === true || options.requireReceipt === true,
    maxItems: MANIFEST_MAX_ITEMS,
    metadata: manifest.metadata,
    beforeMutation: options.beforeMutation,
  });
  if (options.writeReceipt !== false || options.requireReceipt) {
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

/** Elide successes only after the complete result is durable; failure falls back to full. */
export function manifestResponse(result: ManifestResult, compact = false): unknown {
  if (!compact || !result.receipt_path || result.receipt_error) return result;
  const { successes: _successes, ...summary } = result as ManifestResult & { successes?: unknown };
  return { ...summary, response_mode: 'compact', full_result_retained: true };
}
