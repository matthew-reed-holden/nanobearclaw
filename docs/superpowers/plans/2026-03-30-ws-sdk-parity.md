# WS/K8s SDK Feature Parity Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the `claude` CLI child process in `Dockerfile.ws` with the agent-runner, bringing SDK-based agent capabilities (MCP tools, X integration, hooks, streaming) to the K8s deployment.

**Architecture:** Four phases across one repo. Phase 1 adds streaming + stdin IPC to the agent-runner. Phase 2 builds the `AgentRunnerProcess` class and output parser on the WS side. Phase 3 updates Dockerfile.ws. Phase 4 integrates everything in the k8s-entrypoint with a feature flag.

**Tech Stack:** TypeScript, `@anthropic-ai/claude-agent-sdk`, Node.js child_process, vitest

**Spec:** `docs/superpowers/specs/2026-03-30-ws-sdk-parity.md`

---

## File Structure

### New Files

```
src/agent-runner-process.ts              # AgentRunnerProcess class (AgentRunner impl)
src/agent-runner-process.test.ts         # Tests for AgentRunnerProcess
src/management/agent-runner-parser.ts    # Marker-based stdout parser
src/management/agent-runner-parser.test.ts  # Tests for parser
```

### Modified Files

```
container/agent-runner/src/index.ts      # Add streaming output, stdin IPC mode, configurable cwd
container/Dockerfile.ws                  # Bundle agent-runner + skills, pre-compile
src/k8s-entrypoint.ts                    # Runner selection via AGENT_MODE env var
src/management/index.ts                  # Export new parser
```

---

## Phase 1: Agent-Runner Streaming + Stdin IPC

### Task 1: Agent-Runner Output Streaming

**Files:**
- Modify: `container/agent-runner/src/index.ts:109-116` (add stream marker + writer)
- Modify: `container/agent-runner/src/index.ts:394-467` (add streaming to query loop)

> Note: The agent-runner has no test suite. These changes are tested indirectly via the parser tests in Phase 2 and integration tests in Phase 4.

- [ ] **Step 1: Add stream event marker and writer function**

In `container/agent-runner/src/index.ts`, after line 110 (`OUTPUT_END_MARKER`), add:

```typescript
const STREAM_EVENT_MARKER = '---NANOCLAW_STREAM_EVENT---';

function writeStreamEvent(event: string, payload: Record<string, unknown>): void {
  console.log(STREAM_EVENT_MARKER);
  console.log(JSON.stringify({ event, payload }));
}
```

- [ ] **Step 2: Enable includePartialMessages in SDK query options**

In `container/agent-runner/src/index.ts`, inside the `query()` call options block (around line 396), add `includePartialMessages: true` after `settingSources`:

```typescript
      settingSources: ['project', 'user'],
      includePartialMessages: true,
```

- [ ] **Step 3: Add streaming handlers to the for-await loop**

In `container/agent-runner/src/index.ts`, inside the `for await` loop in `runQuery()`, after the existing `log()` call (line 441) and before the `assistant` UUID tracking (line 443), add stream_event handling:

```typescript
    // Stream text deltas to host
    if (message.type === 'stream_event') {
      const ev = (message as { event?: { type?: string; delta?: { type?: string; text?: string } } }).event;
      if (ev?.type === 'content_block_delta' && ev.delta?.type === 'text_delta' && ev.delta.text) {
        writeStreamEvent('chat.delta', { content: ev.delta.text });
      }
    }
```

After the `assistant` UUID tracking block (line 445), add tool_use streaming:

```typescript
    // Stream tool use notifications to host
    if (message.type === 'assistant') {
      const msg = message as { message?: { content?: Array<{ type: string; name?: string; input?: unknown }> } };
      if (msg.message?.content) {
        for (const block of msg.message.content) {
          if (block.type === 'tool_use') {
            writeStreamEvent('agent.tool', { tool: block.name || '', input: block.input, output: null });
          }
        }
      }
    }
```

- [ ] **Step 4: Commit**

```bash
git add container/agent-runner/src/index.ts
git commit -m "feat(agent-runner): add real-time streaming output via STREAM_EVENT_MARKER"
```

---

### Task 2: Agent-Runner Stdin IPC Mode

**Files:**
- Modify: `container/agent-runner/src/index.ts:59-61` (IPC constants)
- Modify: `container/agent-runner/src/index.ts:99-107` (readStdin)
- Modify: `container/agent-runner/src/index.ts:523-562` (main function)
- Modify: `container/agent-runner/src/index.ts:684-720` (query loop)

- [ ] **Step 1: Add IPC_MODE detection and stdin line reader**

In `container/agent-runner/src/index.ts`, after the IPC constants (line 61), add:

```typescript
const IPC_MODE = process.env.IPC_MODE || 'file';

/**
 * Read a single line from stdin (up to the first newline).
 * Returns the line content without the trailing newline.
 */
function readStdinLine(): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = '';
    process.stdin.setEncoding('utf8');
    const onData = (chunk: string) => {
      data += chunk;
      const nlIdx = data.indexOf('\n');
      if (nlIdx !== -1) {
        process.stdin.removeListener('data', onData);
        process.stdin.removeListener('error', onError);
        // Keep stdin open — don't pause, just stop accumulating for this read.
        // The remainder after the newline is left in Node's internal buffer.
        // We'll set up a readline interface for subsequent messages.
        resolve(data.slice(0, nlIdx));
      }
    };
    const onError = (err: Error) => {
      process.stdin.removeListener('data', onData);
      reject(err);
    };
    process.stdin.on('data', onData);
    process.stdin.on('error', onError);
  });
}
```

