# WS/K8s SDK Feature Parity

**Date:** 2026-03-30
**Status:** Draft
**Repos:** nanoclaw

## Overview

Replace the `claude` CLI child process in `Dockerfile.ws` (K8s deployment) with the `agent-runner` as a child process, bringing the rich SDK-based agent capabilities from the self-hosted `Dockerfile` build to the K8s/WebSocket deployment without requiring Docker-in-Docker.

## Background

NanoClaw has two fundamentally different container builds:

1. **`Dockerfile` (nanoclaw-agent)** — Ephemeral container per agent invocation. Uses `@anthropic-ai/claude-agent-sdk` `query()` function as a library. Has MCP IPC tools (`send_message`, `schedule_task`, `request_approval`), Ollama MCP server, X/Twitter MCP tools, PreCompact hooks for conversation archiving, script pre-checks for scheduled tasks, `MessageStream` for mid-query message injection, per-group source customization. Source: `container/agent-runner/src/` (3 files, ~1,294 lines).

2. **`Dockerfile.ws` (nanoclaw-ws)** — Long-running management server. Spawns `claude` CLI as child processes via `ChildProcessRunner`. Has WebSocket management API, multi-channel messaging (Discord, Slack, Telegram, WhatsApp, Emacs), group sync, memory sync, file sync, channel status reporting. Source: `src/` (42+ files, compiled to `dist/`).

The two builds share no code at the TypeScript/package level. The K8s deployment currently lacks all agent-runner capabilities (MCP tools, X integration, hooks, MessageStream, etc.) because it spawns the basic `claude` CLI instead.

## Architecture

```
k8s-entrypoint.ts
  │
  ├── AGENT_MODE=cli  (existing, default)
  │   └── ChildProcessRunner → spawns `claude` CLI
  │
  └── AGENT_MODE=sdk  (new)
      └── AgentRunnerProcess → spawns `node /ws/agent-runner/dist/index.js`
          ├── stdin: ContainerInput JSON (line 1) + follow-up messages
          ├── stdout: stream events (STREAM_EVENT_MARKER) + final output (OUTPUT markers)
          └── stderr: diagnostic logs
```

The `AgentRunnerProcess` implements the same `AgentRunner` interface as `ChildProcessRunner`, so the k8s-entrypoint works identically with either backend. An `AGENT_MODE` environment variable selects which runner to instantiate.

### Key Design Decisions

- **Agent-runner as subprocess, not library** — Keeps the same child-process isolation model. The agent-runner process can crash without taking down the management server.
- **Stdin-based IPC instead of file polling** — The agent-runner's existing file-based IPC (`/workspace/ipc/input/`) doesn't work with K8s read-only root filesystem. Stdin IPC is zero-latency, requires no filesystem, and maps directly onto the `AgentRunner` interface.
- **Dual-protocol stdout** — Stream events use a single-line marker (`---NANOCLAW_STREAM_EVENT---` + JSON), final output uses the existing sandwich markers (`---NANOCLAW_OUTPUT_START---` / `---NANOCLAW_OUTPUT_END---`).
- **Pre-compiled at build time** — The agent-runner currently compiles TypeScript at container startup via `npx tsc`. K8s has `readOnlyRootFilesystem: true`, so the Dockerfile.ws build pre-compiles to `dist/`.

---

## Deliverable 1: Agent-Runner Streaming + Stdin IPC

Modify the agent-runner to support real-time streaming output and stdin-based IPC.

### Streaming Protocol

The agent-runner currently only emits `ContainerOutput` on `message.type === 'result'`. All intermediate SDK messages are logged to stderr and discarded.

Enable `includePartialMessages: true` in the SDK `query()` options. Emit stream events as they arrive:

```
---NANOCLAW_STREAM_EVENT---
{"event":"chat.delta","payload":{"content":"Hello"}}
---NANOCLAW_STREAM_EVENT---
{"event":"agent.tool","payload":{"tool":"Bash","input":{"command":"ls"},"output":null}}
---NANOCLAW_OUTPUT_START---
{"status":"success","result":"Done.","newSessionId":"abc123"}
---NANOCLAW_OUTPUT_END---
```

Stream events use the same event names as the WS protocol (`chat.delta`, `agent.tool`) so they pass through to WebSocket clients without transformation.

### Stdin IPC Protocol

Add `IPC_MODE=stdin|file` environment variable (default: `file` for backward compatibility).

