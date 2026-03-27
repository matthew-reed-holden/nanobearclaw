import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import path from 'path';
import { ensureSharedSymlink, GroupsSyncHandler } from './groups-sync.js';
import { SHARED_RESOURCE_PROMPT } from '../shared-prompt.js';

const existsSyncMock = vi.fn<(path: string) => boolean>(() => false);
const mkdirSyncMock = vi.fn();
const symlinkSyncMock = vi.fn();

vi.mock('fs', () => {
  const proxy = {
    existsSync: (p: string) => existsSyncMock(p),
    mkdirSync: (p: string, opts?: any) => mkdirSyncMock(p, opts),
    symlinkSync: (target: string, p: string, type?: string) =>
      symlinkSyncMock(target, p, type),
  };
  return { default: proxy, ...proxy };
});

describe('GroupsSyncHandler', () => {
  let handler: GroupsSyncHandler;

  beforeEach(() => {
    handler = new GroupsSyncHandler();
    existsSyncMock.mockReturnValue(false);
    mkdirSyncMock.mockReturnValue(undefined);
    symlinkSyncMock.mockReturnValue(undefined);
  });

  afterEach(() => {
    existsSyncMock.mockReset();
    mkdirSyncMock.mockReset();
    symlinkSyncMock.mockReset();
  });

  it('sync creates workspace directories', async () => {
    const result = await handler.sync({
      groups: [
        {
          chatJid: 'group1@g.us',
          name: 'Group One',
          folder: 'group-one',
          trigger: '!bot',
          requiresTrigger: true,
          isMain: false,
          instructions: 'be helpful',
        },
      ],
    });

    expect(result).toEqual({ ok: true });
    expect(mkdirSyncMock).toHaveBeenCalledWith(
      expect.stringContaining('group-one'),
      { recursive: true },
    );
  });

  it('sync skips directory creation if it already exists', async () => {
    existsSyncMock.mockReturnValue(true);

    await handler.sync({
      groups: [
        {
          chatJid: 'group1@g.us',
          name: 'Group One',
          folder: 'group-one',
          trigger: '!bot',
          requiresTrigger: true,
          isMain: false,
          instructions: '',
        },
      ],
    });

    expect(mkdirSyncMock).not.toHaveBeenCalled();
  });

  it('sync removes groups from routing but keeps dirs on disk', async () => {
    // First sync: two groups
    await handler.sync({
      groups: [
        {
          chatJid: 'group1@g.us',
          name: 'Group One',
          folder: 'group-one',
          trigger: '!bot',
          requiresTrigger: true,
          isMain: false,
          instructions: '',
        },
        {
          chatJid: 'group2@g.us',
          name: 'Group Two',
          folder: 'group-two',
          trigger: '!ai',
          requiresTrigger: false,
          isMain: false,
          instructions: '',
        },
      ],
    });

    expect(Object.keys(handler.getRegisteredGroups())).toHaveLength(2);

    // Second sync: only one group — group2 removed from routing
    existsSyncMock.mockReturnValue(true); // dirs exist now
    await handler.sync({
      groups: [
        {
          chatJid: 'group1@g.us',
          name: 'Group One',
          folder: 'group-one',
          trigger: '!bot',
          requiresTrigger: true,
          isMain: false,
          instructions: '',
        },
      ],
    });

    const registered = handler.getRegisteredGroups();
    expect(Object.keys(registered)).toHaveLength(1);
    expect(registered['group1@g.us']).toBeDefined();
    expect(registered['group2@g.us']).toBeUndefined();
    // No rmdir call — dirs are kept on disk
  });

  it('sync updates config for existing groups', async () => {
    await handler.sync({
      groups: [
        {
          chatJid: 'group1@g.us',
          name: 'Group One',
          folder: 'group-one',
          trigger: '!bot',
          requiresTrigger: true,
          isMain: false,
          instructions: '',
        },
      ],
    });

    expect(handler.getRegisteredGroups()['group1@g.us'].trigger).toBe('!bot');

    existsSyncMock.mockReturnValue(true);
    await handler.sync({
      groups: [
        {
          chatJid: 'group1@g.us',
          name: 'Group One Updated',
          folder: 'group-one',
          trigger: '!ai',
          requiresTrigger: false,
          isMain: true,
          instructions: '',
        },
      ],
    });

    const group = handler.getRegisteredGroups()['group1@g.us'];
    expect(group.name).toBe('Group One Updated');
    expect(group.trigger).toBe('!ai');
    expect(group.requiresTrigger).toBe(false);
    expect(group.isMain).toBe(true);
  });

  it('list returns current state', async () => {
    await handler.sync({
      groups: [
        {
          chatJid: 'group1@g.us',
          name: 'Group One',
          folder: 'group-one',
          trigger: '!bot',
          requiresTrigger: true,
          isMain: false,
          instructions: '',
        },
      ],
    });

    const result = handler.list();
    expect(result.groups).toHaveLength(1);
    expect(result.groups[0].chatJid).toBe('group1@g.us');
    expect(result.groups[0].name).toBe('Group One');
    expect(result.groups[0].folder).toBe('group-one');
  });

  it('getRegisteredGroups returns correct format', async () => {
    await handler.sync({
      groups: [
        {
          chatJid: 'group1@g.us',
          name: 'Group One',
          folder: 'group-one',
          trigger: '!bot',
          requiresTrigger: true,
          isMain: false,
          instructions: '',
        },
        {
          chatJid: 'group2@g.us',
          name: 'Group Two',
          folder: 'group-two',
          trigger: '',
          requiresTrigger: false,
          isMain: true,
          instructions: '',
        },
      ],
    });

    const result = handler.getRegisteredGroups();
    expect(result).toEqual({
      'group1@g.us': expect.objectContaining({
        name: 'Group One',
        folder: 'group-one',
        trigger: '!bot',
        requiresTrigger: true,
        isMain: false,
      }),
      'group2@g.us': expect.objectContaining({
        name: 'Group Two',
        folder: 'group-two',
        trigger: '',
        requiresTrigger: false,
        isMain: true,
      }),
    });
  });
});