- [ ] **Step 2: Add stdin IPC message pump**

After the `readStdinLine` function, add:

```typescript
import { createInterface } from 'readline';

interface StdinIpcMessage {
  type: 'message' | 'close';
  text?: string;
}

/**
 * Start a readline-based IPC pump on stdin.
 * Calls onMessage for each message, onClose when close signal or EOF received.
 */
function startStdinIpc(
  onMessage: (text: string) => void,
  onClose: () => void,
): void {
  const rl = createInterface({ input: process.stdin });
  rl.on('line', (line) => {
    try {
      const msg: StdinIpcMessage = JSON.parse(line);
      if (msg.type === 'close') {
        rl.close();
        onClose();
      } else if (msg.type === 'message' && msg.text) {
        onMessage(msg.text);
      }
    } catch {
      log(`Ignoring unparseable stdin line: ${line.slice(0, 100)}`);
    }
  });
  rl.on('close', () => {
    onClose();
  });
}
```

Note: The `import { createInterface } from 'readline'` should be added at the top of the file with the other imports.

- [ ] **Step 3: Modify main() to support stdin IPC mode**

In `main()`, replace the stdin reading block (lines 526-528):

```typescript
    const stdinData = await readStdin();
    containerInput = JSON.parse(stdinData);
```

with:

```typescript
    const stdinData = IPC_MODE === 'stdin' ? await readStdinLine() : await readStdin();
    containerInput = JSON.parse(stdinData);
```

- [ ] **Step 4: Add stdin IPC to the query loop**

In `main()`, before the query loop (line 684), add a conditional branch for stdin IPC mode. Replace the existing query loop block (lines 684-720) with:

```typescript
  if (IPC_MODE === 'stdin') {
    // Stdin IPC mode: messages arrive as JSON lines on stdin.
    // MessageStream feeds them into the active query.
    const stdinStream = new MessageStream();
    stdinStream.push(prompt);
    let stdinClosed = false;

    startStdinIpc(
      (text) => stdinStream.push(text),
      () => { stdinClosed = true; stdinStream.end(); },
    );

    // Single long-running query with MessageStream
    log(`Starting SDK query (stdin IPC, session: ${sessionId || 'new'})...`);
    const queryResult = await runQuery(prompt, sessionId, mcpServerPath, containerInput, sdkEnv, undefined);
    if (queryResult.newSessionId) sessionId = queryResult.newSessionId;
    writeOutput({ status: 'success', result: null, newSessionId: sessionId });
  } else {
    // File IPC mode: existing behavior (poll /workspace/ipc/input/)
    // Query loop: run query → wait for IPC message → run new query → repeat
    let resumeAt: string | undefined;
    try {
      while (true) {
        log(`Starting query (session: ${sessionId || 'new'}, resumeAt: ${resumeAt || 'latest'})...`);

        const queryResult = await runQuery(prompt, sessionId, mcpServerPath, containerInput, sdkEnv, resumeAt);
        if (queryResult.newSessionId) {
          sessionId = queryResult.newSessionId;
        }
        if (queryResult.lastAssistantUuid) {
          resumeAt = queryResult.lastAssistantUuid;
        }

        if (queryResult.closedDuringQuery) {
          log('Close sentinel consumed during query, exiting');
          break;
        }

        writeOutput({ status: 'success', result: null, newSessionId: sessionId });

        log('Query ended, waiting for next IPC message...');
        const nextMessage = await waitForIpcMessage();
        if (nextMessage === null) {
          log('Close sentinel received, exiting');
          break;
        }

        log(`Got new message (${nextMessage.length} chars), starting new query`);
        prompt = nextMessage;
      }
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      log(`Agent error: ${errorMessage}`);
      writeOutput({
        status: 'error',
        result: null,
        newSessionId: sessionId,
        error: errorMessage
      });
      process.exit(1);
    }
  }
```

- [ ] **Step 5: Skip file-based IPC setup in stdin mode**

In `main()`, wrap the IPC directory creation and sentinel cleanup (lines 548-551) in a condition:

```typescript
  if (IPC_MODE === 'file') {
    fs.mkdirSync(IPC_INPUT_DIR, { recursive: true });
    try { fs.unlinkSync(IPC_INPUT_CLOSE_SENTINEL); } catch { /* ignore */ }
  }
```

And wrap the pending IPC drain (lines 558-562):

```typescript
  if (IPC_MODE === 'file') {
    const pending = drainIpcInput();
    if (pending.length > 0) {
      log(`Draining ${pending.length} pending IPC messages into initial prompt`);
      prompt += '\n' + pending.join('\n');
    }
  }
```

- [ ] **Step 6: Commit**

```bash
git add container/agent-runner/src/index.ts
git commit -m "feat(agent-runner): add stdin-based IPC mode (IPC_MODE=stdin)"
```

---

### Task 3: Agent-Runner Configurable Workspace Directory

