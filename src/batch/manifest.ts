import { createHash } from 'node:crypto';
import { stat, readFile } from 'node:fs/promises';
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
