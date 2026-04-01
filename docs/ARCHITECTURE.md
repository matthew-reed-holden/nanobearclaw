# NanoClaw Architecture

Living architecture documentation. Last updated: March 30, 2026.

---

## System Overview

NanoClaw is a Node.js process that orchestrates messaging channels, routes messages to Claude agents, and manages scheduled tasks. It operates in two deployment modes selected by the `AGENT_MODE` environment variable:

- **`cli` mode (default / standalone):** Single process with a message-poll loop, SQLite, and per-group Docker/Apple Container isolation. Agents run as child processes wrapping the `claude` CLI.
- **`sdk` mode (K8s / platform):** WebSocket management server (`ManagementServer`) that BearClaw Platform drives over a persistent connection. Agents run via `AgentRunnerProcess`, a stdin-IPC wrapper around the pre-compiled TypeScript agent-runner. Container image: `Dockerfile.ws`.

Security is achieved through OS-level container isolation and a credential proxy — no secrets are passed into containers directly.

```mermaid
graph TB
    subgraph Channels["Messaging Channels (cli mode)"]
        WA[WhatsApp<br/>Baileys]
        TG[Telegram<br/>Grammy]
        DC[Discord<br/>discord.js]
        SL[Slack<br/>Bolt]
        EM[Emacs<br/>Local dev]
    end

    subgraph Core["NanoClaw Process — cli mode"]
        CR[Channel Registry]
        ORC[Orchestrator<br/>index.ts]
        DB[(SQLite)]
        GQ[Group Queue]
        RT[Router]
        TS[Task Scheduler]
        IPC[IPC Watcher]
        CP[Credential Proxy]
        APR[Approval Store]
    end

    subgraph K8sMode["NanoClaw — sdk mode (K8s)"]
        MGT[Management Server<br/>WebSocket :18789]
        HDL[Handlers<br/>chat.send / social.* / groups.* / files.*]
        ARN[AgentRunner<br/>Interface]
        ARP[AgentRunnerProcess<br/>stdin IPC]
        CHL[ChildProcessRunner<br/>claude CLI fallback]
        ARPS[agent-runner<br/>pre-compiled TS]
        DS[DiscoveryEmitter]
        MS[MemorySyncManager]
        WR[WhatsAppPairingRelay]
        GS[GroupsSyncHandler]
        CSR[ChannelStatusReporter]
    end

    subgraph Containers["Isolated Containers"]
        C1[Agent Container 1<br/>Claude SDK]
        C2[Agent Container N<br/>Claude SDK]
    end

    subgraph Storage["Filesystem"]
        GF[groups/ or chats/<br/>Per-group folders]
        GM[shared/<br/>Shared memory + knowledge]
        IPCF[data/ipc/<br/>IPC files]
        SS[data/sessions/<br/>Agent sessions]
    end

    API[Anthropic API]
    BCL[BearClaw Platform<br/>Go API]

    Channels --> CR --> ORC
    ORC <--> DB
    ORC --> GQ --> Containers
    ORC --> RT --> Channels
    TS --> GQ
    IPC <--> IPCF
    IPC <--> ORC
    Containers <--> IPCF
    Containers --> CP --> API
    Containers <--> GF
    Containers -.-> GM
    Containers <--> SS
    ORC <--> APR

    BCL -->|WebSocket| MGT
    MGT --> HDL
    HDL --> ARN
    ARN --> ARP
    ARN --> CHL
    ARP --> ARPS
    ARPS --> API
    MGT --> DS & MS & WR & GS & CSR
```

---

## Message Flow

From user message to agent response:

