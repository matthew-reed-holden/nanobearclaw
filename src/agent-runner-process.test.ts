import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'events';
import { PassThrough } from 'stream';
import { spawn } from 'child_process';

// Create a controllable fake ChildProcess (same pattern as child-process-runner.test.ts)
function createFakeProcess() {
  const proc = new EventEmitter() as EventEmitter & {
    stdin: PassThrough;
    stdout: PassThrough;
    stderr: PassThrough;
    kill: ReturnType<typeof vi.fn>;
    pid: number;
  };
  proc.stdin = new PassThrough();
  proc.stdout = new PassThrough();
  proc.stderr = new PassThrough();
  proc.kill = vi.fn();
  proc.pid = 12345;
  return proc;
}

let fakeProc: ReturnType<typeof createFakeProcess>;

// Mock child_process.spawn — references fakeProc which is reassigned in beforeEach
vi.mock('child_process', async () => {
  const actual =
    await vi.importActual<typeof import('child_process')>('child_process');
  return {
    ...actual,
    spawn: vi.fn(() => fakeProc),
  };
});

import { AgentRunnerProcess } from './agent-runner-process.js';
import type { AgentRunner } from './management/agent-runner.js';

const spawnMock = vi.mocked(spawn);

describe('AgentRunnerProcess', () => {
  beforeEach(() => {
    fakeProc = createFakeProcess();
    // Ensure the pre-flight API key check passes in tests
    process.env.ANTHROPIC_API_KEY = 'sk-ant-test-key';
  });

  afterEach(async () => {
    vi.clearAllMocks();
    delete process.env.ANTHROPIC_API_KEY;
  });

  it('should conform to AgentRunner interface', () => {
    const runner = new AgentRunnerProcess({ maxConcurrent: 2 });
    const asRunner: AgentRunner = runner;
    expect(asRunner).toBeDefined();
  });

  it('spawns a node process with agent-runner path and IPC_MODE=stdin', async () => {
    const runner = new AgentRunnerProcess({ maxConcurrent: 2 });
    await runner.spawn({
      sessionKey: 'test-session',
      model: 'claude-sonnet-4-20250514',
      systemPrompt: 'Be helpful',
      initialPrompt: 'Hello',
    });

    expect(spawnMock).toHaveBeenCalledWith(
      'node',
      expect.arrayContaining([expect.stringContaining('agent-runner')]),
      expect.objectContaining({
        stdio: ['pipe', 'pipe', 'pipe'],
        env: expect.objectContaining({ IPC_MODE: 'stdin' }),
      }),
    );
    await runner.killAll();
  });

  it('writes ContainerInput JSON as first stdin line', async () => {
    const writeSpy = vi.spyOn(fakeProc.stdin, 'write');
    const runner = new AgentRunnerProcess({ maxConcurrent: 2 });
    await runner.spawn({
      sessionKey: 'test-session',
      model: 'claude-sonnet-4-20250514',
      systemPrompt: 'Be helpful',
      initialPrompt: 'Hello',
    });

    // First write should be the ContainerInput JSON line
    expect(writeSpy).toHaveBeenCalled();
    const writeCall = writeSpy.mock.calls[0][0] as string;
    expect(writeCall).toMatch(/\n$/); // Must end with newline
    const input = JSON.parse(writeCall.slice(0, -1));
    expect(input.prompt).toBe('Hello');
    expect(input.chatJid).toBe('test-session');
    expect(input.groupFolder).toBe('test-session');
    expect(input.isMain).toBe(false);
    await runner.killAll();
  });

  it('passes custom groupFolder and assistantName in ContainerInput', async () => {
    const writeSpy = vi.spyOn(fakeProc.stdin, 'write');
    const runner = new AgentRunnerProcess({ maxConcurrent: 2 });
    await runner.spawn({
      sessionKey: 'test-session',
      model: 'claude-sonnet-4-20250514',
      systemPrompt: '',
      initialPrompt: 'Hi',
      groupFolder: 'my-group',
      isMain: true,
      assistantName: 'TestBot',
    });

    const writeCall = writeSpy.mock.calls[0][0] as string;
    const input = JSON.parse(writeCall.slice(0, -1));
    expect(input.groupFolder).toBe('my-group');
    expect(input.isMain).toBe(true);
    expect(input.assistantName).toBe('TestBot');
    await runner.killAll();
  });

  it('passes resumeSessionId as sessionId in ContainerInput', async () => {
    const writeSpy = vi.spyOn(fakeProc.stdin, 'write');
    const runner = new AgentRunnerProcess({ maxConcurrent: 2 });
    await runner.spawn({
      sessionKey: 'test-session',
      model: 'claude-sonnet-4-20250514',
      systemPrompt: '',
      resumeSessionId: 'sess-abc123',
    });

    const writeCall = writeSpy.mock.calls[0][0] as string;
    const input = JSON.parse(writeCall.slice(0, -1));
    expect(input.sessionId).toBe('sess-abc123');
    await runner.killAll();
  });

  it('rejects when max concurrent reached', async () => {
    const runner = new AgentRunnerProcess({ maxConcurrent: 2 });

    await runner.spawn({ sessionKey: 's1', model: 'm', systemPrompt: '' });

    const secondProc = createFakeProcess();
    secondProc.pid = 12346;
    spawnMock.mockReturnValueOnce(secondProc as never);
    await runner.spawn({ sessionKey: 's2', model: 'm', systemPrompt: '' });

    await expect(
      runner.spawn({ sessionKey: 's3', model: 'm', systemPrompt: '' }),
    ).rejects.toThrow(/max concurrent/i);
    await runner.killAll();
  });

  it('rejects duplicate session keys', async () => {
    const runner = new AgentRunnerProcess({ maxConcurrent: 2 });
    await runner.spawn({ sessionKey: 's1', model: 'm', systemPrompt: '' });
    await expect(
      runner.spawn({ sessionKey: 's1', model: 'm', systemPrompt: '' }),
    ).rejects.toThrow(/already exists/i);
    await runner.killAll();
  });

  it('sendMessage writes JSON line to stdin', async () => {
    const writeSpy = vi.spyOn(fakeProc.stdin, 'write');
    const runner = new AgentRunnerProcess({ maxConcurrent: 2 });
    await runner.spawn({ sessionKey: 's1', model: 'm', systemPrompt: '' });
    await runner.sendMessage('s1', 'follow up');

    // Last write should be the message JSON
    const calls = writeSpy.mock.calls;
    const lastCall = calls[calls.length - 1][0] as string;
    expect(lastCall).toMatch(/\n$/);
    const msg = JSON.parse(lastCall.slice(0, -1));
    expect(msg).toEqual({ type: 'message', text: 'follow up' });
    await runner.killAll();
  });

  it('sendMessage throws for nonexistent session', async () => {
    const runner = new AgentRunnerProcess({ maxConcurrent: 2 });
    await expect(runner.sendMessage('nonexistent', 'hello')).rejects.toThrow(
      /not found/i,
    );
  });

  it('kill writes close signal then sends SIGTERM after timeout', async () => {
    vi.useFakeTimers();
    const writeSpy = vi.spyOn(fakeProc.stdin, 'write');
    const runner = new AgentRunnerProcess({ maxConcurrent: 2 });
    await runner.spawn({ sessionKey: 's1', model: 'm', systemPrompt: '' });
    await runner.kill('s1');

    // Last write should be the close signal
    const calls = writeSpy.mock.calls;
    const lastCall = calls[calls.length - 1][0] as string;
    expect(JSON.parse(lastCall.slice(0, -1))).toEqual({ type: 'close' });

    // SIGTERM fires after 5s timeout
    expect(fakeProc.kill).not.toHaveBeenCalled();
    vi.advanceTimersByTime(6000);
    expect(fakeProc.kill).toHaveBeenCalledWith('SIGTERM');
    vi.useRealTimers();
  });

  it('kill on nonexistent session is a no-op', async () => {
    const runner = new AgentRunnerProcess({ maxConcurrent: 2 });
    await runner.kill('does-not-exist'); // Should not throw
  });

  it('emits output events from stdout', async () => {
    const runner = new AgentRunnerProcess({ maxConcurrent: 2 });
    const outputSpy = vi.fn();
    runner.on('output', outputSpy);

    await runner.spawn({ sessionKey: 's1', model: 'm', systemPrompt: '' });

    // Simulate stdout data
    fakeProc.stdout.push(
      '---NANOCLAW_STREAM_EVENT---\n{"event":"chat.delta","payload":{"content":"Hi"}}\n',
    );
    await new Promise((r) => setTimeout(r, 10));

    expect(outputSpy).toHaveBeenCalledWith('s1', expect.any(String));
  });

  it('emits stderr events', async () => {
    const runner = new AgentRunnerProcess({ maxConcurrent: 2 });
    const stderrSpy = vi.fn();
    runner.on('stderr', stderrSpy);

    await runner.spawn({ sessionKey: 's1', model: 'm', systemPrompt: '' });

    fakeProc.stderr.push('Warning: something happened\n');
    await new Promise((r) => setTimeout(r, 10));

    expect(stderrSpy).toHaveBeenCalledWith(
      's1',
      expect.stringContaining('Warning'),
    );
  });

  it('calls onOutput and onError callbacks', async () => {
    const runner = new AgentRunnerProcess({ maxConcurrent: 2 });
    const onOutput = vi.fn();
    const onError = vi.fn();
    await runner.spawn({
      sessionKey: 's1',
      model: 'm',
      systemPrompt: '',
      onOutput,
      onError,
    });

    fakeProc.stdout.push('some output');
    fakeProc.stderr.push('some error');
    await new Promise((r) => setTimeout(r, 10));

    expect(onOutput).toHaveBeenCalledWith(
      expect.stringContaining('some output'),
    );
    expect(onError).toHaveBeenCalledWith(expect.stringContaining('some error'));
    await runner.killAll();
  });

  it('cleans up session on exit and emits exit event', async () => {
    const runner = new AgentRunnerProcess({ maxConcurrent: 2 });
    const onExit = vi.fn();
    const exitEvent = vi.fn();
    runner.on('exit', exitEvent);

    await runner.spawn({
      sessionKey: 's1',
      model: 'm',
      systemPrompt: '',
      onExit,
    });
    expect(runner.activeCount).toBe(1);

    fakeProc.emit('exit', 0);
    await new Promise((r) => setTimeout(r, 10));

    expect(runner.activeCount).toBe(0);
    expect(onExit).toHaveBeenCalledWith(0);
    expect(exitEvent).toHaveBeenCalledWith('s1', 0);
  });

  it('reports activeCount correctly', async () => {
    const runner = new AgentRunnerProcess({ maxConcurrent: 3 });
    expect(runner.activeCount).toBe(0);

    await runner.spawn({ sessionKey: 'a', model: 'm', systemPrompt: '' });
    expect(runner.activeCount).toBe(1);

    const secondProc = createFakeProcess();
    secondProc.pid = 12346;
    spawnMock.mockReturnValueOnce(secondProc as never);
    await runner.spawn({ sessionKey: 'b', model: 'm', systemPrompt: '' });
    expect(runner.activeCount).toBe(2);

    await runner.kill('a');
    expect(runner.activeCount).toBe(1);

    await runner.killAll();
    expect(runner.activeCount).toBe(0);
  });

  it('retrieves session by key via getSession', async () => {
    const runner = new AgentRunnerProcess({ maxConcurrent: 2 });
    await runner.spawn({
      sessionKey: 'lookup',
      model: 'claude-sonnet-4-20250514',
      systemPrompt: '',
    });

    const session = runner.getSession('lookup');
    expect(session).toBeDefined();
    expect(session!.sessionKey).toBe('lookup');
    expect(session!.pid).toBe(12345);
    expect(session!.startedAt).toBeInstanceOf(Date);

    expect(runner.getSession('nonexistent')).toBeUndefined();
    await runner.killAll();
  });

  it('throws when no Anthropic credentials are configured', async () => {
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.ANTHROPIC_BASE_URL;
    delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
    delete process.env.ANTHROPIC_AUTH_TOKEN;
    const runner = new AgentRunnerProcess({ maxConcurrent: 2 });
    await expect(
      runner.spawn({ sessionKey: 'no-creds', model: 'm', systemPrompt: '' }),
    ).rejects.toThrow(/No Anthropic credentials configured/);
  });

  it('allows spawn when ANTHROPIC_BASE_URL is set instead of API key', async () => {
    delete process.env.ANTHROPIC_API_KEY;
    process.env.ANTHROPIC_BASE_URL = 'http://bifrost:8080';
    const runner = new AgentRunnerProcess({ maxConcurrent: 2 });
    const session = await runner.spawn({
      sessionKey: 'bifrost-test',
      model: 'm',
      systemPrompt: '',
    });
    expect(session).toBeDefined();
    await runner.killAll();
    delete process.env.ANTHROPIC_BASE_URL;
  });

  it('remaps setup-token from ANTHROPIC_API_KEY to CLAUDE_CODE_OAUTH_TOKEN', async () => {
    process.env.ANTHROPIC_API_KEY = 'sk-ant-oat01-setup-token-value';
    const runner = new AgentRunnerProcess({ maxConcurrent: 2 });
    await runner.spawn({
      sessionKey: 'remap-test',
      model: 'm',
      systemPrompt: '',
    });

    const spawnCall = spawnMock.mock.calls[spawnMock.mock.calls.length - 1];
    const spawnEnv = spawnCall[2]?.env as Record<string, string | undefined>;
    expect(spawnEnv?.CLAUDE_CODE_OAUTH_TOKEN).toBe(
      'sk-ant-oat01-setup-token-value',
    );
    expect(spawnEnv?.ANTHROPIC_API_KEY).toBeUndefined();
    await runner.killAll();
  });

  it('passes cwd to spawn options when provided', async () => {
    const runner = new AgentRunnerProcess({ maxConcurrent: 2 });
    await runner.spawn({
      sessionKey: 'cwd-test',
      model: 'm',
      systemPrompt: '',
      cwd: '/tmp/workspace',
    });

    expect(spawnMock).toHaveBeenCalledWith(
      'node',
      expect.any(Array),
      expect.objectContaining({ cwd: '/tmp/workspace' }),
    );
    await runner.killAll();
  });

  it('passes cwd as workspaceDir in ContainerInput', async () => {
    const writeSpy = vi.spyOn(fakeProc.stdin, 'write');
    const runner = new AgentRunnerProcess({ maxConcurrent: 2 });
    await runner.spawn({
      sessionKey: 'ws-test',
      model: 'm',
      systemPrompt: '',
      cwd: '/tmp/workspace',
    });

    const writeCall = writeSpy.mock.calls[0][0] as string;
    const input = JSON.parse(writeCall.slice(0, -1));
    expect(input.workspaceDir).toBe('/tmp/workspace');
    await runner.killAll();
  });
});