**Files:**
- Modify: `container/agent-runner/src/index.ts:23-32` (ContainerInput interface)
- Modify: `container/agent-runner/src/index.ts:397` (cwd in query options)
- Modify: `container/agent-runner/src/index.ts:602` (cwd in slash command)

- [ ] **Step 1: Add workspaceDir to ContainerInput**

In `container/agent-runner/src/index.ts`, add `workspaceDir` to the `ContainerInput` interface (after line 31):

```typescript
interface ContainerInput {
  prompt: string;
  sessionId?: string;
  groupFolder: string;
  chatJid: string;
  isMain: boolean;
  isScheduledTask?: boolean;
  assistantName?: string;
  script?: string;
  workspaceDir?: string;
}
```

- [ ] **Step 2: Use workspaceDir in SDK query calls**

Replace the hardcoded `cwd: '/workspace/group'` at line 397 with:

```typescript
      cwd: containerInput.workspaceDir || '/workspace/group',
```

And the same at line 602 (slash command handler):

```typescript
          cwd: containerInput.workspaceDir || '/workspace/group',
```

- [ ] **Step 3: Commit**

```bash
git add container/agent-runner/src/index.ts
git commit -m "feat(agent-runner): configurable workspaceDir in ContainerInput"
```

---

## Phase 2: AgentRunnerProcess + Parser

### Task 4: Agent-Runner Output Parser

**Files:**
- Create: `src/management/agent-runner-parser.ts`
- Create: `src/management/agent-runner-parser.test.ts`

- [ ] **Step 1: Write failing tests for the parser**

Create `src/management/agent-runner-parser.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { AgentRunnerParser } from './agent-runner-parser.js';

describe('AgentRunnerParser', () => {
  it('parses a stream event (chat.delta)', () => {
    const parser = new AgentRunnerParser('session-1', 'run-1');
    const r1 = parser.parseLine('---NANOCLAW_STREAM_EVENT---');
    expect(r1.events).toEqual([]);
    expect(r1.output).toBeUndefined();

    const r2 = parser.parseLine('{"event":"chat.delta","payload":{"content":"Hi"}}');
    expect(r2.events).toEqual([
      { event: 'chat.delta', payload: { sessionKey: 'session-1', runId: 'run-1', content: 'Hi' } },
    ]);
    expect(r2.output).toBeUndefined();
  });

  it('parses a stream event (agent.tool)', () => {
    const parser = new AgentRunnerParser('s1', 'r1');
    parser.parseLine('---NANOCLAW_STREAM_EVENT---');
    const r = parser.parseLine('{"event":"agent.tool","payload":{"tool":"Bash","input":{"cmd":"ls"},"output":null}}');
    expect(r.events).toEqual([
      { event: 'agent.tool', payload: { sessionKey: 's1', runId: 'r1', tool: 'Bash', input: { cmd: 'ls' }, output: null } },
    ]);
  });

  it('parses a ContainerOutput sandwich', () => {
    const parser = new AgentRunnerParser('s1', 'r1');
    const r1 = parser.parseLine('---NANOCLAW_OUTPUT_START---');
    expect(r1.events).toEqual([]);

    const r2 = parser.parseLine('{"status":"success","result":"Done.","newSessionId":"abc"}');
    expect(r2.output).toEqual({ status: 'success', result: 'Done.', newSessionId: 'abc' });
    // Should also emit a chat.final event
    expect(r2.events).toEqual([
      {
        event: 'chat.final',
        payload: {
          sessionKey: 's1',
          runId: 'r1',
          content: 'Done.',
          sessionId: 'abc',
          usage: { inputTokens: 0, outputTokens: 0 },
        },
      },
    ]);

    const r3 = parser.parseLine('---NANOCLAW_OUTPUT_END---');
    expect(r3.events).toEqual([]);
  });

  it('emits chat.error for error ContainerOutput', () => {
    const parser = new AgentRunnerParser('s1', 'r1');
    parser.parseLine('---NANOCLAW_OUTPUT_START---');
    const r = parser.parseLine('{"status":"error","result":null,"error":"boom"}');
    expect(r.events).toEqual([
      {
        event: 'chat.error',
        payload: { sessionKey: 's1', runId: 'r1', error: 'boom' },
      },
    ]);
  });

  it('emits no events for null-result session-update outputs', () => {
    const parser = new AgentRunnerParser('s1', 'r1');
    parser.parseLine('---NANOCLAW_OUTPUT_START---');
    const r = parser.parseLine('{"status":"success","result":null,"newSessionId":"xyz"}');
    expect(r.events).toEqual([]);
    expect(r.output).toEqual({ status: 'success', result: null, newSessionId: 'xyz' });
  });

  it('ignores unknown lines', () => {
    const parser = new AgentRunnerParser('s1', 'r1');
    const r = parser.parseLine('[agent-runner] some log message');
    expect(r.events).toEqual([]);
    expect(r.output).toBeUndefined();
  });

  it('handles malformed JSON gracefully', () => {
    const parser = new AgentRunnerParser('s1', 'r1');
    parser.parseLine('---NANOCLAW_STREAM_EVENT---');
    const r = parser.parseLine('not json');
    expect(r.events).toEqual([]);
  });

  it('resets state properly between outputs', () => {
    const parser = new AgentRunnerParser('s1', 'r1');
    // First output
    parser.parseLine('---NANOCLAW_OUTPUT_START---');
    parser.parseLine('{"status":"success","result":"one","newSessionId":"a"}');
    parser.parseLine('---NANOCLAW_OUTPUT_END---');
    // Second output
    parser.parseLine('---NANOCLAW_OUTPUT_START---');
    const r = parser.parseLine('{"status":"success","result":"two","newSessionId":"b"}');
    expect(r.output?.result).toBe('two');
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
npx vitest run src/management/agent-runner-parser.test.ts
```

