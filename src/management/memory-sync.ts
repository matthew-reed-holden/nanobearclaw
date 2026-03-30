import * as fs from 'fs/promises';
import * as path from 'path';
import * as crypto from 'crypto';
import type { MemoryUpdatedEvent } from './protocol.js';

const SHARED_BASE = path.join(
  process.env.WORKSPACE_DIR || '/home/node/.nanoclaw',
  'shared',
);
const MEMORY_DIR = path.join(SHARED_BASE, 'memory');

export type EmitFn = (event: string, payload: MemoryUpdatedEvent) => void;

export class MemorySyncManager {
  private knownChecksums = new Map<string, string>();
  private readonly maxFileSize: number;
  private readonly maxFiles: number;
  private intervalId: ReturnType<typeof setInterval> | null = null;
  private _memoryDir: string;

  constructor(opts?: {
    maxFileSize?: number;
    maxFiles?: number;
    memoryDir?: string;
  }) {
    this.maxFileSize = opts?.maxFileSize ?? 1 * 1024 * 1024; // 1MB
    this.maxFiles = opts?.maxFiles ?? 100;
    this._memoryDir = opts?.memoryDir ?? MEMORY_DIR;
  }

  get memoryDir(): string {
    return this._memoryDir;
  }

  async scanAndUpload(emit: EmitFn): Promise<void> {
    // Ensure directory exists
    await fs.mkdir(this._memoryDir, { recursive: true });

    // 1. List files in memory directory
    let entries: string[];
    try {
      entries = await fs.readdir(this._memoryDir);
    } catch (err: any) {
      if (err.code === 'ENOENT') return;
      throw err;
    }

    // Track current files for deletion detection
    const currentFiles = new Set<string>();
    let fileCount = 0;

    // 2. Process each file
    for (const name of entries) {
      const filePath = path.join(this._memoryDir, name);

      // Validate filename
      if (
        name.includes('/') ||
        name.includes('\\') ||
        name.includes('..') ||
        name === ''
      )
        continue;

      try {
        const stat = await fs.stat(filePath);
        if (!stat.isFile()) continue;

        // Track all valid files to prevent false deletion events
        currentFiles.add(name);

        // Enforce limits (but still track the file above)
        if (stat.size > this.maxFileSize) continue;
        fileCount++;
        if (fileCount > this.maxFiles) continue;

        // Compute checksum
        const content = await fs.readFile(filePath, 'utf-8');
        const checksum = crypto
          .createHash('sha256')
          .update(content)
          .digest('hex');

        // Compare against known checksums
        const knownChecksum = this.knownChecksums.get(name);
        if (knownChecksum === checksum) continue; // Unchanged

        // New or changed file — emit event
        emit('memory.updated', {
          filename: name,
          content,
          checksum,
          deleted: false,
        });

        this.knownChecksums.set(name, checksum);
      } catch {
        // Skip files we can't read
        continue;
      }
    }

    // 3. Detect deleted files
    for (const [name] of this.knownChecksums) {
      if (!currentFiles.has(name)) {
        emit('memory.updated', {
          filename: name,
          content: '',
          checksum: '',
          deleted: true,
        });
        this.knownChecksums.delete(name);
      }
    }
  }

  // Start periodic scanning
  startPeriodicScan(emit: EmitFn, intervalMs: number = 60_000): void {
    this.stopPeriodicScan();
    this.intervalId = setInterval(() => {
      this.scanAndUpload(emit).catch((err) => {
        console.error('Memory sync scan failed:', err);
      });
    }, intervalMs);
  }

  stopPeriodicScan(): void {
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
    }
  }

  // Initialize known state (called after files.sync merge from PaaS)
  async initializeFromDisk(): Promise<void> {
    this.knownChecksums.clear();
    try {
      const entries = await fs.readdir(this._memoryDir);
      for (const name of entries) {
        const filePath = path.join(this._memoryDir, name);
        try {
          const stat = await fs.stat(filePath);
          if (!stat.isFile() || stat.size > this.maxFileSize) continue;
          const content = await fs.readFile(filePath, 'utf-8');
          const checksum = crypto
            .createHash('sha256')
            .update(content)
            .digest('hex');
          this.knownChecksums.set(name, checksum);
        } catch {
          continue;
        }
      }
    } catch (err: any) {
      if (err.code !== 'ENOENT') throw err;
    }
  }
}
