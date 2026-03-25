# Skill Branch Restructure: management-ws + k8s

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Extract the current `feature/paas-mode` work into two composable skill branches — `skill/management-ws` (WebSocket management API with runner abstraction) and `skill/k8s` (child-process runner + Dockerfile.ws for containerized orchestrators).

**Architecture:** Introduce an `AgentRunner` interface that both the existing `container-runner.ts` and the new `child-process-runner.ts` can implement. The management WS server codes against this interface. `skill/management-ws` ships the interface, WS server, protocol, and auth. `skill/k8s` ships the child-process runner implementation, `Dockerfile.ws`, and the k8s entrypoint that wires everything together. Each skill branch merges cleanly into main with minimal core file changes.

**Tech Stack:** TypeScript, WebSocket (`ws`), Node.js child_process, vitest

---

## File Structure

### skill/management-ws branch (additive to main)

| File | Responsibility |
|------|---------------|
| `src/management/agent-runner.ts` | **NEW** — `AgentRunner` interface (no EventEmitter dependency) |
| `src/management/stream-parser.ts` | **NEW** — Parse Claude stream-json output into management events |
| `src/management/stream-parser.test.ts` | **NEW** — Stream parser tests |
| `src/management/protocol.ts` | **NEW** — WebSocket frame types, method/event constants, payload types |
| `src/management/protocol.test.ts` | **NEW** — Protocol type validation tests |
| `src/management/auth.ts` | **NEW** — Timing-safe token validation |
| `src/management/server.ts` | **NEW** — WebSocket server with auth gate, HTTP health endpoints |
| `src/management/server.test.ts` | **NEW** — Server auth, framing, event push tests |
| `src/management/handlers.ts` | **NEW** — Request handlers coded against `AgentRunner` interface |
| `src/management/handlers.test.ts` | **NEW** — Handler unit tests with mock runner |
| `src/management/index.ts` | **NEW** — Barrel export |
| `package.json` | **MODIFY** — Add `ws` + `@types/ws` dependencies |
| `.env.example` | **MODIFY** — Add `MANAGEMENT_TOKEN`, `MANAGEMENT_PORT` |

### skill/k8s branch (depends on skill/management-ws)

| File | Responsibility |
|------|---------------|
| `src/child-process-runner.ts` | **NEW** — `ChildProcessRunner` implementing `AgentRunner` |
| `src/child-process-runner.test.ts` | **NEW** — Spawn, credentials, concurrency tests |
| `src/k8s-entrypoint.ts` | **NEW** — K8s entrypoint wiring child-process runner to management server |
| `container/Dockerfile.ws` | **NEW** — K8s-specific Dockerfile (separate from main Dockerfile) |
| `container/build-ws.sh` | **NEW** — Build script for Dockerfile.ws |
| `package.json` | **MODIFY** — Add `start:ws` script |
| `.env.example` | **MODIFY** — Add `MAX_CONCURRENT_AGENTS`, `MODEL_PRIMARY`, `SYSTEM_PROMPT` |
| `.claude/skills/add-k8s/SKILL.md` | **NEW** — Skill instructions (on main branch) |

### Files on main (always present)

| File | Responsibility |
|------|---------------|
| `.claude/skills/add-management-ws/SKILL.md` | **NEW** — Skill instructions for management-ws |

---

## Task 1: Create the AgentRunner interface

**Files:**
- Create: `src/management/agent-runner.ts`

This is the key abstraction that decouples the management server from any specific runner implementation. It uses callback-style event subscription rather than extending EventEmitter to avoid TypeScript conflicts with typed on/emit overloads on EventEmitter subclasses.

- [ ] **Step 1: Write the interface file**

```typescript
// src/management/agent-runner.ts

export interface SpawnOptions {
  sessionKey: string;
  model: string;
  systemPrompt: string;
  initialPrompt?: string;
  resumeSessionId?: string;
}

export interface AgentSession {
  sessionKey: string;
  startedAt: Date;
}

export type RunnerEventMap = {
  output: (sessionKey: string, data: string) => void;
  stderr: (sessionKey: string, data: string) => void;
  exit: (sessionKey: string, code: number | null) => void;
};

export interface AgentRunner {
  spawn(opts: SpawnOptions): Promise<AgentSession>;
  sendMessage(sessionKey: string, message: string): Promise<void>;
  kill(sessionKey: string): Promise<void>;
  killAll(): Promise<void>;
  get activeCount(): number;
  getSession(sessionKey: string): AgentSession | undefined;

  on<K extends keyof RunnerEventMap>(event: K, listener: RunnerEventMap[K]): void;
}
```

- [ ] **Step 2: Verify it compiles**

Run: `npx tsc --noEmit`
Expected: No errors

- [ ] **Step 3: Commit**

```bash
git add src/management/agent-runner.ts
git commit -m "feat: add AgentRunner interface for runner abstraction"
```

---

## Task 2: Refactor handlers and server atomically

**Files:**
- Modify: `src/management/handlers.ts`
- Create: `src/management/handlers.test.ts`
- Modify: `src/management/server.ts`
- Modify: `src/management/server.test.ts`