```mermaid
sequenceDiagram
    participant U as User
    participant CH as Channel<br/>(WhatsApp/Telegram/etc)
    participant DB as SQLite
    participant ORC as Orchestrator
    participant GQ as Group Queue
    participant CTR as Container
    participant SDK as Claude SDK
    participant RT as Router

    U->>CH: Send message
    CH->>DB: storeMessage()

    loop Every 2s
        ORC->>DB: getNewMessages()
    end

    ORC->>ORC: Check trigger pattern
    ORC->>ORC: Check sender allowlist
    ORC->>GQ: enqueueMessageCheck(groupJid)

    alt No active container
        GQ->>CTR: Spawn container (docker run)
        CTR->>CTR: Shadow .env, compile agent-runner
        CTR->>CTR: Drop privileges
    else Container idle
        GQ->>CTR: Pipe message to stdin
    end

    CTR->>SDK: Query agent with prompt
    SDK-->>CTR: Stream response
    CTR->>ORC: Emit OUTPUT markers
    ORC->>RT: formatOutbound()
    RT->>CH: sendMessage()
    CH->>U: Deliver response
```

---

## Container Lifecycle

Each container runs an isolated Claude agent with its own filesystem, memory, and IPC namespace:

```mermaid
stateDiagram-v2
    [*] --> Queued: enqueueMessageCheck()
    Queued --> Spawning: Slot available<br/>(max 5 concurrent)
    Spawning --> Running: docker run<br/>+ mount volumes
    Running --> Processing: Read stdin<br/>+ query Claude SDK
    Processing --> OutputEmitted: Agent responds<br/>OUTPUT markers
    OutputEmitted --> IdleWaiting: No pending work<br/>Poll IPC /500ms
    IdleWaiting --> Processing: New IPC input<br/>or stdin message
    IdleWaiting --> Closed: Idle timeout (30min)<br/>or _close sentinel
    Processing --> Closed: Agent completes
    Closed --> [*]: Cleanup

    OutputEmitted --> Processing: More results<br/>(agent teams)
    Queued --> Queued: Max containers reached<br/>Wait for slot
```

---

## Container Mount Architecture

```mermaid
graph LR
    subgraph Host["Host Filesystem"]
        PJ[Project Root<br/>read-only, main only]
        GF["groups/{name}/<br/>read-write"]
        GL[global/<br/>read-only]
        IP["data/ipc/{name}/<br/>read-write"]
        SE["data/sessions/{name}/<br/>read-write"]
        AR[container/agent-runner/<br/>read-write]
    end

    subgraph Container["Container"]
        WP["/workspace/project"]
        WG["/workspace/group"]
        WGL["/workspace/global"]
        WIPC["/workspace/ipc"]
        HC["/home/node/.claude"]
        APP["/app/src"]
    end

    PJ -->|mount ro| WP
    GF -->|mount rw| WG
    GL -->|mount ro| WGL
    IP -->|mount rw| WIPC
    SE -->|mount rw| HC
    AR -->|mount rw| APP
```

---

## Credential Security

Secrets never enter containers directly. A proxy intercepts API calls at the network boundary:

```mermaid
sequenceDiagram
    participant CTR as Container<br/>(placeholder key)
    participant CP as Credential Proxy<br/>(host :3001)
    participant API as Anthropic API

    CTR->>CP: POST /v1/messages<br/>x-api-key: placeholder
    CP->>CP: Replace placeholder<br/>with real API key
    CP->>API: POST /v1/messages<br/>x-api-key: sk-ant-...
    API-->>CP: Response
    CP-->>CTR: Response
```

---

## Channel System

Channels self-register at startup via a factory pattern:

```mermaid
graph TB
    subgraph Registry["Channel Registry"]
        RF[registerChannel<br/>name → factory]
    end

    subgraph Factories["Channel Factories"]
        WF["whatsapp → WhatsAppChannel()"]
        TF["telegram → TelegramChannel()"]
        DF["discord → DiscordChannel()"]
        SF["slack → SlackChannel()"]
        EF["emacs → EmacsChannel()"]
    end

    subgraph Interface["Channel Interface"]
        CN[connect]
        SM[sendMessage]
        IC[isConnected]
        OJ[ownsJid]
        DC[disconnect]
        ST[setTyping]
        SG[syncGroups]
    end

    Factories --> Registry
    Registry --> Interface
```

Each channel implements the `Channel` interface and provides two callbacks: `onMessage` for inbound messages and `onChatMetadata` for group discovery.

---

## Deployment Modes