In `stdin` mode:
- Line 1: `ContainerInput` JSON (read first line only, not until EOF)
- Subsequent lines: `{"type":"message","text":"..."}` — fed into the `MessageStream`
- `{"type":"close"}` — triggers graceful shutdown (equivalent to `_close` sentinel)
- EOF on stdin — also triggers graceful shutdown

### Configurable Workspace Directory

Add `workspaceDir` field to `ContainerInput`:

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
  workspaceDir?: string;  // Override cwd (default: '/workspace/group')
}
```

The agent-runner passes `containerInput.workspaceDir || '/workspace/group'` to the SDK's `cwd` option.

---

## Deliverable 2: AgentRunnerProcess

New runner class implementing the `AgentRunner` interface. Spawns `node /ws/agent-runner/dist/index.js` as a child process.

### Input

Writes `ContainerInput` JSON as the first stdin line on spawn. Builds `ContainerInput` from `SpawnOptions`:

```typescript
const containerInput: ContainerInput = {
  prompt: opts.initialPrompt || '',
  sessionId: opts.resumeSessionId,
  groupFolder: group.folder,         // from registered groups
  chatJid: opts.sessionKey,
  isMain: group.isMain || false,
  assistantName: group.assistantName,
  workspaceDir: opts.cwd,
};
```

### Output Parsing

Stateful line-by-line parser handling two marker types:

| Marker | Meaning | Action |
|--------|---------|--------|
| `---NANOCLAW_STREAM_EVENT---` | Next line is stream event JSON | Parse and emit as `StreamEvent` |
| `---NANOCLAW_OUTPUT_START---` | Next line is `ContainerOutput` JSON | Parse, emit `chat.final`, extract `newSessionId` |
| `---NANOCLAW_OUTPUT_END---` | End of output block | Reset state |

The parser injects `sessionKey` and `runId` (WS-layer concepts) into stream event payloads before emitting.

### sendMessage / kill

```typescript
sendMessage(sessionKey, message) → stdin.write(JSON.stringify({type:'message', text: message}) + '\n')
kill(sessionKey) → stdin.write(JSON.stringify({type:'close'}) + '\n') + SIGTERM fallback after 5s
```

### Credential Flow

Reuses the existing `loadDotEnv('/home/node/.nanoclaw/.env')` pattern from `ChildProcessRunner`. Credentials are passed via the child process environment.

---

## Deliverable 3: Dockerfile.ws Changes

Bundle the agent-runner into the WS image:

```dockerfile
# Agent-runner build stage
WORKDIR /ws/agent-runner
COPY container/agent-runner/package*.json ./
RUN npm ci --omit=dev
COPY container/agent-runner/src/ ./src/
COPY container/agent-runner/tsconfig.json ./
RUN npx tsc --outDir dist

# Skills
COPY container/skills/ /ws/skills/
```

No changes to the K8s Deployment spec (`deployment.go`) — the entrypoint remains `node /ws/dist/k8s-entrypoint.js`.

---

## Deliverable 4: K8s Entrypoint Integration

Add runner selection in `k8s-entrypoint.ts`:

```typescript
const AGENT_MODE = process.env.AGENT_MODE || 'cli';
const runner = AGENT_MODE === 'sdk'
  ? new AgentRunnerProcess({ maxConcurrent: MAX_CONCURRENT })
  : new ChildProcessRunner({ maxConcurrent: MAX_CONCURRENT });
```

The output event handler needs conditional parsing:
- `cli` mode: existing `parseStreamJsonLine()` (Claude CLI stream-json format)
- `sdk` mode: new `parseAgentRunnerLine()` (marker-based format)

Both parsers produce the same `StreamEvent` objects, so the rest of the pipeline (processStreamEvents → server.pushEvent → WebSocket clients) is unchanged.

---

## Session Management

Already compatible. The SDK stores session data in `~/.claude/`, which is mounted from PVC (`nanoclaw-home` with subpath `.claude`). The agent-runner returns `newSessionId` in `ContainerOutput`, and the WS entrypoint tracks it per chat.

## What's NOT Changing

- WebSocket management API protocol
- Channel implementations (Discord, Slack, Telegram, WhatsApp, Emacs)
- Groups sync, memory sync, file sync
- `bearclaw-platform` provisioner (`deployment.go`)
- Self-hosted Docker mode (`Dockerfile`, `container-runner.ts`)