The current handlers import `ChildProcessRunner` directly and the server imports handlers at module level. Both must be changed together — refactoring handlers alone would break the server's import.

- [ ] **Step 1: Write the handler tests with a mock runner**

```typescript
// src/management/handlers.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EventEmitter } from 'events';
import type { AgentRunner } from './agent-runner.js';
import { createHandlers } from './handlers.js';

function createMockRunner(): AgentRunner {
  const emitter = new EventEmitter();
  return Object.assign(emitter, {
    spawn: vi.fn(async (opts: { sessionKey: string }) => ({
      sessionKey: opts.sessionKey,
      startedAt: new Date(),
    })),
    sendMessage: vi.fn(async () => {}),
    kill: vi.fn(async () => {}),
    killAll: vi.fn(async () => {}),
    get activeCount() { return 0; },
    getSession: vi.fn(() => undefined),
    on: emitter.on.bind(emitter),
  }) as unknown as AgentRunner;
}

describe('Management Handlers', () => {
  let runner: AgentRunner;
  let handlers: Record<string, (params: any) => Promise<any>>;

  beforeEach(() => {
    runner = createMockRunner();
    handlers = createHandlers(runner);
  });

  it('health returns status and uptime', async () => {
    const result = await handlers.health({});
    expect(result.status).toBe('ok');
    expect(typeof result.uptime).toBe('number');
  });

  it('chat.send spawns agent and returns runId', async () => {
    const result = await handlers['chat.send']({
      sessionKey: 'test-session',
      message: 'hello',
    });
    expect(result.runId).toBeDefined();
    expect(result.sessionKey).toBe('test-session');
    expect(runner.spawn).toHaveBeenCalled();
  });

  it('chat.send kills existing session before spawning', async () => {
    (runner.getSession as ReturnType<typeof vi.fn>).mockReturnValueOnce({
      sessionKey: 'test-session',
      startedAt: new Date(),
    });
    await handlers['chat.send']({
      sessionKey: 'test-session',
      message: 'hello',
    });
    expect(runner.kill).toHaveBeenCalledWith('test-session');
  });

  it('chat.abort kills session', async () => {
    const result = await handlers['chat.abort']({
      sessionKey: 'test-session',
    });
    expect(result.aborted).toBe(true);
    expect(runner.kill).toHaveBeenCalledWith('test-session');
  });

  it('sessions.list returns empty array', async () => {
    const result = await handlers['sessions.list']({});
    expect(result).toEqual([]);
  });

  it('chat.history returns empty array', async () => {
    const result = await handlers['chat.history']({
      sessionKey: 'test-session',
    });
    expect(result).toEqual([]);
  });
});
```

- [ ] **Step 2: Rewrite handlers.ts against the interface**

```typescript
// src/management/handlers.ts
import type { AgentRunner } from './agent-runner.js';

// Maps sessionKey → the runId of its most recent chat.send.
// Exported so the entrypoint can tag streamed output events with the correct runId.
export const sessionRunIds = new Map<string, string>();

const startTime = Date.now();

export function createHandlers(
  runner: AgentRunner,
  pushEvent?: (event: string, payload: Record<string, unknown>) => void,
): Record<string, (params: any) => Promise<any>> {
  return {
    health: async () => ({
      status: 'ok' as const,
      uptime: Math.floor((Date.now() - startTime) / 1000),
      activeAgents: runner.activeCount,
    }),

    'chat.send': async (params: {
      sessionKey: string;
      message: string;
      resumeSessionId?: string;
    }) => {
      const runId = crypto.randomUUID();
      sessionRunIds.set(params.sessionKey, runId);

      if (runner.getSession(params.sessionKey)) {
        await runner.kill(params.sessionKey);
      }

      try {
        await runner.spawn({
          sessionKey: params.sessionKey,
          model: process.env.MODEL_PRIMARY || 'claude-sonnet-4-20250514',
          systemPrompt: process.env.SYSTEM_PROMPT || '',
          initialPrompt: params.message,
          resumeSessionId: params.resumeSessionId,
        });
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        console.error(
          `[chat.send:${params.sessionKey}] Spawn failed: ${message}`,
        );
        pushEvent?.('chat.error', {
          sessionKey: params.sessionKey,
          runId,
          error: message,
        });
      }

      return { runId, sessionKey: params.sessionKey };
    },

    'chat.abort': async (params: { sessionKey: string }) => {
      sessionRunIds.delete(params.sessionKey);
      await runner.kill(params.sessionKey);
      return { aborted: true };
    },

    'sessions.list': async () => [],

    'chat.history': async () => [],
  };
}
```

- [ ] **Step 3: Update ManagementServer to accept handlers via constructor**