NanoClaw selects its runtime mode via the `AGENT_MODE` environment variable:

```mermaid
graph LR
    subgraph CliMode["AGENT_MODE=cli (default)"]
        direction TB
        IDX[index.ts<br/>Orchestrator]
        CPR[ChildProcessRunner<br/>spawns claude CLI]
        CTR[Docker / Apple Container<br/>per-group isolation]
        IDX --> CPR --> CTR
    end

    subgraph SdkMode["AGENT_MODE=sdk (K8s platform)"]
        direction TB
        KE[k8s-entrypoint.ts]
        MGS[ManagementServer<br/>WebSocket :18789]
        ARP[AgentRunnerProcess<br/>stdin IPC]
        AR[agent-runner<br/>pre-compiled TS binary]
        KE --> MGS --> ARP --> AR
    end
```

- **`cli` mode** — `src/index.ts` polls SQLite for messages, routes them through a group queue, and spawns isolated containers.
- **`sdk` mode** — `src/k8s-entrypoint.ts` starts a `ManagementServer`. BearClaw Platform connects over WebSocket and drives agents via JSON-framed protocol (auth → req/res/event frames). The `AgentRunnerProcess` spawns the pre-compiled agent-runner with stdin-based IPC.

---

## Management Layer (sdk mode)

The management layer is a WebSocket server that BearClaw Platform uses to control NanoClaw agents in K8s deployments.

```mermaid
graph TB
    subgraph Platform["BearClaw Platform"]
        NC_CLIENT[nc_client.go<br/>Go gateway client]
    end

    subgraph ManagementServer["ManagementServer (src/management/)"]
        AUTH[Auth handler<br/>token validation]
        PROTO[Protocol<br/>auth / req / res / event frames]
        HDL[Handlers<br/>chat.send, chat.abort,<br/>social.generate, social.publish, social.monitor,<br/>channels.status, whatsapp.pair,<br/>groups.sync, files.sync, files.list]
        ARN[AgentRunner interface]
        ARP[AgentRunnerProcess]
        ARPR[AgentRunnerParser<br/>sandwich markers]
        CRL[ChildProcessRunner<br/>CLI fallback]
    end

    subgraph SubModules["Management Sub-modules"]
        DS[DiscoveryEmitter<br/>unregistered chat discovery]
        MS[MemorySyncManager<br/>shared memory polling]
        WR[WhatsAppPairingRelay<br/>QR code relay]
        GS[GroupsSyncHandler<br/>group list sync]
        CSR[ChannelStatusReporter<br/>connection status]
        SP[SocialPublishHandler<br/>XDK x_post / x_reply / x_quote]
    end

    NC_CLIENT -->|WebSocket| AUTH
    AUTH --> PROTO
    PROTO --> HDL
    HDL --> ARN
    ARN --> ARP & CRL
    ARP --> ARPR
    HDL --> SP
    HDL -.-> DS & MS & WR & GS & CSR
```

**Protocol frames:** Each message is a JSON object with `type` discriminator. The handshake sends `{type:"auth", token}` → receives `{type:"auth", ok:true}`. Requests are `{type:"req", id, method, params}` → responses `{type:"res", id, ok, result|error}`. Server pushes `{type:"event", event, payload}`.

---

## Approval System

Containers can request human approval before executing sensitive social actions. The approval loop uses SQLite persistence and IPC files.

```mermaid
sequenceDiagram
    participant AG as Container Agent
    participant IPC as IPC Watcher (host)
    participant APR as Approval Store (SQLite)
    participant CH as Channel (notify)
    participant US as User (approve)
    participant ARDIR as ipc/{group}/approval_results/

    AG->>IPC: Write request_approval JSON to ipc/{group}/tasks/
    IPC->>APR: Create PendingApproval (status: pending)
    IPC->>CH: Notify user via configured channel

    Note over APR: Expiry timer runs (default 60 min)

    alt User approves / rejects
        US->>APR: Resolve (approved | rejected)
        APR->>ARDIR: Write result JSON
        AG->>ARDIR: Poll for result file
    else Expires
        APR->>APR: Status → expired
    end
```