Expected: FAIL — module `./agent-runner-parser.js` not found.

- [ ] **Step 3: Implement the parser**

Create `src/management/agent-runner-parser.ts`:

```typescript
// src/management/agent-runner-parser.ts

import type { StreamEvent } from './stream-parser.js';

const STREAM_EVENT_MARKER = '---NANOCLAW_STREAM_EVENT---';
const OUTPUT_START_MARKER = '---NANOCLAW_OUTPUT_START---';
const OUTPUT_END_MARKER = '---NANOCLAW_OUTPUT_END---';

export interface ContainerOutput {
  status: 'success' | 'error';
  result: string | null;
  newSessionId?: string;
  error?: string;
}

export interface ParseResult {
  events: StreamEvent[];
  output?: ContainerOutput;
}

type ParserState = 'idle' | 'awaiting_stream_json' | 'awaiting_output_json' | 'awaiting_output_end';

export class AgentRunnerParser {
  private state: ParserState = 'idle';
  private sessionKey: string;
  private runId: string;

  constructor(sessionKey: string, runId: string) {
    this.sessionKey = sessionKey;
    this.runId = runId;
  }

  parseLine(line: string): ParseResult {
    const events: StreamEvent[] = [];

    // Check for markers first
    if (line === STREAM_EVENT_MARKER) {
      this.state = 'awaiting_stream_json';
      return { events };
    }

    if (line === OUTPUT_START_MARKER) {
      this.state = 'awaiting_output_json';
      return { events };
    }

    if (line === OUTPUT_END_MARKER) {
      this.state = 'idle';
      return { events };
    }

    // Handle state-dependent parsing
    if (this.state === 'awaiting_stream_json') {
      this.state = 'idle';
      try {
        const parsed = JSON.parse(line) as { event: string; payload: Record<string, unknown> };
        // Inject sessionKey and runId into the payload
        const payload = { sessionKey: this.sessionKey, runId: this.runId, ...parsed.payload };
        events.push({ event: parsed.event, payload });
      } catch {
        // Malformed JSON — skip silently
      }
      return { events };
    }

    if (this.state === 'awaiting_output_json') {
      this.state = 'awaiting_output_end';
      try {
        const output = JSON.parse(line) as ContainerOutput;

        // Convert ContainerOutput to StreamEvents
        if (output.status === 'error' && output.error) {
          events.push({
            event: 'chat.error',
            payload: { sessionKey: this.sessionKey, runId: this.runId, error: output.error },
          });
        } else if (output.status === 'success' && output.result) {
          events.push({
            event: 'chat.final',
            payload: {
              sessionKey: this.sessionKey,
              runId: this.runId,
              content: output.result,
              ...(output.newSessionId ? { sessionId: output.newSessionId } : {}),
              usage: { inputTokens: 0, outputTokens: 0 },
            },
          });
        }
        // null-result session updates emit no events (just return the output)

        return { events, output };
      } catch {
        this.state = 'idle';
        return { events };
      }
    }

    // Unknown line in idle state — ignore
    return { events };
  }

  reset(): void {
    this.state = 'idle';
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
npx vitest run src/management/agent-runner-parser.test.ts
```

Expected: All 8 tests PASS.

- [ ] **Step 5: Export from management index**

In `src/management/index.ts`, add:

```typescript
export { AgentRunnerParser } from './agent-runner-parser.js';
export type { ContainerOutput, ParseResult } from './agent-runner-parser.js';
```

- [ ] **Step 6: Commit**

```bash
git add src/management/agent-runner-parser.ts src/management/agent-runner-parser.test.ts src/management/index.ts
git commit -m "feat: add agent-runner output parser with streaming + sandwich markers"
```

---

### Task 5: AgentRunnerProcess Class

**Files:**
- Create: `src/agent-runner-process.ts`
- Create: `src/agent-runner-process.test.ts`

- [ ] **Step 1: Write failing tests for AgentRunnerProcess**