```typescript
// src/management/server.ts
import { WebSocketServer, WebSocket } from 'ws';
import http from 'http';
import { validateToken } from './auth.js';
import type { Frame, RequestFrame } from './protocol.js';

export class ManagementServer {
  private wss: WebSocketServer | null = null;
  private httpServer: http.Server | null = null;
  private port: number;
  private handlers: Record<string, (params: any) => Promise<any>>;
  private authenticatedClients = new Set<WebSocket>();

  constructor(config: {
    port: number;
    handlers: Record<string, (params: any) => Promise<any>>;
  }) {
    this.port = config.port;
    this.handlers = config.handlers;
  }

  async start(): Promise<void> {
    return new Promise((resolve) => {
      this.httpServer = http.createServer((req, res) => {
        if (req.url === '/health' || req.url === '/healthz') {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ status: 'ok' }));
          return;
        }
        if (req.url === '/readyz') {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ready: true }));
          return;
        }
        res.writeHead(404);
        res.end();
      });

      this.wss = new WebSocketServer({ server: this.httpServer });

      this.wss.on('connection', (ws) => {
        let authenticated = false;
        const authTimeout = setTimeout(() => {
          if (!authenticated) ws.close(4001, 'auth timeout');
        }, 5000);

        ws.on('message', async (data) => {
          let frame: Frame;
          try {
            frame = JSON.parse(data.toString());
          } catch {
            ws.close(4000, 'invalid frame');
            return;
          }

          if (!authenticated) {
            if (frame.type === 'auth' && 'token' in frame) {
              if (validateToken((frame as { token: string }).token)) {
                authenticated = true;
                this.authenticatedClients.add(ws);
                clearTimeout(authTimeout);
                ws.send(JSON.stringify({ type: 'auth', ok: true }));
              } else {
                ws.close(4001, 'unauthorized');
              }
            } else {
              ws.close(4001, 'auth required');
            }
            return;
          }

          if (frame.type === 'req') {
            const req = frame as RequestFrame;
            const handler = this.handlers[req.method];
            if (!handler) {
              ws.send(
                JSON.stringify({
                  type: 'res',
                  id: req.id,
                  ok: false,
                  error: `unknown method: ${req.method}`,
                }),
              );
              return;
            }
            try {
              const result = await handler(req.params);
              ws.send(
                JSON.stringify({ type: 'res', id: req.id, ok: true, result }),
              );
            } catch (err: unknown) {
              const message =
                err instanceof Error ? err.message : 'internal error';
              ws.send(
                JSON.stringify({
                  type: 'res',
                  id: req.id,
                  ok: false,
                  error: message,
                }),
              );
            }
          }
        });

        ws.on('close', () => {
          clearTimeout(authTimeout);
          this.authenticatedClients.delete(ws);
        });
      });

      this.httpServer.listen(this.port, () => resolve());
    });
  }

  pushEvent(event: string, payload: Record<string, unknown>): void {
    const frame = JSON.stringify({ type: 'event', event, payload });
    for (const ws of this.authenticatedClients) {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(frame);
      }
    }
  }

  async stop(): Promise<void> {
    for (const ws of this.authenticatedClients) ws.close(1000);
    this.authenticatedClients.clear();
    return new Promise((resolve) => {
      this.wss?.close(() => {
        this.httpServer?.close(() => resolve());
      });
    });
  }
}
```

- [ ] **Step 4: Update server.test.ts to pass handlers via constructor**

```typescript
// src/management/server.test.ts
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import WebSocket from 'ws';
import { EventEmitter } from 'events';
import { ManagementServer } from './server.js';
import { createHandlers } from './handlers.js';
import type { AgentRunner } from './agent-runner.js';

describe('ManagementServer', () => {
  let server: ManagementServer;
  const PORT = 18799;

  beforeAll(async () => {
    process.env.MANAGEMENT_TOKEN = 'test-token';

    const mockRunner = Object.assign(new EventEmitter(), {
      spawn: async (opts: { sessionKey: string }) => ({
        sessionKey: opts.sessionKey,
        startedAt: new Date(),
      }),
      sendMessage: async () => {},
      kill: async () => {},
      killAll: async () => {},
      get activeCount() { return 0; },
      getSession: () => undefined,
      on: EventEmitter.prototype.on,
    }) as unknown as AgentRunner;

    const handlers = createHandlers(mockRunner);
    server = new ManagementServer({ port: PORT, handlers });
    await server.start();
  });

  afterAll(async () => {
    await server.stop();
  });

  // ... all existing tests remain unchanged (they test server behavior, not handler logic)
```

- [ ] **Step 5: Run all management tests**

Run: `npx vitest run src/management/`
Expected: All PASS

- [ ] **Step 6: Commit**

```bash
git add src/management/handlers.ts src/management/handlers.test.ts src/management/server.ts src/management/server.test.ts
git commit -m "refactor: handlers and server use AgentRunner interface, handlers injected via constructor"
```

---

## Task 3: Create the stream parser (extracted from entrypoint)

**Files:**
- Create: `src/management/stream-parser.ts`
- Create: `src/management/stream-parser.test.ts`

The complex logic of parsing Claude's stream-json output lives in its own module so it can be tested without triggering an entrypoint's `main()`.

- [ ] **Step 1: Write the stream parser tests**