describe('ensureSharedSymlink', () => {
  beforeEach(() => {
    symlinkSyncMock.mockReturnValue(undefined);
  });

  afterEach(() => {
    symlinkSyncMock.mockReset();
  });

  it('creates a symlink pointing to ../../shared', () => {
    ensureSharedSymlink('/workspace/chats/test-group');

    expect(symlinkSyncMock).toHaveBeenCalledWith(
      '../../shared',
      path.join('/workspace/chats/test-group', 'shared'),
      'dir',
    );
  });

  it('silently ignores EEXIST when symlink already exists', () => {
    const eexistError = Object.assign(new Error('EEXIST'), { code: 'EEXIST' });
    symlinkSyncMock.mockImplementation(() => {
      throw eexistError;
    });

    expect(() => ensureSharedSymlink('/workspace/chats/test-group')).not.toThrow();
  });

  it('throws on non-EEXIST errors', () => {
    const enoentError = Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    symlinkSyncMock.mockImplementation(() => {
      throw enoentError;
    });

    expect(() => ensureSharedSymlink('/workspace/chats/test-group')).toThrow('ENOENT');
  });
});

describe('sync() creates shared symlinks', () => {
  let handler: GroupsSyncHandler;

  beforeEach(() => {
    handler = new GroupsSyncHandler();
    existsSyncMock.mockReturnValue(false);
    mkdirSyncMock.mockReturnValue(undefined);
    symlinkSyncMock.mockReturnValue(undefined);
  });

  afterEach(() => {
    existsSyncMock.mockReset();
    mkdirSyncMock.mockReset();
    symlinkSyncMock.mockReset();
  });

  it('calls ensureSharedSymlink for each group during sync', async () => {
    await handler.sync({
      groups: [
        {
          chatJid: 'group1@g.us',
          name: 'Group One',
          folder: 'group-one',
          trigger: '!bot',
          requiresTrigger: true,
          isMain: false,
          instructions: '',
        },
        {
          chatJid: 'group2@g.us',
          name: 'Group Two',
          folder: 'group-two',
          trigger: '!ai',
          requiresTrigger: false,
          isMain: true,
          instructions: '',
        },
      ],
    });

    // symlinkSync should have been called once per group
    expect(symlinkSyncMock).toHaveBeenCalledTimes(2);
    expect(symlinkSyncMock).toHaveBeenCalledWith(
      '../../shared',
      expect.stringContaining('group-one' + path.sep + 'shared'),
      'dir',
    );
    expect(symlinkSyncMock).toHaveBeenCalledWith(
      '../../shared',
      expect.stringContaining('group-two' + path.sep + 'shared'),
      'dir',
    );
  });

  it('sync succeeds even when symlinks already exist (EEXIST)', async () => {
    const eexistError = Object.assign(new Error('EEXIST'), { code: 'EEXIST' });
    symlinkSyncMock.mockImplementation(() => {
      throw eexistError;
    });

    const result = await handler.sync({
      groups: [
        {
          chatJid: 'group1@g.us',
          name: 'Group One',
          folder: 'group-one',
          trigger: '!bot',
          requiresTrigger: true,
          isMain: false,
          instructions: '',
        },
      ],
    });

    expect(result).toEqual({ ok: true });
  });
});

describe('SHARED_RESOURCE_PROMPT', () => {
  it('contains Knowledge Base reference', () => {
    expect(SHARED_RESOURCE_PROMPT).toContain('Knowledge Base');
  });

  it('contains Memory reference', () => {
    expect(SHARED_RESOURCE_PROMPT).toContain('Memory');
  });

  it('contains shared/knowledge/ path', () => {
    expect(SHARED_RESOURCE_PROMPT).toContain('shared/knowledge/');
  });

  it('contains shared/memory/ path', () => {
    expect(SHARED_RESOURCE_PROMPT).toContain('shared/memory/');
  });

  it('mentions workspace isolation', () => {
    expect(SHARED_RESOURCE_PROMPT).toContain('this chat only');
  });

  it('instructs to use shared/memory/ as the only memory system', () => {
    expect(SHARED_RESOURCE_PROMPT).toContain('your ONLY memory system');
  });
});