Create `src/agent-runner-process.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EventEmitter } from 'events';
import { ChildProcess } from 'child_process';

// Mock child_process.spawn before importing the module
const mockSpawn = vi.fn();
vi.mock('child_process', () => ({
  spawn: (...args: unknown[]) => mockSpawn(...args),
}));

// Mock fs for loadDotEnv
vi.mock('fs', async () => {
  const actual = await vi.importActual<typeof import('fs')>('fs');
  return {
    ...actual,
    readFileSync: vi.fn(() => 'ANTHROPIC_API_KEY=test-key\n'),
    existsSync: vi.fn(() => true),
  };
});

// Import after mocks are set up
const { AgentRunnerProcess } = await import('./agent-runner-process.js');

function createMockProcess(): ChildProcess {
  const proc = new EventEmitter() as ChildProcess;
  proc.stdin = new EventEmitter() as any;
  (proc.stdin as any).write = vi.fn();
  (proc.stdin as any).end = vi.fn();
  proc.stdout = new EventEmitter() as any;
  proc.stderr = new EventEmitter() as any;
  proc.pid = 12345;
  proc.kill = vi.fn();
  return proc;
}

describe('AgentRunnerProcess', () => {
  let runner: InstanceType<typeof AgentRunnerProcess>;
  let mockProc: ChildProcess;

  beforeEach(() => {
    vi.clearAllMocks();
    mockProc = createMockProcess();
    mockSpawn.mockReturnValue(mockProc);
    runner = new AgentRunnerProcess({ maxConcurrent: 2 });
  });

  it('spawns a node process with correct args', async () => {
    await runner.spawn({
      sessionKey: 'test-session',
      model: 'claude-sonnet-4-20250514',
      systemPrompt: 'Be helpful',
      initialPrompt: 'Hello',
    });

    expect(mockSpawn).toHaveBeenCalledWith(
      'node',
      expect.arrayContaining([expect.stringContaining('agent-runner')]),
      expect.objectContaining({
        stdio: ['pipe', 'pipe', 'pipe'],
        env: expect.objectContaining({ IPC_MODE: 'stdin' }),
      }),
    );
  });

  it('writes ContainerInput JSON as first stdin line', async () => {
    await runner.spawn({
      sessionKey: 'test-session',
      model: 'claude-sonnet-4-20250514',
      systemPrompt: 'Be helpful',
      initialPrompt: 'Hello',
    });

    const writeCall = (mockProc.stdin as any).write.mock.calls[0][0] as string;
    expect(writeCall).toMatch(/\n$/);
    const input = JSON.parse(writeCall.slice(0, -1));
    expect(input.prompt).toBe('Hello');
    expect(input.chatJid).toBe('test-session');
  });

  it('rejects when max concurrent reached', async () => {
    mockSpawn.mockReturnValue(createMockProcess());
    await runner.spawn({ sessionKey: 's1', model: 'm', systemPrompt: '' });
    mockSpawn.mockReturnValue(createMockProcess());
    await runner.spawn({ sessionKey: 's2', model: 'm', systemPrompt: '' });

    await expect(
      runner.spawn({ sessionKey: 's3', model: 'm', systemPrompt: '' }),
    ).rejects.toThrow('Max concurrent');
  });

  it('rejects duplicate session keys', async () => {
    await runner.spawn({ sessionKey: 's1', model: 'm', systemPrompt: '' });
    await expect(
      runner.spawn({ sessionKey: 's1', model: 'm', systemPrompt: '' }),
    ).rejects.toThrow('already exists');
  });

  it('sendMessage writes JSON line to stdin', async () => {
    await runner.spawn({ sessionKey: 's1', model: 'm', systemPrompt: '' });
    await runner.sendMessage('s1', 'follow up');

    const calls = (mockProc.stdin as any).write.mock.calls;
    const lastCall = calls[calls.length - 1][0] as string;
    const msg = JSON.parse(lastCall.slice(0, -1));
    expect(msg).toEqual({ type: 'message', text: 'follow up' });
  });

  it('kill writes close signal and sends SIGTERM', async () => {
    vi.useFakeTimers();
    await runner.spawn({ sessionKey: 's1', model: 'm', systemPrompt: '' });
    await runner.kill('s1');

    const calls = (mockProc.stdin as any).write.mock.calls;
    const lastCall = calls[calls.length - 1][0] as string;
    expect(JSON.parse(lastCall.slice(0, -1))).toEqual({ type: 'close' });

    vi.advanceTimersByTime(6000);
    expect(mockProc.kill).toHaveBeenCalledWith('SIGTERM');
    vi.useRealTimers();
  });

  it('emits output events from stream event markers', async () => {
    const outputSpy = vi.fn();
    runner.on('output', outputSpy);

    await runner.spawn({ sessionKey: 's1', model: 'm', systemPrompt: '' });

    // Simulate stdout data with a stream event
    mockProc.stdout!.emit('data', Buffer.from(
      '---NANOCLAW_STREAM_EVENT---\n{"event":"chat.delta","payload":{"content":"Hi"}}\n',
    ));

    // The runner should emit the raw data on 'output'
    expect(outputSpy).toHaveBeenCalledWith('s1', expect.any(String));
  });

  it('cleans up session on exit', async () => {
    await runner.spawn({ sessionKey: 's1', model: 'm', systemPrompt: '' });
    expect(runner.activeCount).toBe(1);

    mockProc.emit('exit', 0);
    expect(runner.activeCount).toBe(0);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
npx vitest run src/agent-runner-process.test.ts
```

Expected: FAIL — module `./agent-runner-process.js` not found.

- [ ] **Step 3: Implement AgentRunnerProcess**

Create `src/agent-runner-process.ts`:

```typescript
import { spawn, ChildProcess } from 'child_process';
import { EventEmitter } from 'events';
import { readFileSync, existsSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import type {
  AgentRunner,
  SpawnOptions as ISpawnOptions,
  AgentSession as IAgentSession,
} from './management/agent-runner.js';

export interface SpawnOptions extends ISpawnOptions {
  cwd?: string;
  groupFolder?: string;
  isMain?: boolean;
  assistantName?: string;
  onOutput?: (data: string) => void;
  onError?: (data: string) => void;
  onExit?: (code: number | null) => void;
}

export interface AgentSession extends IAgentSession {
  pid: number;
  process: ChildProcess;
}

interface ContainerInput {
  prompt: string;
  sessionId?: string;
  groupFolder: string;
  chatJid: string;
  isMain: boolean;
  assistantName?: string;
  workspaceDir?: string;
}

const DOTENV_PATH = '/home/node/.nanoclaw/.env';

/**
 * Load key=value pairs from a .env file.
 * Reused from child-process-runner.ts — same logic.
 */
function loadDotEnv(envPath: string): Record<string, string> {
  const env: Record<string, string> = {};
  if (!existsSync(envPath)) return env;
  try {
    const content = readFileSync(envPath, 'utf-8');
    for (const line of content.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const eqIdx = trimmed.indexOf('=');
      if (eqIdx < 1) continue;
      const key = trimmed.slice(0, eqIdx).trim();
      let val = trimmed.slice(eqIdx + 1).trim();
      if (
        (val.startsWith('"') && val.endsWith('"')) ||
        (val.startsWith("'") && val.endsWith("'"))
      ) {
        val = val.slice(1, -1);
      }
      env[key] = val;
    }
  } catch {
    // non-fatal
  }
  return env;
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const AGENT_RUNNER_PATH = path.resolve(__dirname, '../agent-runner/dist/index.js');

export class AgentRunnerProcess extends EventEmitter implements AgentRunner {
  private sessions = new Map<string, AgentSession>();
  private maxConcurrent: number;

  constructor(config: { maxConcurrent: number }) {
    super();
    this.maxConcurrent = config.maxConcurrent;
  }

  async spawn(opts: SpawnOptions): Promise<AgentSession> {
    if (this.sessions.size >= this.maxConcurrent) {
      throw new Error(`Max concurrent agents reached (${this.maxConcurrent})`);
    }
    if (this.sessions.has(opts.sessionKey)) {
      throw new Error(`Session ${opts.sessionKey} already exists`);
    }

    const dotEnv = loadDotEnv(DOTENV_PATH);
    const childEnv: Record<string, string | undefined> = {
      ...process.env,
      ...dotEnv,
      IPC_MODE: 'stdin',
    };

    // Credential pre-flight
    const hasCredentials =
      childEnv.ANTHROPIC_API_KEY ||
      childEnv.ANTHROPIC_BASE_URL ||
      childEnv.CLAUDE_CODE_OAUTH_TOKEN ||
      childEnv.ANTHROPIC_AUTH_TOKEN;

    if (!hasCredentials) {
      throw new Error(
        'No Anthropic credentials configured. Call ApplyConfig with your ' +
          'ANTHROPIC_API_KEY or CLAUDE_CODE_OAUTH_TOKEN before sending messages.',
      );
    }

    // Auto-migrate setup tokens
    if (
      childEnv.ANTHROPIC_API_KEY &&
      childEnv.ANTHROPIC_API_KEY.startsWith('sk-ant-oat') &&
      !childEnv.CLAUDE_CODE_OAUTH_TOKEN
    ) {
      childEnv.CLAUDE_CODE_OAUTH_TOKEN = childEnv.ANTHROPIC_API_KEY;
      delete childEnv.ANTHROPIC_API_KEY;
    }

    const proc = spawn('node', [AGENT_RUNNER_PATH], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: childEnv,
      ...(opts.cwd ? { cwd: opts.cwd } : {}),
    });

    // Build and write ContainerInput as first stdin line
    const containerInput: ContainerInput = {
      prompt: opts.initialPrompt || '',
      sessionId: opts.resumeSessionId,
      groupFolder: opts.groupFolder || opts.sessionKey,
      chatJid: opts.sessionKey,
      isMain: opts.isMain || false,
      assistantName: opts.assistantName,
      workspaceDir: opts.cwd,
    };
    proc.stdin?.write(JSON.stringify(containerInput) + '\n');

    const session: AgentSession = {
      sessionKey: opts.sessionKey,
      pid: proc.pid!,
      process: proc,
      startedAt: new Date(),
    };

    proc.stdout?.on('data', (data: Buffer) => {
      const str = data.toString();
      opts.onOutput?.(str);
      this.emit('output', opts.sessionKey, str);
    });

    proc.stderr?.on('data', (data: Buffer) => {
      const str = data.toString();
      opts.onError?.(str);
      this.emit('stderr', opts.sessionKey, str);
    });

    proc.on('exit', (code) => {
      this.sessions.delete(opts.sessionKey);
      opts.onExit?.(code);
      this.emit('exit', opts.sessionKey, code);
    });

    this.sessions.set(opts.sessionKey, session);
    return session;
  }

  async sendMessage(sessionKey: string, message: string): Promise<void> {
    const session = this.sessions.get(sessionKey);
    if (!session) throw new Error(`Session ${sessionKey} not found`);
    session.process.stdin?.write(
      JSON.stringify({ type: 'message', text: message }) + '\n',
    );
  }

  async kill(sessionKey: string): Promise<void> {
    const session = this.sessions.get(sessionKey);
    if (!session) return;
    // Send graceful close signal
    session.process.stdin?.write(JSON.stringify({ type: 'close' }) + '\n');
    // SIGTERM fallback after 5 seconds
    const proc = session.process;
    setTimeout(() => {
      try { proc.kill('SIGTERM'); } catch { /* already dead */ }
    }, 5000);
    this.sessions.delete(sessionKey);
  }

  async killAll(): Promise<void> {
    for (const [key] of this.sessions) {
      await this.kill(key);
    }
  }

  get activeCount(): number {
    return this.sessions.size;
  }

  getSession(sessionKey: string): AgentSession | undefined {
    return this.sessions.get(sessionKey);
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
npx vitest run src/agent-runner-process.test.ts
```