```typescript
// src/management/stream-parser.test.ts
import { describe, it, expect } from 'vitest';
import { parseStreamJsonLine } from './stream-parser.js';

describe('parseStreamJsonLine', () => {
  it('parses assistant text block as chat.delta', () => {
    const line = JSON.stringify({
      type: 'assistant',
      message: {
        content: [{ type: 'text', text: 'Hello world' }],
      },
    });
    const events = parseStreamJsonLine(line, 'session-1', 'run-1');
    expect(events).toEqual([
      {
        event: 'chat.delta',
        payload: { sessionKey: 'session-1', runId: 'run-1', content: 'Hello world' },
      },
    ]);
  });

  it('parses tool_use block as agent.tool', () => {
    const line = JSON.stringify({
      type: 'assistant',
      message: {
        content: [{ type: 'tool_use', name: 'Read', input: { path: '/foo' } }],
      },
    });
    const events = parseStreamJsonLine(line, 's1', 'r1');
    expect(events).toEqual([
      {
        event: 'agent.tool',
        payload: {
          sessionKey: 's1',
          runId: 'r1',
          tool: 'Read',
          input: { path: '/foo' },
          output: null,
        },
      },
    ]);
  });

  it('parses result as chat.final with session ID', () => {
    const line = JSON.stringify({
      type: 'result',
      result: 'Done!',
      session_id: 'sess-abc',
      usage: { input_tokens: 100, output_tokens: 50 },
    });
    const events = parseStreamJsonLine(line, 's1', 'r1');
    expect(events).toEqual([
      {
        event: 'chat.final',
        payload: {
          sessionKey: 's1',
          runId: 'r1',
          content: 'Done!',
          sessionId: 'sess-abc',
          usage: { inputTokens: 100, outputTokens: 50 },
        },
      },
    ]);
  });

  it('parses result without session ID', () => {
    const line = JSON.stringify({
      type: 'result',
      result: 'Done!',
      usage: { input_tokens: 10, output_tokens: 5 },
    });
    const events = parseStreamJsonLine(line, 's1', 'r1');
    expect(events[0].payload).not.toHaveProperty('sessionId');
  });

  it('returns empty array for non-JSON input', () => {
    expect(parseStreamJsonLine('not json', 's1', 'r1')).toEqual([]);
  });

  it('returns empty array for system type', () => {
    const line = JSON.stringify({ type: 'system', session_id: 'x' });
    expect(parseStreamJsonLine(line, 's1', 'r1')).toEqual([]);
  });

  it('handles multiple content blocks in one assistant message', () => {
    const line = JSON.stringify({
      type: 'assistant',
      message: {
        content: [
          { type: 'text', text: 'thinking...' },
          { type: 'tool_use', name: 'Bash', input: { command: 'ls' } },
        ],
      },
    });
    const events = parseStreamJsonLine(line, 's1', 'r1');
    expect(events).toHaveLength(2);
    expect(events[0].event).toBe('chat.delta');
    expect(events[1].event).toBe('agent.tool');
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/management/stream-parser.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Write the stream parser**

```typescript
// src/management/stream-parser.ts

export interface StreamEvent {
  event: string;
  payload: Record<string, unknown>;
}

/**
 * Parse a single line of Claude's stream-json output into management events.
 *
 * Claude Code --output-format stream-json emits one JSON object per line:
 *   {"type":"system", ...}           — init/session info, ignored
 *   {"type":"assistant","message":{  — agent turn with content blocks
 *     "content":[
 *       {"type":"text","text":"..."}              → chat.delta
 *       {"type":"tool_use","name":"...","input":{}} → agent.tool
 *     ]
 *   }}
 *   {"type":"result","subtype":"success","result":"...","usage":{...}} → chat.final
 */
export function parseStreamJsonLine(
  line: string,
  sessionKey: string,
  runId: string,
): StreamEvent[] {
  const events: StreamEvent[] = [];
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(line);
  } catch {
    return events;
  }

  if (parsed.type === 'assistant') {
    const message = parsed.message as Record<string, unknown> | undefined;
    const content = (message?.content ?? []) as Array<Record<string, unknown>>;
    for (const block of content) {
      if (block.type === 'text' && block.text) {
        events.push({
          event: 'chat.delta',
          payload: { sessionKey, runId, content: block.text },
        });
      } else if (block.type === 'tool_use') {
        events.push({
          event: 'agent.tool',
          payload: {
            sessionKey,
            runId,
            tool: (block.name as string) || '',
            input: block.input,
            output: null,
          },
        });
      }
    }
  } else if (parsed.type === 'result') {
    const usage = parsed.usage as Record<string, number> | undefined;
    events.push({
      event: 'chat.final',
      payload: {
        sessionKey,
        runId,
        content: (parsed.result as string) || '',
        ...(parsed.session_id ? { sessionId: parsed.session_id } : {}),
        usage: {
          inputTokens: usage?.input_tokens ?? 0,
          outputTokens: usage?.output_tokens ?? 0,
        },
      },
    });
  }

  return events;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/management/stream-parser.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/management/stream-parser.ts src/management/stream-parser.test.ts
