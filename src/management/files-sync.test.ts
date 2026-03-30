import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import * as crypto from 'crypto';
import {
  handleFilesSync,
  handleFilesList,
  categoryDir,
  computeChecksum,
  setSharedBase,
} from './files-sync.js';

let tmpDir: string;

function sha256(content: string | Buffer): string {
  return crypto.createHash('sha256').update(content).digest('hex');
}

// Stub global fetch
const fetchMock = vi.fn<typeof fetch>();
vi.stubGlobal('fetch', fetchMock);

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'nanoclaw-files-test-'));
  setSharedBase(tmpDir);
  fetchMock.mockReset();
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

describe('categoryDir', () => {
  it('returns path for knowledge', () => {
    expect(categoryDir('knowledge')).toBe(path.join(tmpDir, 'knowledge'));
  });

  it('returns path for memory', () => {
    expect(categoryDir('memory')).toBe(path.join(tmpDir, 'memory'));
  });

  it('rejects invalid categories', () => {
    expect(() => categoryDir('evil')).toThrow('invalid category: evil');
    expect(() => categoryDir('../etc')).toThrow('invalid category: ../etc');
    expect(() => categoryDir('')).toThrow('invalid category: ');
  });
});

describe('handleFilesSync', () => {
  it('replace mode — downloads files and deletes extras', async () => {
    const dir = path.join(tmpDir, 'knowledge');
    await fs.mkdir(dir, { recursive: true });
    // Create an extra file that should be deleted in replace mode
    await fs.writeFile(path.join(dir, 'stale.txt'), 'old content');

    const newContent = Buffer.from('hello world');
    fetchMock.mockResolvedValueOnce(new Response(newContent, { status: 200 }));

    const result = await handleFilesSync({
      category: 'knowledge',
      mode: 'replace',
      files: [
        {
          filename: 'readme.md',
          url: 'https://example.com/readme.md',
          checksum: sha256(newContent),
        },
      ],
    });

    expect(result.ok).toBe(true);
    // 1 downloaded + 1 stale deleted
    expect(result.synced).toBe(2);

    // readme.md should exist with correct content
    const written = await fs.readFile(path.join(dir, 'readme.md'));
    expect(written.toString()).toBe('hello world');

    // stale.txt should be gone
    await expect(fs.access(path.join(dir, 'stale.txt'))).rejects.toThrow();
  });

  it('merge mode — downloads files, leaves extras', async () => {
    const dir = path.join(tmpDir, 'knowledge');
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, 'existing.txt'), 'keep me');

    const newContent = Buffer.from('new file');
    fetchMock.mockResolvedValueOnce(new Response(newContent, { status: 200 }));

    const result = await handleFilesSync({
      category: 'knowledge',
      mode: 'merge',
      files: [
        {
          filename: 'added.md',
          url: 'https://example.com/added.md',
          checksum: '',
        },
      ],
    });

    expect(result.ok).toBe(true);
    expect(result.synced).toBe(1);

    // Both files should exist
    const existing = await fs.readFile(path.join(dir, 'existing.txt'), 'utf8');
    expect(existing).toBe('keep me');
    const added = await fs.readFile(path.join(dir, 'added.md'), 'utf8');
    expect(added).toBe('new file');
  });

  it('merge mode with deleted flag — removes specified file', async () => {
    const dir = path.join(tmpDir, 'memory');
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, 'remove-me.txt'), 'bye');

    const result = await handleFilesSync({
      category: 'memory',
      mode: 'merge',
      files: [
        {
          filename: 'remove-me.txt',
          url: '',
          checksum: '',
          deleted: true,
        },
      ],
    });

    expect(result.ok).toBe(true);
    expect(result.synced).toBe(1);
    await expect(fs.access(path.join(dir, 'remove-me.txt'))).rejects.toThrow();
  });

  it('skips file with matching checksum', async () => {
    const dir = path.join(tmpDir, 'knowledge');
    await fs.mkdir(dir, { recursive: true });
    const content = Buffer.from('unchanged content');
    await fs.writeFile(path.join(dir, 'same.txt'), content);
    const checksum = sha256(content);

    const result = await handleFilesSync({
      category: 'knowledge',
      mode: 'merge',
      files: [
        {
          filename: 'same.txt',
          url: 'https://example.com/same.txt',
          checksum,
        },
      ],
    });

    expect(result.ok).toBe(true);
    expect(result.synced).toBe(0);
    // fetch should NOT have been called
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('validates filename — rejects path traversal', async () => {
    fetchMock.mockResolvedValue(
      new Response(Buffer.from('evil'), { status: 200 }),
    );

    const result = await handleFilesSync({
      category: 'knowledge',
      mode: 'merge',
      files: [
        {
          filename: '../../../etc/passwd',
          url: 'https://x.com/a',
          checksum: '',
        },
        { filename: 'sub/dir.txt', url: 'https://x.com/b', checksum: '' },
        { filename: '', url: 'https://x.com/c', checksum: '' },
      ],
    });

    expect(result.ok).toBe(true);
    expect(result.synced).toBe(0);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('creates directory if missing', async () => {
    const dir = path.join(tmpDir, 'knowledge');
    // Directory does not exist yet

    const newContent = Buffer.from('data');
    fetchMock.mockResolvedValueOnce(new Response(newContent, { status: 200 }));

    const result = await handleFilesSync({
      category: 'knowledge',
      mode: 'merge',
      files: [
        {
          filename: 'file.txt',
          url: 'https://example.com/file.txt',
          checksum: '',
        },
      ],
    });

    expect(result.ok).toBe(true);
    expect(result.synced).toBe(1);
    const stat = await fs.stat(dir);
    expect(stat.isDirectory()).toBe(true);
  });
});

describe('handleFilesList', () => {
  it('returns files with sizes and checksums', async () => {
    const dir = path.join(tmpDir, 'knowledge');
    await fs.mkdir(dir, { recursive: true });
    const content = Buffer.from('hello');
    await fs.writeFile(path.join(dir, 'doc.txt'), content);

    const result = await handleFilesList({ category: 'knowledge' });

    expect(result.files).toHaveLength(1);
    expect(result.files[0].filename).toBe('doc.txt');
    expect(result.files[0].size).toBe(5);
    expect(result.files[0].checksum).toBe(sha256(content));
  });

  it('returns empty array for missing directory', async () => {
    const result = await handleFilesList({ category: 'knowledge' });

    expect(result.files).toEqual([]);
  });

  it('skips subdirectories', async () => {
    const dir = path.join(tmpDir, 'memory');
    await fs.mkdir(path.join(dir, 'subdir'), { recursive: true });
    await fs.writeFile(path.join(dir, 'file.txt'), 'data');

    const result = await handleFilesList({ category: 'memory' });

    expect(result.files).toHaveLength(1);
    expect(result.files[0].filename).toBe('file.txt');
  });
});

describe('computeChecksum', () => {
  it('returns sha256 hex digest', async () => {
    const dir = path.join(tmpDir, 'knowledge');
    await fs.mkdir(dir, { recursive: true });
    const filePath = path.join(dir, 'test.txt');
    await fs.writeFile(filePath, 'test content');

    const result = await computeChecksum(filePath);
    expect(result).toBe(sha256('test content'));
  });
});