Expected: All tests PASS.

- [ ] **Step 5: Commit**

```bash
git add src/agent-runner-process.ts src/agent-runner-process.test.ts
git commit -m "feat: add AgentRunnerProcess implementing AgentRunner with SDK subprocess"
```

---

## Phase 3: Dockerfile.ws Changes

### Task 6: Bundle Agent-Runner in WS Image

**Files:**
- Modify: `container/Dockerfile.ws`

- [ ] **Step 1: Update Dockerfile.ws to bundle agent-runner**

Replace the contents of `container/Dockerfile.ws` with:

```dockerfile
# container/Dockerfile.ws
# NanoClaw K8s / WebSocket Management Mode
# Runs agent-runner (SDK) or Claude CLI as child processes behind a WebSocket management API

FROM node:22-slim

# Install system dependencies for Chromium
RUN apt-get update && apt-get install -y \
    chromium \
    fonts-liberation \
    fonts-noto-cjk \
    fonts-noto-color-emoji \
    libgbm1 \
    libnss3 \
    libatk-bridge2.0-0 \
    libgtk-3-0 \
    libx11-xcb1 \
    libxcomposite1 \
    libxdamage1 \
    libxrandr2 \
    libasound2 \
    libpangocairo-1.0-0 \
    libcups2 \
    libdrm2 \
    libxshmfence1 \
    curl \
    git \
    && rm -rf /var/lib/apt/lists/*

# Set Chromium path for agent-browser
ENV AGENT_BROWSER_EXECUTABLE_PATH=/usr/bin/chromium
ENV PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH=/usr/bin/chromium

# Install claude-code globally (still needed for AGENT_MODE=cli fallback)
RUN npm install -g @anthropic-ai/claude-code

# Agent-runner: install deps + pre-compile TypeScript
WORKDIR /ws/agent-runner
COPY container/agent-runner/package*.json ./
RUN npm ci --omit=dev
COPY container/agent-runner/src/ ./src/
COPY container/agent-runner/tsconfig.json ./
RUN npx tsc --outDir dist && rm -rf src tsconfig.json

# Skills (referenced by agent-runner MCP servers)
COPY container/skills/ /ws/skills/

# Management server + channel runtime
WORKDIR /ws
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts
COPY dist/ ./dist/

# Config directory for .env
RUN mkdir -p /home/node/.nanoclaw && chown node:node /home/node/.nanoclaw

# Expose management API port
EXPOSE 18789

# Non-root user — WORKDIR must be .nanoclaw so readEnvFile() finds .env
USER node
WORKDIR /home/node/.nanoclaw

CMD ["node", "/ws/dist/k8s-entrypoint.js"]
```

- [ ] **Step 2: Verify build locally (if Docker available)**

```bash
cd container && docker build -f Dockerfile.ws -t nanoclaw-ws:test ..
```

Expected: Build completes without errors. The agent-runner compiles at build time, and `/ws/agent-runner/dist/index.js` exists in the image.

- [ ] **Step 3: Commit**

```bash
git add container/Dockerfile.ws
git commit -m "feat(docker): bundle agent-runner + skills in Dockerfile.ws with pre-compiled TypeScript"
```

---

## Phase 4: K8s Entrypoint Integration

### Task 7: Runner Selection and Output Parsing

**Files:**
- Modify: `src/k8s-entrypoint.ts:1-10` (imports)
- Modify: `src/k8s-entrypoint.ts:56` (runner creation)
- Modify: `src/k8s-entrypoint.ts:106-135` (output handling)
- Modify: `src/k8s-entrypoint.ts:240-247` (spawn options)

- [ ] **Step 1: Add imports for AgentRunnerProcess and parser**

In `src/k8s-entrypoint.ts`, add after the existing imports (line 19):

```typescript
import { AgentRunnerProcess } from './agent-runner-process.js';
import { AgentRunnerParser } from './management/agent-runner-parser.js';
```

- [ ] **Step 2: Add AGENT_MODE constant and conditional runner creation**

After the `MAX_CONCURRENT` constant (line 30), add:

```typescript
const AGENT_MODE = process.env.AGENT_MODE || 'cli';
```

Replace the runner creation (line 56):

```typescript
const runner = new ChildProcessRunner({ maxConcurrent: MAX_CONCURRENT });
```

with:

```typescript
const runner = AGENT_MODE === 'sdk'
  ? new AgentRunnerProcess({ maxConcurrent: MAX_CONCURRENT })
  : new ChildProcessRunner({ maxConcurrent: MAX_CONCURRENT });
console.log(`Agent mode: ${AGENT_MODE}`);
```

- [ ] **Step 3: Add SDK-mode output parsing**

The `runner.on('output')` handler (lines 122-135) needs to work with both parsers. The agent-runner parser is stateful (per-session), so we need per-session parser instances.

