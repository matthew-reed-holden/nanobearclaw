import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import * as crypto from 'crypto';
import { MemorySyncManager } from './memory-sync.js';
import type { MemoryUpdatedEvent } from './protocol.js';

function sha256(content: string): string {
  return crypto.createHash('sha256').update(content).digest('hex');
}

describe('MemorySyncManager', () => {
  let tmpDir: string;
  let manager: MemorySyncManager;
  let emitted: Array<{ event: string; payload: MemoryUpdatedEvent }>;
  let emit: (event: string, payload: MemoryUpdatedEvent) => void;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'memory-sync-test-'));
    manager = new MemorySyncManager({ memoryDir: tmpDir });
    emitted = [];
    emit = (event, payload) => emitted.push({ event, payload });
  });

  afterEach(async () => {
    manager.stopPeriodicScan();
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('detects new files and emits memory.updated', async () => {
    await fs.writeFile(path.join(tmpDir, 'notes.md'), 'hello world');

    await manager.scanAndUpload(emit);

    expect(emitted).toHaveLength(1);
    expect(emitted[0].event).toBe('memory.updated');
    expect(emitted[0].payload.filename).toBe('notes.md');
    expect(emitted[0].payload.content).toBe('hello world');
    expect(emitted[0].payload.checksum).toBe(sha256('hello world'));
    expect(emitted[0].payload.deleted).toBe(false);
  });

  it('detects modified files and emits memory.updated', async () => {
    await fs.writeFile(path.join(tmpDir, 'notes.md'), 'version 1');
    await manager.scanAndUpload(emit);
    emitted.length = 0;

    await fs.writeFile(path.join(tmpDir, 'notes.md'), 'version 2');
    await manager.scanAndUpload(emit);

    expect(emitted).toHaveLength(1);
    expect(emitted[0].payload.content).toBe('version 2');
    expect(emitted[0].payload.checksum).toBe(sha256('version 2'));
    expect(emitted[0].payload.deleted).toBe(false);
  });

  it('detects deleted files and emits with deleted=true', async () => {
    await fs.writeFile(path.join(tmpDir, 'notes.md'), 'data');
    await manager.scanAndUpload(emit);
    emitted.length = 0;

    await fs.unlink(path.join(tmpDir, 'notes.md'));
    await manager.scanAndUpload(emit);

    expect(emitted).toHaveLength(1);
    expect(emitted[0].payload.filename).toBe('notes.md');
    expect(emitted[0].payload.content).toBe('');
    expect(emitted[0].payload.checksum).toBe('');
    expect(emitted[0].payload.deleted).toBe(true);
  });

  it('skips unchanged files (same checksum)', async () => {
    await fs.writeFile(path.join(tmpDir, 'notes.md'), 'stable content');
    await manager.scanAndUpload(emit);
    emitted.length = 0;

    await manager.scanAndUpload(emit);

    expect(emitted).toHaveLength(0);
  });

  it('enforces maxFileSize limit', async () => {
    const smallManager = new MemorySyncManager({
      memoryDir: tmpDir,
      maxFileSize: 10,
    });

    await fs.writeFile(path.join(tmpDir, 'small.md'), 'hi');
    await fs.writeFile(
      path.join(tmpDir, 'large.md'),
      'this content exceeds 10 bytes',
    );

    await smallManager.scanAndUpload(emit);

    expect(emitted).toHaveLength(1);
    expect(emitted[0].payload.filename).toBe('small.md');
  });

  it('enforces maxFiles limit', async () => {
    const limitedManager = new MemorySyncManager({
      memoryDir: tmpDir,
      maxFiles: 2,
    });

    await fs.writeFile(path.join(tmpDir, 'a.md'), 'a');
    await fs.writeFile(path.join(tmpDir, 'b.md'), 'b');
    await fs.writeFile(path.join(tmpDir, 'c.md'), 'c');

    await limitedManager.scanAndUpload(emit);

    expect(emitted).toHaveLength(2);
  });

  it('handles missing directory gracefully', async () => {
    const missingDir = path.join(tmpDir, 'nonexistent', 'deep');
    const missingManager = new MemorySyncManager({ memoryDir: missingDir });

    // Should not throw — mkdir with recursive:true creates it
    await missingManager.scanAndUpload(emit);
    expect(emitted).toHaveLength(0);
  });

  it('initializeFromDisk populates known checksums', async () => {
    await fs.writeFile(path.join(tmpDir, 'existing.md'), 'pre-existing');
    await manager.initializeFromDisk();

    // Now scan — should not emit because checksums already known
    await manager.scanAndUpload(emit);
    expect(emitted).toHaveLength(0);
  });

  it('initializeFromDisk handles missing directory', async () => {
    const missingManager = new MemorySyncManager({
      memoryDir: path.join(tmpDir, 'does-not-exist'),
    });

    // Should not throw
    await missingManager.initializeFromDisk();
  });

  it('startPeriodicScan and stopPeriodicScan lifecycle', async () => {
    await fs.writeFile(path.join(tmpDir, 'periodic.md'), 'tick');

    // Use a very short interval for testing
    manager.startPeriodicScan(emit, 50);

    // Wait long enough for at least one interval to fire and complete
    await new Promise((r) => setTimeout(r, 150));
    expect(emitted.length).toBeGreaterThanOrEqual(1);

    manager.stopPeriodicScan();
    const countAfterStop = emitted.length;

    // Wait and verify no more events after stop
    await new Promise((r) => setTimeout(r, 150));
    expect(emitted).toHaveLength(countAfterStop);
  });

  it('skips subdirectories', async () => {
    await fs.mkdir(path.join(tmpDir, 'subdir'));
    await fs.writeFile(path.join(tmpDir, 'subdir', 'nested.md'), 'nested');
    await fs.writeFile(path.join(tmpDir, 'top.md'), 'top-level');

    await manager.scanAndUpload(emit);

    expect(emitted).toHaveLength(1);
    expect(emitted[0].payload.filename).toBe('top.md');
  });

  it('handles multiple files in one scan', async () => {
    await fs.writeFile(path.join(tmpDir, 'a.md'), 'alpha');
    await fs.writeFile(path.join(tmpDir, 'b.md'), 'bravo');

    await manager.scanAndUpload(emit);

    expect(emitted).toHaveLength(2);
    const filenames = emitted.map((e) => e.payload.filename).sort();
    expect(filenames).toEqual(['a.md', 'b.md']);
  });
});