git commit -m "feat: extract stream-json parser into testable module"
```

---

## Task 4: Create the management barrel export

**Files:**
- Create: `src/management/index.ts`

- [ ] **Step 1: Create barrel file**

```typescript
// src/management/index.ts
export type {
  AgentRunner,
  RunnerEventMap,
  AgentSession,
  SpawnOptions,
} from './agent-runner.js';
export { ManagementServer } from './server.js';
export { createHandlers, sessionRunIds } from './handlers.js';
export { validateToken } from './auth.js';
export { parseStreamJsonLine } from './stream-parser.js';
export type { StreamEvent } from './stream-parser.js';
export * from './protocol.js';
```

- [ ] **Step 2: Verify it compiles**

Run: `npx tsc --noEmit`
Expected: No errors

- [ ] **Step 3: Commit**

```bash
git add src/management/index.ts
git commit -m "feat: add management barrel export"
```

---

## Task 5: Refactor ChildProcessRunner to implement AgentRunner

**Files:**
- Modify: `src/child-process-runner.ts`
- Modify: `src/child-process-runner.test.ts`

The existing `ChildProcessRunner` already has all the right methods. Since our `AgentRunner` interface doesn't extend EventEmitter (it just declares an `on` method), the class satisfies it structurally. We add an explicit `implements` clause and import shared types.

- [ ] **Step 1: Add interface conformance test**

Add to the top of the existing describe block in `child-process-runner.test.ts`:

```typescript
import type { AgentRunner } from './management/agent-runner.js';

