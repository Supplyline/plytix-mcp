import { createHash } from 'node:crypto';
import { stat, readFile, open } from 'node:fs/promises';
import { extname } from 'node:path';
import type { BatchUpdateItem, BatchUpdateMetadata } from '../types.js';
import { MANIFEST_MAX_BYTES } from './helpers.js';

export interface BatchManifest {
  items: BatchUpdateItem[];
  metadata: BatchUpdateMetadata;
}

export async function readBatchManifest(manifestPath: string): Promise<BatchManifest> {
  if (extname(manifestPath).toLowerCase() !== '.json') {
    throw new Error('manifest_path must point to a .json file');
  }

  const info = await stat(manifestPath);
  if (!info.isFile()) {
    throw new Error('manifest_path must point to a file');
  }
  if (info.size > MANIFEST_MAX_BYTES) {
    throw new Error(`manifest file is ${info.size} bytes; max is ${MANIFEST_MAX_BYTES}`);
  }

  const bytes = await readFile(manifestPath);
  const manifestSha256 = createHash('sha256').update(bytes).digest('hex');

  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    throw new Error('manifest file must be valid UTF-8');
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error('manifest file must contain valid JSON');
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('manifest must be a JSON object');
  }

  const obj = parsed as Record<string, unknown>;
  if (obj.schema_version !== 1) {
    throw new Error('manifest schema_version must be 1');
  }
  if (!Array.isArray(obj.items)) {
    throw new Error('manifest items must be an array');
  }

  const metadata: BatchUpdateMetadata = { manifest_sha256: manifestSha256 };
  if (typeof obj.series_id === 'string') metadata.series_id = obj.series_id;
  if (typeof obj.config_snapshot_hash === 'string') {
    metadata.config_snapshot_hash = obj.config_snapshot_hash;
  }

  return {
    items: obj.items as BatchUpdateItem[],
    metadata,
  };
}

export const RECEIPT_SCHEMA = 'plytix-batch-receipt/1';

/**
 * Write the tool result next to its manifest, so a caller's ledger reads what the tool returned
 * instead of a hand-copied summary (Seametrics landing run, 2026-09-26). Never overwrites: a
 * receipt name already taken gets a numeric suffix. Returns the path written.
 */
export async function writeBatchReceipt(
  manifestPath: string,
  result: unknown,
  options: { dryRun: boolean; manifestSha256?: string; now?: Date }
): Promise<string> {
  const at = options.now ?? new Date();
  const stamp = at.toISOString().replace(/[:.]/g, '-');
  const base = manifestPath.replace(/\.json$/i, '');
  const body = `${JSON.stringify(
    {
      schema: RECEIPT_SCHEMA,
      manifest_path: manifestPath,
      ...(options.manifestSha256 ? { manifest_sha256: options.manifestSha256 } : {}),
      dry_run: options.dryRun,
      written_at: at.toISOString(),
      result,
    },
    null,
    2
  )}\n`;
  for (let attempt = 0; attempt < 10; attempt += 1) {
    const suffix = attempt === 0 ? '' : `-${attempt}`;
    const path = `${base}.receipt.${options.dryRun ? 'dry-run' : 'live'}.${stamp}${suffix}.json`;
    try {
      await writeExclusiveFile(path, body);
      return path;
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code !== 'EEXIST') throw error;
    }
  }
  throw new Error('could not find a free receipt file name');
}

/** Persist complete evidence before returning. Existing paths are never overwritten. */
export async function writeExclusiveFile(path: string, body: string): Promise<void> {
  const file = await open(path, 'wx');
  try {
    await file.writeFile(body);
    await file.sync();
  } finally {
    await file.close();
  }
}