**Approval policy** (`approval-policy.json`): defines per-action `mode` (`auto`, `confirm`, `block`), `notifyChannels`, and `expiryMinutes`. Loaded at startup; defaults to `confirm` for all actions.

---

## X (Twitter) Integration

X integration ships as container skills, loaded at runtime. The `AgentRunnerProcess` carries skills into the container alongside the agent-runner binary.

```mermaid
graph TB
    subgraph ContainerSkills["container/skills/x-integration/"]
        TOOLS[MCP Tools<br/>x_post, x_reply, x_quote,<br/>x_timeline, x_search]
        XA[X Actions Module<br/>wraps XDK SDK calls]
        XC[XDK Client Wrapper<br/>@xdevplatform/xdk]
    end

    subgraph Publishing["Social Publish (management layer)"]
        SP[social-publish.ts<br/>handleSocialPublish()]
        XDK[@xdevplatform/xdk<br/>Client]
    end

    SM[social.monitor<br/>gateway handler] --> SMP[SocialMonitor<br/>pipeline orchestrator]
    SMP --> SDD[Deduplication Store]
    SMP --> DPB[Decision Prompt Builder]
    SMP --> EL[Engagement Log]
    SMP --> XC

    SP --> XDK
    TOOLS --> XA --> XC
```

**Credential injection:** `X_ACCESS_TOKEN` is injected by OneCLI at container startup. The agent-runner never sees raw API keys.

---

## Scheduled Tasks

```mermaid
sequenceDiagram
    participant SCH as Scheduler<br/>(60s loop)
    participant DB as SQLite
    participant GQ as Group Queue
    participant CTR as Container
    participant IPC as IPC Watcher
    participant CH as Channel

    loop Every 60s
        SCH->>DB: getDueTasks()
        DB-->>SCH: Tasks where next_run <= now
    end

    SCH->>GQ: enqueueTask(groupJid, taskId)
    GQ->>CTR: Spawn container with task prompt
    CTR->>CTR: Execute task

    opt Agent sends message
        CTR->>IPC: Write message JSON
        IPC->>CH: sendMessage(jid, text)
    end

    CTR-->>SCH: Task complete
    SCH->>DB: logTaskRun()
    SCH->>DB: updateTask(next_run)
```

---

## IPC System

Bidirectional communication between host and containers via filesystem:

```mermaid
graph TB
    subgraph Host["Host Process"]
        IW[IPC Watcher<br/>polls 1s]
        ORC[Orchestrator]
    end

    subgraph IPC["data/ipc/{group}/"]
        MSG["messages/<br/>Agent → Host"]
        TSK["tasks/<br/>Agent → Host"]
        INP["input/<br/>Host → Agent"]
        ERR["errors/<br/>Failed files"]
    end

    subgraph Container["Container"]
        AG[Agent Runner]
    end

    AG -->|Write JSON| MSG
    AG -->|Write JSON| TSK
    IW -->|Read + delete| MSG
    IW -->|Read + delete| TSK
    ORC -->|Write JSON| INP
    AG -->|Poll 500ms| INP
    IW -->|Move on error| ERR
```

**Authorization:** Main group can send to any JID and manage any task. Non-main groups are restricted to their own JID and tasks.

---

## Database Schema

```mermaid
erDiagram
    chats {
        text jid PK
        text name
        text channel
        integer is_group
        integer last_sync_timestamp
    }

    messages {
        text id PK
        text chat_jid FK
        text sender
        text content
        integer timestamp
    }

    registered_groups {
        text jid PK
        text config_json
    }

    sessions {
        text group_jid PK
        text session_id
    }

    scheduled_tasks {
        text id PK
        text group_jid FK
        text prompt
        text schedule_type
        text schedule_value
        text status
        integer next_run
    }

    task_run_logs {
        text id PK
        text task_id FK
        integer started_at
        integer duration_ms
        text result
    }

    router_state {
        text key PK
        text value
    }

    chats ||--o{ messages : contains
    registered_groups ||--o{ sessions : has
    scheduled_tasks ||--o{ task_run_logs : generates
```