// Inside the describe block, add:
it('should conform to AgentRunner interface', () => {
  const runner = new ChildProcessRunner({ maxConcurrent: 2 });
  // Compile-time check: if this assignment compiles, the interface is satisfied
  const asRunner: AgentRunner = runner;
  expect(asRunner).toBeDefined();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/child-process-runner.test.ts`
Expected: FAIL — type error, `ChildProcessRunner` not assignable to `AgentRunner`

- [ ] **Step 3: Update ChildProcessRunner to implement the interface**

In `src/child-process-runner.ts`:

Replace the local `SpawnOptions` and `AgentSession` with imports that extend the interface types:

```typescript
import { spawn, ChildProcess } from 'child_process';
import { EventEmitter } from 'events';
import { readFileSync, existsSync } from 'fs';
import type {
  AgentRunner,
  SpawnOptions as ISpawnOptions,
  AgentSession as IAgentSession,
} from './management/agent-runner.js';

export interface SpawnOptions extends ISpawnOptions {
  onOutput?: (data: string) => void;
  onError?: (data: string) => void;
  onExit?: (code: number | null) => void;
}

export interface AgentSession extends IAgentSession {
  pid: number;
  process: ChildProcess;
}
```

Add `implements AgentRunner` to the class declaration:

```typescript
export class ChildProcessRunner extends EventEmitter implements AgentRunner {
```

The rest of the class body stays identical — it already has `spawn`, `sendMessage`, `kill`, `killAll`, `activeCount`, `getSession`, and `on` (from EventEmitter).

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/child-process-runner.test.ts`
Expected: All PASS

- [ ] **Step 5: Commit**

```bash
git add src/child-process-runner.ts src/child-process-runner.test.ts
git commit -m "refactor: ChildProcessRunner implements AgentRunner interface"
```

---

## Task 6: Create the k8s entrypoint

**Files:**
- Create: `src/k8s-entrypoint.ts`
- Delete: `src/paas-entrypoint.ts`

The entrypoint wires the child-process runner (implementing AgentRunner) to the management server. It imports `parseStreamJsonLine` from the stream-parser module (Task 3) rather than containing the logic inline.

- [ ] **Step 1: Write the k8s entrypoint**

```typescript
// src/k8s-entrypoint.ts
import { ChildProcessRunner } from './child-process-runner.js';
import {
  ManagementServer,
  createHandlers,
  sessionRunIds,
  parseStreamJsonLine,
} from './management/index.js';

const MANAGEMENT_PORT = parseInt(process.env.MANAGEMENT_PORT || '18789');
const MAX_CONCURRENT = parseInt(process.env.MAX_CONCURRENT_AGENTS || '3');

async function main() {
  const runner = new ChildProcessRunner({ maxConcurrent: MAX_CONCURRENT });

  // Declare server first so the pushEvent closure captures it before use.
  // Safe because pushEvent is only called asynchronously (during chat.send error handling),
  // never during construction.
  let server: ManagementServer;

  const handlers = createHandlers(
    runner,
    (event, payload) => server.pushEvent(event, payload),
  );
  server = new ManagementServer({ port: MANAGEMENT_PORT, handlers });
  await server.start();
  console.log(
    `NanoClaw K8s management API listening on port ${MANAGEMENT_PORT}`,
  );

  // Wire runner output events to management server event push.
  runner.on('output', (sessionKey: string, data: string) => {
    const runId = sessionRunIds.get(sessionKey) || '';
    for (const line of data.split('\n').filter(Boolean)) {
      for (const ev of parseStreamJsonLine(line, sessionKey, runId)) {
        server.pushEvent(ev.event, ev.payload);
      }
    }
  });

  runner.on('exit', (sessionKey: string, code: number | null) => {
    const runId = sessionRunIds.get(sessionKey) || '';
    sessionRunIds.delete(sessionKey);
    if (code !== 0 && code !== null) {
      server.pushEvent('chat.error', {
        sessionKey,
        runId,
        error: `Agent process exited with code ${code}`,
      });
    }
  });

  runner.on('stderr', (sessionKey: string, data: string) => {
    console.error(`[claude:${sessionKey}] ${data.trimEnd()}`);
  });

  // Graceful shutdown
  const shutdown = async () => {
    console.log('Shutting down...');
    await runner.killAll();
    await server.stop();
    process.exit(0);
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

main().catch((err) => {
  console.error('Fatal:', err);
  process.exit(1);
});
```

- [ ] **Step 2: Delete the old paas-entrypoint.ts**

```bash
git rm src/paas-entrypoint.ts
```

- [ ] **Step 3: Verify build**

Run: `npx tsc --noEmit`
Expected: No errors

- [ ] **Step 4: Commit**

```bash
git add src/k8s-entrypoint.ts
git commit -m "feat: k8s entrypoint replaces paas-entrypoint, uses stream-parser and management barrel"
```

---

## Task 7: Create Dockerfile.ws and build-ws.sh

**Files:**
- Create: `container/Dockerfile.ws`
- Create: `container/build-ws.sh`
- Revert: `container/Dockerfile` (back to upstream state)
- Revert: `container/build.sh` (back to upstream state)

- [ ] **Step 1: Create Dockerfile.ws**

```dockerfile
# container/Dockerfile.ws
# NanoClaw K8s / WebSocket Management Mode
# Runs Claude CLI as child processes behind a WebSocket management API

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

# Install claude-code globally
RUN npm install -g @anthropic-ai/claude-code

# Management server
WORKDIR /ws
RUN echo '{"name":"nanoclaw-ws","version":"1.0.0","type":"module"}' > package.json \
  && npm install ws@8
COPY dist/k8s-entrypoint.js dist/k8s-entrypoint.js.map ./dist/
COPY dist/child-process-runner.js dist/child-process-runner.js.map ./dist/
COPY dist/management/ ./dist/management/

# Config directory for .env
RUN mkdir -p /home/node/.nanoclaw && chown node:node /home/node/.nanoclaw

# Expose management API port
EXPOSE 18789

# Non-root user
USER node
WORKDIR /home/node

CMD ["node", "/ws/dist/k8s-entrypoint.js"]
```

- [ ] **Step 2: Create build-ws.sh**

```bash
#!/bin/bash
# Build the NanoClaw K8s / WebSocket management container image
set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR/.."

IMAGE_NAME="nanoclaw-ws"
TAG="${1:-latest}"
CONTAINER_RUNTIME="${CONTAINER_RUNTIME:-docker}"

echo "Building NanoClaw WS management container image..."
echo "Image: ${IMAGE_NAME}:${TAG}"

# Compile TypeScript — dist/ files are COPY'd into the image
npm run build

${CONTAINER_RUNTIME} build -f container/Dockerfile.ws -t "${IMAGE_NAME}:${TAG}" .

echo ""
echo "Build complete!"
echo "Image: ${IMAGE_NAME}:${TAG}"
echo ""
echo "Run with:"
echo "  ${CONTAINER_RUNTIME} run -p 18789:18789 -e MANAGEMENT_TOKEN=secret -e ANTHROPIC_API_KEY=sk-... ${IMAGE_NAME}:${TAG}"
```

- [ ] **Step 3: Make build script executable**

```bash
chmod +x container/build-ws.sh
```

- [ ] **Step 4: Revert container/Dockerfile and build.sh to upstream state**

```bash
git checkout main -- container/Dockerfile container/build.sh
```

- [ ] **Step 5: Verify the original files are restored**

Run: `git diff main -- container/Dockerfile container/build.sh`
Expected: No diff

- [ ] **Step 6: Commit**

```bash
git add container/Dockerfile.ws container/build-ws.sh container/Dockerfile container/build.sh
git commit -m "feat: separate Dockerfile.ws and build-ws.sh for K8s mode, restore original Dockerfile"
```

---

## Task 8: Update package.json

**Files:**
- Modify: `package.json`

- [ ] **Step 1: Rename start:paas to start:ws**

Change `"start:paas": "node dist/paas-entrypoint.js"` to `"start:ws": "node dist/k8s-entrypoint.js"`.

- [ ] **Step 2: Verify build**

Run: `npm run build`
Expected: Clean compile

- [ ] **Step 3: Run all tests**

Run: `npm test`
Expected: All PASS

- [ ] **Step 4: Commit**

```bash
git add package.json
git commit -m "chore: rename start:paas to start:ws, point to k8s-entrypoint"
```

---

## Task 9: Create SKILL.md files on main

**Files:**
- Create: `.claude/skills/add-management-ws/SKILL.md`
- Create: `.claude/skills/add-k8s/SKILL.md`

- [ ] **Step 1: Create add-management-ws SKILL.md**

```markdown
---
name: add-management-ws
description: Add WebSocket management API server. Provides remote control of NanoClaw via authenticated WebSocket connections. Required by /add-k8s.
---

# Add WebSocket Management API

Adds a WebSocket management server with token authentication, request/response framing, and event streaming. This is the foundation for remote management interfaces (K8s, web UIs, etc.).

Adds:
- WebSocket server with timing-safe token auth
- HTTP health/readiness endpoints (`/health`, `/readyz`)
- `AgentRunner` interface for pluggable runner backends
- Stream-json parser for Claude CLI output
- Protocol types: `chat.send`, `chat.abort`, `chat.delta`, `chat.final`, `chat.error`, `agent.tool`

## Phase 1: Pre-flight

### Check if already applied

Check if `src/management/server.ts` exists. If it does, skip to Phase 3 (Configure).

## Phase 2: Apply Code Changes

### Ensure upstream remote

```bash
git remote -v
```

If `upstream` is missing:

```bash
git remote add upstream https://github.com/qwibitai/nanoclaw.git
```

### Merge the skill branch

```bash
git fetch upstream skill/management-ws
git merge upstream/skill/management-ws
```

This merges in:
- `src/management/` directory (server, protocol, auth, handlers, agent-runner interface, stream-parser)
- `ws` + `@types/ws` npm dependencies
- `MANAGEMENT_TOKEN` and `MANAGEMENT_PORT` in `.env.example`

If the merge reports conflicts, resolve them by reading the conflicted files.

### Install dependencies

```bash
npm install
```

### Validate

```bash
npm run build
npm test
```

Build and tests must be clean before proceeding.

## Phase 3: Configure

### Set management token

Add to `.env`:

```bash
MANAGEMENT_TOKEN=<generate-a-secure-random-token>
```

### Set port (optional)

Default is 18789. Override with:

```bash
MANAGEMENT_PORT=18789
```

## Phase 4: Verify

### Run the tests

```bash
npm test
```

All management tests should pass.

### Test the health endpoint manually

```bash
npm run build
node --input-type=module -e "
import { ManagementServer } from './dist/management/server.js';
import { createHandlers } from './dist/management/handlers.js';
import { EventEmitter } from 'events';

const runner = Object.assign(new EventEmitter(), {
  spawn: async (opts) => ({ sessionKey: opts.sessionKey, startedAt: new Date() }),
  sendMessage: async () => {},
  kill: async () => {},
  killAll: async () => {},
  get activeCount() { return 0; },
  getSession: () => undefined,
});

const handlers = createHandlers(runner);
const server = new ManagementServer({ port: 18789, handlers });
await server.start();
console.log('Management server running on :18789');
const res = await fetch('http://localhost:18789/health');
console.log('Health:', await res.json());
await server.stop();
console.log('OK');
"
```

Expected: `Health: { status: 'ok' }` then `OK`.

## Troubleshooting

### WebSocket connection rejected

1. Verify `MANAGEMENT_TOKEN` is set in your `.env`
2. Ensure the first frame sent is `{"type":"auth","token":"your-token"}`
3. Auth must happen within 5 seconds or the connection is closed
```

- [ ] **Step 2: Create add-k8s SKILL.md**

```markdown
---
name: add-k8s
description: Run NanoClaw in Kubernetes. Adds child-process runner, Dockerfile.ws, and K8s entrypoint. Requires /add-management-ws first.
---

# Add Kubernetes Support

Runs NanoClaw as a WebSocket management API server in a container, spawning Claude CLI as child processes instead of Docker containers. Designed for Kubernetes and other container orchestrators where Docker-in-Docker isn't available.

## Prerequisites

This skill requires `/add-management-ws` to be applied first. Check if `src/management/server.ts` exists — if not, run `/add-management-ws` first.

## Phase 1: Pre-flight

### Check if already applied

Check if `src/k8s-entrypoint.ts` exists. If it does, skip to Phase 3 (Configure).

### Check prerequisites

Verify management-ws is applied:

```bash
ls src/management/server.ts
```

If missing, tell the user to run `/add-management-ws` first.

## Phase 2: Apply Code Changes

### Ensure upstream remote

```bash
git remote -v
```

If `upstream` is missing:

```bash
git remote add upstream https://github.com/qwibitai/nanoclaw.git
```

### Merge the skill branch

```bash
git fetch upstream skill/k8s
git merge upstream/skill/k8s
```

This merges in:
- `src/child-process-runner.ts` (AgentRunner implementation using Claude CLI)
- `src/k8s-entrypoint.ts` (wires runner + management server)
- `container/Dockerfile.ws` (K8s-optimized container image)
- `container/build-ws.sh` (build script)
- `start:ws` npm script
- Env var additions in `.env.example`

### Install dependencies

```bash
npm install
```

### Build the container image

```bash
./container/build-ws.sh
```

## Phase 3: Configure

### Set environment variables

Add to `.env`:

```bash
# Required
MANAGEMENT_TOKEN=<your-token>
ANTHROPIC_API_KEY=<your-api-key>

# Optional
MANAGEMENT_PORT=18789
MAX_CONCURRENT_AGENTS=3
MODEL_PRIMARY=claude-sonnet-4-20250514
SYSTEM_PROMPT=
```

## Phase 4: Verify

### Test locally with Docker

```bash
docker run -p 18789:18789 \
  -e MANAGEMENT_TOKEN=test-secret \
  -e ANTHROPIC_API_KEY=$ANTHROPIC_API_KEY \
  nanoclaw-ws:latest
```

In another terminal, test the health endpoint:

```bash
curl http://localhost:18789/health
```

Expected: `{"status":"ok"}`

### Test WebSocket connection

```bash
node --input-type=module -e "
import WebSocket from 'ws';
const ws = new WebSocket('ws://localhost:18789');
ws.on('open', () => {
  ws.send(JSON.stringify({ type: 'auth', token: 'test-secret' }));
});
ws.on('message', (data) => {
  console.log(JSON.parse(data.toString()));
  ws.close();
});
"
```

Expected: `{ type: 'auth', ok: true }`

## Troubleshooting

### "No Anthropic credentials configured"

The child-process runner checks for credentials before spawning Claude CLI. Ensure one of these is set:
- `ANTHROPIC_API_KEY`
- `CLAUDE_CODE_OAUTH_TOKEN`
- `ANTHROPIC_BASE_URL` (for proxy setups)

### Container builds but Claude CLI not found

The Dockerfile installs `@anthropic-ai/claude-code` globally. If the install failed, check the build logs. May need to rebuild with `--no-cache`:

```bash
docker builder prune -f
./container/build-ws.sh
```

### Max concurrent agents reached

Increase `MAX_CONCURRENT_AGENTS` env var. Default is 3.
```

- [ ] **Step 3: Commit**

```bash
git add .claude/skills/add-management-ws/SKILL.md .claude/skills/add-k8s/SKILL.md
git commit -m "docs: add SKILL.md stubs for management-ws and k8s skills"
```

---

## Task 10: Run full test suite and verify clean build

**Files:** None (verification only)

- [ ] **Step 1: Run TypeScript compiler**

Run: `npx tsc --noEmit`
Expected: No errors

- [ ] **Step 2: Run all tests**

Run: `npm test`
Expected: All PASS

- [ ] **Step 3: Run linter**

Run: `npm run lint`
Expected: Clean

- [ ] **Step 4: Run formatter**

Run: `npm run format:check`
Expected: Clean (or run `npm run format:fix` then commit)

- [ ] **Step 5: Verify Dockerfile.ws builds**

Run: `./container/build-ws.sh`
Expected: Image `nanoclaw-ws:latest` built successfully

- [ ] **Step 6: Verify original Dockerfile still builds**

Run: `./container/build.sh`
Expected: Image `nanoclaw-agent:latest` built successfully (no WS/K8s code in it)

---

## Task 11: Organize into skill branches

This is the git work to create the two skill branches from the completed work. The work has been done as sequential commits on a single branch, so we use `git checkout <ref> -- <file>` to copy specific files onto clean branches.

- [ ] **Step 1: Create skill/management-ws branch from main**

```bash
git checkout main
git pull origin main
git checkout -b skill/management-ws
```

- [ ] **Step 2: Copy management-ws files from the working branch**

```bash
# Copy all management source files
git checkout feature/paas-mode -- \
  src/management/agent-runner.ts \
  src/management/protocol.ts \
  src/management/protocol.test.ts \
  src/management/auth.ts \
  src/management/server.ts \
  src/management/server.test.ts \
  src/management/handlers.ts \
  src/management/handlers.test.ts \
  src/management/stream-parser.ts \
  src/management/stream-parser.test.ts \
  src/management/index.ts
```

- [ ] **Step 3: Add ws dependency to package.json**

Run: `npm install ws@^8.18.0` and `npm install -D @types/ws@^8.5.10`

- [ ] **Step 4: Add env vars to .env.example**

Append `MANAGEMENT_TOKEN=` and `MANAGEMENT_PORT=18789` to `.env.example`.

- [ ] **Step 5: Verify skill/management-ws builds and tests pass**

```bash
npm run build && npm test
```

- [ ] **Step 6: Commit skill/management-ws**

```bash
git add -A
git commit -m "feat: WebSocket management API with AgentRunner abstraction"
```

- [ ] **Step 7: Create skill/k8s branch from skill/management-ws**

```bash
git checkout -b skill/k8s
```

- [ ] **Step 8: Copy k8s files from the working branch**

```bash
git checkout feature/paas-mode -- \
  src/child-process-runner.ts \
  src/child-process-runner.test.ts \
  src/k8s-entrypoint.ts \
  container/Dockerfile.ws \
  container/build-ws.sh
```

- [ ] **Step 9: Add start:ws script to package.json**

Add `"start:ws": "node dist/k8s-entrypoint.js"` to the scripts section.

- [ ] **Step 10: Add env vars to .env.example**

Append `MAX_CONCURRENT_AGENTS=3`, `MODEL_PRIMARY=`, `SYSTEM_PROMPT=` to `.env.example`.

- [ ] **Step 11: Verify skill/k8s builds and tests pass**

```bash
npm install && npm run build && npm test
./container/build-ws.sh
```

- [ ] **Step 12: Commit skill/k8s**

```bash
git add -A
git commit -m "feat: K8s support with child-process runner and Dockerfile.ws"
```

- [ ] **Step 13: Add SKILL.md stubs to main**

```bash
git checkout main
git checkout feature/paas-mode -- \
  .claude/skills/add-management-ws/SKILL.md \
  .claude/skills/add-k8s/SKILL.md
git add .claude/skills/add-management-ws/ .claude/skills/add-k8s/
git commit -m "docs: add skill stubs for management-ws and k8s"
```