After `const finalResponses = new Map<string, string>();` (line 107), add:

```typescript
  // Per-session agent-runner parsers (SDK mode only)
  const agentRunnerParsers = new Map<string, AgentRunnerParser>();
```

Replace the `runner.on('output', ...)` handler (lines 122-135) with:

```typescript
  runner.on('output', (sessionKey: string, data: string) => {
    const runId = sessionRunIds.get(sessionKey) || '';
    const prev = lineBuffers.get(sessionKey) || '';
    const combined = prev + data;
    const lines = combined.split('\n');
    lineBuffers.set(sessionKey, lines.pop()!);

    if (AGENT_MODE === 'sdk') {
      // Agent-runner marker-based protocol
      let parser = agentRunnerParsers.get(sessionKey);
      if (!parser) {
        parser = new AgentRunnerParser(sessionKey, runId);
        agentRunnerParsers.set(sessionKey, parser);
      }
      for (const line of lines.filter(Boolean)) {
        const result = parser.parseLine(line);
        for (const ev of result.events) {
          server.pushEvent(ev.event, ev.payload);
          if (ev.event === 'chat.final' && ev.payload.content) {
            finalResponses.set(sessionKey, ev.payload.content as string);
          }
        }
        // Track newSessionId from ContainerOutput
        if (result.output?.newSessionId) {
          sessionRunIds.set(sessionKey, runId); // keep runId stable
        }
      }
    } else {
      // Claude CLI stream-json protocol
      for (const line of lines.filter(Boolean)) {
        processStreamEvents(
          parseStreamJsonLine(line, sessionKey, runId),
          sessionKey,
        );
      }
    }
  });
```

- [ ] **Step 4: Clean up agent-runner parser on exit**

In the `runner.on('exit', ...)` handler, after `resetStreamState(sessionKey);` (line 142), add:

```typescript
    agentRunnerParsers.delete(sessionKey);
```

Also update the remaining buffer flush in the exit handler to use the correct parser:

Replace lines 143-148:
```typescript
    if (remaining.trim()) {
      const runId = sessionRunIds.get(sessionKey) || '';
      processStreamEvents(
        parseStreamJsonLine(remaining, sessionKey, runId),
        sessionKey,
      );
    }
```

with:

```typescript
    if (remaining.trim()) {
      const runId = sessionRunIds.get(sessionKey) || '';
      if (AGENT_MODE === 'sdk') {
        const parser = agentRunnerParsers.get(sessionKey) || new AgentRunnerParser(sessionKey, runId);
        const result = parser.parseLine(remaining);
        for (const ev of result.events) {
          server.pushEvent(ev.event, ev.payload);
          if (ev.event === 'chat.final' && ev.payload.content) {
            finalResponses.set(sessionKey, ev.payload.content as string);
          }
        }
      } else {
        processStreamEvents(
          parseStreamJsonLine(remaining, sessionKey, runId),
          sessionKey,
        );
      }
    }
```

- [ ] **Step 5: Pass extra spawn options in SDK mode**

In the `onMessage` handler (around line 240), update the `runner.spawn()` call to pass additional fields needed by `AgentRunnerProcess`:

Replace lines 240-247:

```typescript
      runner
        .spawn({
          sessionKey,
          model: process.env.MODEL_PRIMARY || 'claude-sonnet-4-20250514',
          systemPrompt: effectivePrompt,
          initialPrompt: msg.content,
          cwd: workspaceDir,
        })
```

with:

```typescript
      runner
        .spawn({
          sessionKey,
          model: process.env.MODEL_PRIMARY || 'claude-sonnet-4-20250514',
          systemPrompt: effectivePrompt,
          initialPrompt: msg.content,
          cwd: workspaceDir,
          // Extra fields for AgentRunnerProcess (ignored by ChildProcessRunner)
          ...(AGENT_MODE === 'sdk' ? {
            groupFolder: group.folder,
            isMain: group.isMain || false,
            assistantName: group.assistantName,
          } : {}),
        } as any)
```

- [ ] **Step 6: Run typecheck**

```bash
npx tsc --noEmit
```

Expected: No type errors.

- [ ] **Step 7: Run all tests**

```bash
npx vitest run
```

Expected: All tests pass.

- [ ] **Step 8: Commit**

```bash
git add src/k8s-entrypoint.ts
git commit -m "feat(k8s): add AGENT_MODE=sdk runner selection with agent-runner parser integration"
```

---

## Phase 5: Verification

### Task 8: End-to-End Verification

- [ ] **Step 1: Run full test suite**

```bash
npx vitest run
```

Expected: All tests pass.

- [ ] **Step 2: Run typecheck**

```bash
npx tsc --noEmit
```

Expected: No errors.

- [ ] **Step 3: Run lint**

```bash
npx eslint src/
```

Expected: No errors (warnings acceptable).

- [ ] **Step 4: Build the project**

```bash
npm run build
```

Expected: Compiles successfully to `dist/`.

- [ ] **Step 5: Verify Dockerfile.ws builds (if Docker available)**

```bash
cd container && docker build -f Dockerfile.ws -t nanoclaw-ws:test ..
```

Expected: Image builds with agent-runner pre-compiled at `/ws/agent-runner/dist/`.

- [ ] **Step 6: Commit any remaining fixes**

If any verification steps revealed issues, fix and commit.