---

## Key Configuration

| Setting | Default | Purpose |
|---------|---------|---------|
| `AGENT_MODE` | `cli` | `cli` = standalone, `sdk` = K8s WebSocket management server |
| `ASSISTANT_NAME` | `@Andy` | Trigger word prefix |
| `POLL_INTERVAL` | 2000ms | Message polling frequency (cli mode) |
| `CONTAINER_TIMEOUT` | 1800s | Max container runtime |
| `IDLE_TIMEOUT` | 1800s | Keep idle container alive |
| `MAX_CONCURRENT_CONTAINERS` | 5 | Concurrency limit (cli mode) |
| `MAX_CONCURRENT_AGENTS` | 3 | Concurrency limit (sdk mode) |
| `MANAGEMENT_PORT` | 18789 | WebSocket management server port (sdk mode) |
| `IPC_POLL_INTERVAL` | 1000ms | IPC file check frequency |
| `SCHEDULER_POLL_INTERVAL` | 60000ms | Task scheduler check |
| `SYSTEM_PROMPT` | — | Per-instance system prompt injected by platform |
| `X_ACCESS_TOKEN` | — | Injected by OneCLI; used by X integration and social-publish |

---

## File Map

| File | Purpose |
|------|---------|
| `src/index.ts` | Orchestrator: state, message loop, agent invocation (cli mode) |
| `src/k8s-entrypoint.ts` | K8s entrypoint: starts ManagementServer + channels (sdk mode) |
| `src/db.ts` | SQLite schema and queries |
| `src/container-runner.ts` | Spawn containers with mounts |
| `src/container-runtime.ts` | Runtime abstraction (Apple Container/Docker/Podman) |
| `src/credential-proxy.ts` | Secure credential injection proxy |
| `src/child-process-runner.ts` | AgentRunner impl: spawns claude CLI directly |
| `src/agent-runner-process.ts` | AgentRunner impl: spawns pre-compiled agent-runner via stdin IPC |
| `src/approval.ts` | Approval policy loader, SQLite store, IPC result writer |
| `src/group-queue.ts` | Per-group concurrency control |
| `src/task-scheduler.ts` | Scheduled task execution |
| `src/ipc.ts` | Host-container IPC watcher |
| `src/router.ts` | Message formatting and channel lookup |
| `src/config.ts` | Environment-driven configuration |
| `src/types.ts` | Core interfaces |
| `src/shared-prompt.ts` | Shared system prompt fragments (SHARED_RESOURCE_PROMPT, X_INTEGRATION_PROMPT) |
| `src/channels/registry.ts` | Channel factory pattern |
| `src/channels/*.ts` | Channel implementations |
| `src/management/server.ts` | WebSocket ManagementServer (sdk mode) |
| `src/management/protocol.ts` | Frame types: auth, req, res, event |
| `src/management/handlers.ts` | Handler registry: chat.send, social.*, groups.*, files.* |
| `src/management/agent-runner.ts` | AgentRunner interface |
| `src/management/agent-runner-parser.ts` | Streaming sandwich-marker parser for agent-runner output |
| `src/management/social-publish.ts` | Social publish via XDK (x_post, x_reply, x_quote) |
| `src/management/discovery.ts` | DiscoveryEmitter: unregistered chat detection |
| `src/management/memory-sync.ts` | MemorySyncManager: shared memory file polling |
| `src/management/whatsapp-relay.ts` | WhatsAppPairingRelay: QR code relay for pairing |
| `src/management/groups-sync.ts` | GroupsSyncHandler: group list sync |
| `src/management/channel-status.ts` | ChannelStatusReporter: connection status |
| `container/Dockerfile` | Agent container image (cli mode) |
| `container/Dockerfile.ws` | K8s WebSocket container image (sdk mode, Chromium pre-installed) |
| `container/agent-runner/` | Pre-compiled TypeScript agent-runner with stdin IPC |
| `container/skills/` | Container-loaded skills (X integration, browser, status, formatting) |
