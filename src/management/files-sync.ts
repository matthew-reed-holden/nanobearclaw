import * as fs from 'fs/promises';
import * as path from 'path';
import * as crypto from 'crypto';
import type {
  FilesSyncParams,
  FilesSyncResult,
  FilesListParams,
  FilesListResult,
  FileListEntry,
} from './protocol.js';

// Base directory for shared files — configurable for testing
let sharedBase = path.join(
  process.env.WORKSPACE_DIR || '/home/node/.nanoclaw',
  'shared',
);

/** Override the shared base directory (used by tests). */
export function setSharedBase(dir: string): void {
  sharedBase = dir;
}

/** Get the current shared base directory. */
export function getSharedBase(): string {
  return sharedBase;
}

export function categoryDir(category: string): string {
  if (category !== 'knowledge' && category !== 'memory') {
    throw new Error(`invalid category: ${category}`);
  }
  return path.join(sharedBase, category);
}

export async function computeChecksum(filePath: string): Promise<string> {
  const content = await fs.readFile(filePath);
  return crypto.createHash('sha256').update(content).digest('hex');
}

export async function handleFilesSync(
  params: FilesSyncParams,
): Promise<FilesSyncResult> {
  const dir = categoryDir(params.category);
  await fs.mkdir(dir, { recursive: true });

  let synced = 0;

  // Track which files are in the sync payload
  const syncedFilenames = new Set<string>();

  for (const file of params.files) {
    // Validate filename — no path separators or traversal
    if (
      file.filename.includes('/') ||
      file.filename.includes('\\') ||
      file.filename.includes('..') ||
      file.filename === ''
    ) {
      continue;
    }

    syncedFilenames.add(file.filename);
    const filePath = path.join(dir, file.filename);

    // Handle deletion in merge mode
    if (file.deleted) {
      try {
        await fs.unlink(filePath);
        synced++;
      } catch (err: any) {
        if (err.code !== 'ENOENT') throw err;
      }
      continue;
    }

    // Check if local file matches checksum — skip if identical
    if (file.checksum) {
      try {
        const localChecksum = await computeChecksum(filePath);
        if (localChecksum === file.checksum) {
          continue; // Already up to date
        }
      } catch {
        // File doesn't exist locally, proceed to download
      }
    }

    // Download from presigned URL
    if (file.url) {
      const response = await fetch(file.url, {
        signal: AbortSignal.timeout(30_000),
      });
      if (!response.ok) {
        continue; // Skip failed downloads
      }
      const content = Buffer.from(await response.arrayBuffer());
      await fs.writeFile(filePath, content);
      synced++;
    }
  }

  // In replace mode: delete local files not in the sync payload
  if (params.mode === 'replace') {
    try {
      const localFiles = await fs.readdir(dir);
      for (const localFile of localFiles) {
        if (!syncedFilenames.has(localFile)) {
          await fs.unlink(path.join(dir, localFile));
          synced++;
        }
      }
    } catch (err: any) {
      if (err.code !== 'ENOENT') {
        throw err;
      }
    }
  }

  return { ok: true, synced };
}

export async function handleFilesList(
  params: FilesListParams,
): Promise<FilesListResult> {
  const dir = categoryDir(params.category);

  let entries: string[];
  try {
    entries = await fs.readdir(dir);
  } catch (err: any) {
    if (err.code === 'ENOENT') {
      return { files: [] };
    }
    throw err;
  }

  const files: FileListEntry[] = [];
  for (const name of entries) {
    const filePath = path.join(dir, name);
    try {
      const stat = await fs.stat(filePath);
      if (!stat.isFile()) continue;
      const checksum = await computeChecksum(filePath);
      files.push({ filename: name, size: stat.size, checksum });
    } catch {
      // Skip files we can't stat
      continue;
    }
  }

  return { files };
}
