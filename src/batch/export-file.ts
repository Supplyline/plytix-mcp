import { createHash, randomUUID } from 'node:crypto';
import { link, open, realpath, rename, rm, stat } from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import {
  basename,
  dirname,
  extname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from 'node:path';
import type {
  PlytixProduct,
  ProductBatchExportFormat,
  ProductBatchExportResult,
  ProductBatchExportToFileInput,
} from '../types.js';
import {
  DEFAULT_EXPORT_PAGE_SIZE,
  FILE_EXPORT_MAX_BYTES,
  FILE_EXPORT_MAX_ROWS,
  type ProductExportOperations,
  type ProductExportSink,
  type ProductExportSinkResult,
  canonicalJsonLine,
  executeBatchExport,
} from './export.js';

interface ResolvedExportPath {
  finalPath: string;
  parentPath: string;
  format: ProductBatchExportFormat;
  overwrite: boolean;
}

export async function exportProductsToFile(
  ops: ProductExportOperations,
  rawInput: ProductBatchExportToFileInput,
  options: { exportRoot?: string } = {}
): Promise<ProductBatchExportResult> {
  const startedAt = new Date().toISOString();
  let resolved: ResolvedExportPath;
  try {
    resolved = await resolveExportPath(rawInput, options.exportRoot);
  } catch (error) {
    return {
      status: 'rejected',
      summary: {
        exported: 0,
        failed: 1,
        truncated: false,
      },
      failures: [
        {
          key: 'output_path',
          stage: 'validation',
          errors: [{ field: 'output_path', msg: error instanceof Error ? error.message : String(error) }],
        },
      ],
      metadata: {
        selector_mode: readMode(rawInput),
        row_count: 0,
        page_size: rawInput.page_size ?? DEFAULT_EXPORT_PAGE_SIZE,
        started_at: startedAt,
        completed_at: new Date().toISOString(),
      },
    };
  }

  const sink = new FileProductExportSink(resolved, rawInput.preview_rows);
  return executeBatchExport(ops, rawInput, {
    mode: 'file',
    maxRows: FILE_EXPORT_MAX_ROWS,
    maxFileBytes: FILE_EXPORT_MAX_BYTES,
    sink,
    metadata: {
      output_path: resolved.finalPath,
      format: resolved.format,
    },
  });
}

class FileProductExportSink implements ProductExportSink {
  private handle?: FileHandle;
  private tempPath?: string;
  private readonly hash = createHash('sha256');
  private readonly preview: PlytixProduct[] = [];
  private readonly maxBytes = FILE_EXPORT_MAX_BYTES;
  private bytesWritten = 0;
  private rowCount = 0;

  constructor(
    private readonly output: ResolvedExportPath,
    private readonly previewRows = 5
  ) {}

  async accept(product: PlytixProduct): Promise<'file_byte_cap' | undefined> {
    const line = canonicalJsonLine(product);
    const lineBytes = Buffer.byteLength(line, 'utf8');
    if (this.bytesWritten + lineBytes > this.maxBytes) {
      return 'file_byte_cap';
    }

    await this.ensureOpen();
    await this.handle!.write(line, undefined, 'utf8');
    this.hash.update(line, 'utf8');
    this.bytesWritten += lineBytes;
    this.rowCount += 1;
    if (this.preview.length < this.previewRows) {
      this.preview.push(product);
    }
    return undefined;
  }

  async finish(): Promise<ProductExportSinkResult> {
    await this.ensureOpen();
    await this.handle!.close();
    this.handle = undefined;

    try {
      if (this.output.overwrite) {
        await rename(this.tempPath!, this.output.finalPath);
      } else {
        await link(this.tempPath!, this.output.finalPath);
        await rm(this.tempPath!, { force: true });
      }
      this.tempPath = undefined;
    } catch (error) {
      await this.abort();
      throw error;
    }

    return {
      preview: this.preview,
      rowCount: this.rowCount,
      exportSha256: this.hash.digest('hex'),
      outputPath: this.output.finalPath,
      format: this.output.format,
    };
  }

  async abort(): Promise<void> {
    if (this.handle) {
      await this.handle.close().catch(() => undefined);
      this.handle = undefined;
    }
    if (this.tempPath) {
      await rm(this.tempPath, { force: true }).catch(() => undefined);
      this.tempPath = undefined;
    }
  }

  private async ensureOpen(): Promise<void> {
    if (this.handle) return;
    this.tempPath = join(
      this.output.parentPath,
      `.${basename(this.output.finalPath)}.${randomUUID()}.tmp`
    );
    this.handle = await open(this.tempPath, 'wx');
  }
}

async function resolveExportPath(
  input: ProductBatchExportToFileInput,
  exportRootOverride?: string
): Promise<ResolvedExportPath> {
  const exportRoot = exportRootOverride ?? process.env.PLYTIX_MCP_EXPORT_DIR;
  if (!exportRoot) {
    throw new Error('PLYTIX_MCP_EXPORT_DIR is required for file exports');
  }
  if (!input.output_path || typeof input.output_path !== 'string') {
    throw new Error('output_path must be a non-empty string');
  }
  if (input.output_path.split(/[\\/]+/).includes('..')) {
    throw new Error('output_path must not contain .. segments');
  }

  const rootReal = await realpath(exportRoot);
  const requestedPath = isAbsolute(input.output_path)
    ? resolve(input.output_path)
    : resolve(rootReal, input.output_path);
  const extension = extname(requestedPath).toLowerCase();
  if (extension !== '.jsonl' && extension !== '.ndjson') {
    throw new Error('output_path must end in .jsonl or .ndjson');
  }

  const inferredFormat = extension.slice(1) as ProductBatchExportFormat;
  if (input.format !== undefined && input.format !== inferredFormat) {
    throw new Error(`format ${input.format} does not match ${extension} output_path`);
  }

  let parentReal: string;
  try {
    parentReal = await realpath(dirname(requestedPath));
  } catch {
    throw new Error('output_path parent directory must already exist inside export root');
  }
  if (!isInside(rootReal, parentReal)) {
    throw new Error('output_path parent resolves outside PLYTIX_MCP_EXPORT_DIR');
  }

  const finalPath = join(parentReal, basename(requestedPath));
  if (!isInside(rootReal, finalPath)) {
    throw new Error('output_path resolves outside PLYTIX_MCP_EXPORT_DIR');
  }

  if (!input.overwrite) {
    try {
      await stat(finalPath);
      throw new Error('output_path already exists; pass overwrite: true to replace it');
    } catch (error) {
      if (isNodeError(error) && error.code === 'ENOENT') {
        // The final create is still protected with link(2), so this is only a friendly
        // early error path.
      } else {
        throw error;
      }
    }
  }

  return {
    finalPath,
    parentPath: parentReal,
    format: inferredFormat,
    overwrite: input.overwrite === true,
  };
}

function isInside(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return rel === '' || (!!rel && !rel.startsWith('..') && !rel.startsWith(sep) && !isAbsolute(rel));
}

function readMode(input: ProductBatchExportToFileInput): 'search' | 'skus' | 'product_ids' {
  return input.mode === 'search' || input.mode === 'skus' || input.mode === 'product_ids'
    ? input.mode
    : 'search';
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error;
}
