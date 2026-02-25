# NanoClaw Architecture

A single Node.js process that routes messages from WhatsApp to Claude agents running in isolated Docker containers. Each chat group gets its own container, filesystem, and memory.

---

## System Overview

```mermaid
graph TB
    subgraph "Messaging Platforms"
        WA[WhatsApp<br/>Baileys library]
        TG[Telegram<br/>skill-based]
        DC[Discord<br/>skill-based]
    end

    subgraph "Host Process (Node.js)"
        ORCH[Orchestrator<br/>src/index.ts]
        DB[(SQLite<br/>store/messages.db)]
        GQ[GroupQueue<br/>concurrency control]
        SCHED[Task Scheduler<br/>60s poll]
        IPC_W[IPC Watcher<br/>1s poll]
    end

    subgraph "Container Pool (max 5)"
        C1[Container: main<br/>Claude Agent SDK]
        C2[Container: family<br/>Claude Agent SDK]
        C3[Container: work<br/>Claude Agent SDK]
    end

    WA -->|messages| ORCH
    TG -.->|messages| ORCH
    DC -.->|messages| ORCH
    ORCH -->|store| DB
    ORCH -->|poll 2s| DB
    ORCH -->|enqueue| GQ
    GQ -->|spawn| C1
    GQ -->|spawn| C2
    GQ -->|spawn| C3
    C1 -->|stdout markers| ORCH
    C1 -->|IPC files| IPC_W
    IPC_W -->|send_message<br/>schedule_task| ORCH
    SCHED -->|poll DB| DB
    SCHED -->|enqueue| GQ
    ORCH -->|response| WA
```

**Key design decisions:**
- **Polling over events** — The message loop polls SQLite every 2 seconds rather than using push-based events. This simplifies crash recovery: if the process dies, it resumes from the last stored cursor.
- **File-based IPC** — Containers communicate with the host via JSON files in per-group directories, not sockets or pipes. This is simple, debuggable, and naturally namespaced.
- **Container-per-invocation** — Each agent run gets a fresh container. State persists through mounted volumes (group folder, Claude sessions), not through long-lived processes.

---

## Message Lifecycle

This is the complete path a message takes from arrival to response.

```mermaid
sequenceDiagram
    participant U as User (WhatsApp)
    participant CH as WhatsApp Channel
    participant DB as SQLite
    participant ML as Message Loop
    participant GQ as GroupQueue
    participant CR as Container Runner
    participant AG as Agent (Container)
    participant MCP as MCP Server

    U->>CH: Send message
    CH->>DB: storeMessage()
    CH->>DB: storeChatMetadata()

    loop Every 2 seconds
        ML->>DB: getNewMessages(registeredJids, lastTimestamp)
        ML->>ML: Advance lastTimestamp
    end

    ML->>ML: Check trigger pattern
    alt Has trigger or is main group
        ML->>DB: getMessagesSince(chatJid, lastAgentTimestamp)
        ML->>ML: formatMessages() → XML
        ML->>GQ: enqueueMessageCheck(groupJid)
    end

    GQ->>GQ: Check concurrency (< 5 active?)
    GQ->>CR: processGroupMessages()
    CR->>CR: buildVolumeMounts()
    CR->>CR: readSecrets() from .env
    CR->>AG: docker run -i nanoclaw-agent
    CR->>AG: Write JSON to stdin (prompt + secrets)

    AG->>AG: Read input, configure SDK
    AG->>AG: query(prompt, options)
    AG-->>CR: ---OUTPUT_START--- result ---OUTPUT_END---

    CR->>CR: Parse streaming markers
    CR->>ML: onOutput(result)
    ML->>ML: stripInternalTags()
    ML->>CH: sendMessage(jid, text)
    CH->>U: Response

    Note over AG,MCP: Agent can also use MCP tools
    AG->>MCP: send_message / schedule_task
    MCP->>MCP: Write JSON to /workspace/ipc/
```

### Cursor Management and Crash Recovery

The orchestrator maintains two cursors per group:

| Cursor | Purpose | Updated When |
|--------|---------|-------------|
| `lastTimestamp` | Global — marks newest message the loop has seen | Immediately when messages are read (before processing) |
| `lastAgentTimestamp[jid]` | Per-group — marks newest message the agent has processed | After agent returns successfully |

Advancing `lastTimestamp` before processing means a crash won't skip messages. The `recoverPendingMessages()` function on startup checks for messages between `lastAgentTimestamp` and `lastTimestamp` to catch anything that was read but not yet processed.

---

## Container Isolation

Each group's container is an isolated Linux environment with carefully controlled access.

```mermaid
graph LR
    subgraph "Host Filesystem"
        PR[Project Root]
        GF["groups/{folder}/"]
        GL[groups/global/]
        SS["data/sessions/{folder}/.claude/"]
        IP["data/ipc/{folder}/"]
        AR["data/sessions/{folder}/agent-runner-src/"]
        GM["~/.gmail-mcp/"]
        GC["~/.gcal-mcp/"]
        EX["~/projects/"]
    end

    subgraph "Main Group Container"
        WP["/workspace/project (ro)"]
        WG["/workspace/group (rw)"]
        HC["/home/node/.claude (rw)"]
        HGM["/home/node/.gmail-mcp (rw)"]
        HGC["/home/node/.gcal-mcp (rw)"]
        WI["/workspace/ipc (rw)"]
        AS["/app/src (rw)"]
    end

    subgraph "Non-Main Container"
        WG2["/workspace/group (rw)"]
        WGL["/workspace/global (ro)"]
        HC2["/home/node/.claude (rw)"]
        HGM2["/home/node/.gmail-mcp (rw)"]
        HGC2["/home/node/.gcal-mcp (rw)"]
        WI2["/workspace/ipc (rw)"]
        AS2["/app/src (rw)"]
        WE["/workspace/extra/projects (varies)"]
    end

    PR -->|ro| WP
    GF -->|rw| WG
    SS -->|rw| HC
    GM -->|rw| HGM
    GC -->|rw| HGC
    IP -->|rw| WI
    AR -->|rw| AS

    GF -->|rw| WG2
    GL -->|ro| WGL
    SS -->|rw| HC2
    GM -->|rw| HGM2
    GC -->|rw| HGC2
    IP -->|rw| WI2
    AR -->|rw| AS2
    EX -->|validated| WE
```

### Mount Differences by Group Type

| Mount | Main Group | Non-Main Group |
|-------|-----------|----------------|
| `/workspace/project` | Project root (read-only) | Not mounted |
| `/workspace/group` | `groups/main/` (rw) | `groups/{folder}/` (rw) |
| `/workspace/global` | Not mounted | `groups/global/` (ro) |
| `/home/node/.claude` | Isolated sessions (rw) | Isolated sessions (rw) |
| `/workspace/ipc` | Isolated IPC (rw) | Isolated IPC (rw) |
| `/app/src` | Agent runner source (rw) | Agent runner source (rw) |
| `/home/node/.gmail-mcp` | `~/.gmail-mcp` (rw, conditional) | `~/.gmail-mcp` (rw, conditional) |
| `/home/node/.gcal-mcp` | `~/.gcal-mcp` (rw, conditional) | `~/.gcal-mcp` (rw, conditional) |
| `/workspace/extra/*` | Via allowlist | Via allowlist (forced ro if `nonMainReadOnly`) |

### Security Layers

```mermaid
graph TB
    subgraph "Layer 1: Container Boundary"
        A[Docker process isolation]
        B[Non-root user: node:node]
        C[Ephemeral containers with --rm]
    end

    subgraph "Layer 2: Mount Security"
        D[Read-only project root]
        E["Allowlist at ~/.config/nanoclaw/<br/>(outside project, tamper-proof)"]
        F["Blocked patterns:<br/>.ssh, .gnupg, .aws, .env,<br/>credentials, private_key, ..."]
        G[nonMainReadOnly enforcement]
    end

    subgraph "Layer 3: IPC Authorization"
        H[Per-group IPC directories]
        I[Main can message any registered JID]
        J[Non-main can only message own JID]
        K[Only main can register groups]
    end

    subgraph "Layer 4: Secrets"
        L[Passed via stdin JSON only]
        M[Never written to disk in container]
        N[Pre-tool-use hook strips from Bash env]
    end

    A --> D
    D --> H
    H --> L
```

### Credential Flow

Secrets (`CLAUDE_CODE_OAUTH_TOKEN`, `ANTHROPIC_API_KEY`) follow a strict path:

1. **Host**: Read from `.env` by `readEnvFile()` — never loaded into `process.env`
2. **Container spawn**: Passed as part of stdin JSON (`secrets` field)
3. **Container entrypoint**: Written to `/tmp/input.json`, read by agent-runner, file consumed
4. **Agent SDK**: Set in the SDK `env` option, not in `process.env`
5. **Bash tool**: Pre-tool-use hook injects `unset` commands to strip credentials before any shell execution

**Google API OAuth credentials** (Gmail, Calendar) follow a separate path — each service stores credentials in its own host directory (`~/.gmail-mcp/`, `~/.gcal-mcp/`) which is bind-mounted (read-write) into every container. The MCP servers read these directly and may refresh tokens in-place. Mounts are conditional: only added if the directory exists on the host. Both services share the same GCP OAuth client ID but maintain separate tokens with different scopes.

---

## Container Internals

```mermaid
graph TB
    subgraph "Docker Container"
        EP[entrypoint.sh]
        TSC["npx tsc → /tmp/dist/"]
        IDX[agent-runner/index.ts]
        SDK[Claude Agent SDK]
        MCP[IPC MCP Server<br/>stdio transport]
        GMAIL_MCP[Gmail MCP Server<br/>@gongrzhe/server-gmail-autoauth-mcp]
        GCAL_MCP[Calendar MCP Server<br/>@cocal/google-calendar-mcp]

        subgraph "Available Tools"
            BASH[Bash]
            FILE[Read / Write / Edit]
            GLOB[Glob / Grep]
            WEB[WebSearch / WebFetch]
            TEAMS[Task / TeamCreate]
            SKILL[Skill / TodoWrite]
            NCMCP["mcp__nanoclaw__*"]
            GMCP["mcp__gmail__*"]
            GCMCP["mcp__google-calendar__*"]
            AB[agent-browser<br/>CLI + Chromium]
        end
    end

    EP -->|1. compile| TSC
    EP -->|2. read stdin| IDX
    IDX -->|3. configure| SDK
    SDK -->|tools| BASH
    SDK -->|tools| FILE
    SDK -->|tools| WEB
    SDK -->|tools| NCMCP
    SDK -->|tools| GMCP
    SDK -->|tools| GCMCP
    NCMCP -->|stdio| MCP
    GMCP -->|stdio| GMAIL_MCP
    GCMCP -->|stdio| GCAL_MCP

    MCP -->|write file| IPC_MSG["/workspace/ipc/messages/*.json"]
    MCP -->|write file| IPC_TASK["/workspace/ipc/tasks/*.json"]
    GMAIL_MCP -->|OAuth| GOOGLE_API["Google APIs"]
    GCAL_MCP -->|OAuth| GOOGLE_API
```

### Agent Runner Query Loop

The agent runner doesn't exit after a single query. It stays alive to handle follow-up messages via IPC.

```mermaid
stateDiagram-v2
    [*] --> ReadStdin: Container starts
    ReadStdin --> ConfigureSDK: Parse JSON input
    ConfigureSDK --> DrainIPC: Check for queued messages
    DrainIPC --> RunQuery: Pass prompt to SDK

    RunQuery --> EmitOutput: Agent produces result
    EmitOutput --> PollIPC: Wait for follow-up

    PollIPC --> RunQuery: New message file found
    PollIPC --> PollIPC: No message (sleep 500ms)
    PollIPC --> Shutdown: _close sentinel found

    Shutdown --> [*]: Exit container
```

**IPC input polling** (`/workspace/ipc/input/`):
- JSON files: `{type: "message", text: "..."}` — new user messages piped in by host
- Sentinel: `_close` file — signals the container to wind down gracefully
- Poll interval: 500ms

### MCP Tools Available to Agents

The `ipc-mcp-stdio.ts` server exposes these tools to the Claude Agent SDK:

| Tool | Description | Authorization |
|------|-------------|--------------|
| `send_message` | Send a message to the chat immediately | Main → any registered JID; others → own JID only |
| `schedule_task` | Create a recurring or one-time task | Main → any group; others → own group only |
| `list_tasks` | List scheduled tasks | Main sees all; others see own group only |
| `pause_task` | Pause a scheduled task | Own group or main |
| `resume_task` | Resume a paused task | Own group or main |
| `cancel_task` | Cancel and delete a task | Own group or main |
| `register_group` | Register a new WhatsApp group for the bot | Main only |

---

## Concurrency: GroupQueue

The GroupQueue serializes container execution per group (one container at a time per group) while parallelizing across groups up to a global limit.

```mermaid
graph TB
    subgraph "GroupQueue"
        SLOTS["Active Slots: 5 max"]
        WAIT["Waiting Queue"]
    end

    subgraph "Per-Group State"
        G1["Group A<br/>active: true<br/>idleWaiting: false"]
        G2["Group B<br/>active: true<br/>pendingTasks: 2"]
        G3["Group C<br/>active: false<br/>pendingMessages: true"]
    end

    MSG1[New message for A] -->|pipe to active container| G1
    MSG2[New message for C] -->|enqueue| WAIT
    TASK1[Scheduled task for B] -->|queue behind active| G2

    G1 -->|occupies slot| SLOTS
    G2 -->|occupies slot| SLOTS
    WAIT -->|when slot frees| G3
```

### Enqueueing Logic

```
enqueueMessageCheck(groupJid):
  if group has active container:
    mark pendingMessages = true        # will be drained after current work
  else if activeCount >= MAX_CONCURRENT:
    add to waitingGroups queue
  else:
    start container immediately

enqueueTask(groupJid, taskId, fn):
  if group has active container:
    append to pendingTasks
    if container is idle-waiting:
      close stdin → preempt idle to start task
  else if activeCount >= MAX_CONCURRENT:
    add to waitingGroups queue
  else:
    start task immediately
```

### Drain Priority

When a container finishes, the queue drains in this order:
1. **Pending tasks for same group** (tasks won't be re-discovered by scheduler)
2. **Pending messages for same group** (new messages arrived during execution)
3. **Waiting groups** (tasks first, then messages)

### Retry Strategy

On container failure:
- Base delay: 5 seconds
- Backoff: exponential — `5s × 2^(retryCount-1)` → 5s, 10s, 20s, 40s, 80s
- Max retries: 5
- After max: drop (next incoming message triggers fresh attempt)

---

## Idle Timeout and Container Lifecycle

```mermaid
sequenceDiagram
    participant H as Host (GroupQueue)
    participant C as Container (Agent)

    H->>C: Spawn container with initial prompt
    C-->>H: OUTPUT_START...result...OUTPUT_END
    H->>H: Reset idle timer (30 min)

    Note over H,C: User sends follow-up within 30 min
    H->>C: Write message to /workspace/ipc/input/
    C->>C: Poll detects file, runs new query
    C-->>H: OUTPUT_START...result...OUTPUT_END
    H->>H: Reset idle timer

    Note over H,C: 30 minutes of silence
    H->>C: Write _close sentinel to /workspace/ipc/input/
    C->>C: Poll detects _close, exits gracefully
    C-->>H: Container exits (code 0)
    H->>H: Free slot, drain queue
```

**Timeout values:**
- **Idle timeout**: 30 minutes (configurable via `IDLE_TIMEOUT`)
- **Hard timeout**: `max(group.timeout || CONTAINER_TIMEOUT, IDLE_TIMEOUT + 30s)`
- **Timer resets**: On each streaming output from container
- **Timer does NOT reset**: On stderr (SDK debug logs)

---

## Scheduled Tasks

```mermaid
flowchart TD
    POLL[Scheduler polls DB<br/>every 60 seconds] --> DUE{Due tasks?}
    DUE -->|No| POLL
    DUE -->|Yes| ENQ[Enqueue via GroupQueue]
    ENQ --> SPAWN[Spawn container<br/>with task prompt]
    SPAWN --> RUN[Agent executes task]
    RUN --> OUTPUT[Stream output to chat]
    OUTPUT --> LOG[Log run in task_run_logs]
    LOG --> NEXT{Calculate next_run}
    NEXT -->|cron| CRON[Parse next occurrence]
    NEXT -->|interval| INT[now + milliseconds]
    NEXT -->|once| ONCE[Mark completed]
    CRON --> UPDATE[Update DB]
    INT --> UPDATE
    ONCE --> UPDATE
    UPDATE --> POLL
```

### Schedule Types

| Type | Value Format | Example | Repeats |
|------|-------------|---------|---------|
| `cron` | Cron expression | `0 9 * * 1-5` | Yes, until paused/cancelled |
| `interval` | Milliseconds | `3600000` | Yes, every N ms |
| `once` | ISO timestamp | `2026-03-01T14:30:00Z` | No, auto-completes |

### Context Modes

| Mode | Session | Use Case |
|------|---------|----------|
| `isolated` | New session each run | Stateless tasks (weather reports, reminders) |
| `group` | Reuses group's session | Stateful tasks (project tracking, research) |

---

## Database Schema

```mermaid
erDiagram
    chats {
        text jid PK
        text name
        text last_message_time
        text channel
        integer is_group
    }

    messages {
        text id PK
        text chat_jid PK
        text sender
        text sender_name
        text content
        text timestamp
        integer is_from_me
        integer is_bot_message
    }

    registered_groups {
        text jid PK
        text name
        text folder UK
        text trigger_pattern
        text added_at
        text container_config
        integer requires_trigger
    }

    sessions {
        text group_folder PK
        text session_id
    }

    scheduled_tasks {
        text id PK
        text group_folder
        text chat_jid
        text prompt
        text schedule_type
        text schedule_value
        text context_mode
        text next_run
        text last_run
        text last_result
        text status
        text created_at
    }

    task_run_logs {
        integer id PK
        text task_id FK
        text run_at
        integer duration_ms
        text status
        text result
        text error
    }

    router_state {
        text key PK
        text value
    }

    chats ||--o{ messages : "has"
    registered_groups ||--o{ sessions : "has"
    scheduled_tasks ||--o{ task_run_logs : "has"
```

### Key Queries

| Operation | Function | Description |
|-----------|----------|-------------|
| New messages | `getNewMessages(jids, lastTimestamp)` | Messages newer than cursor for registered groups |
| Context gathering | `getMessagesSince(chatJid, since)` | All messages since last agent run (for prompt context) |
| Due tasks | `getDueTasks()` | Tasks with `status='active'` and `next_run <= now` |
| Store message | `storeMessage(msg)` | Insert or replace (deduplication by id + chat_jid) |

---

## Channel Abstraction

All messaging platforms implement the same interface:

```typescript
interface Channel {
  name: string;
  connect(): Promise<void>;
  sendMessage(jid: string, text: string): Promise<void>;
  isConnected(): boolean;
  ownsJid(jid: string): boolean;
  disconnect(): Promise<void>;
  setTyping?(jid: string, isTyping: boolean): Promise<void>;
}
```

**JID (Jabber ID) formats:**

| Platform | Individual | Group |
|----------|-----------|-------|
| WhatsApp | `14155551234@s.whatsapp.net` | `120363336345536173@g.us` |
| Telegram | `tg:chat-id` | `tg:group-id` |
| Discord | `dc:user-id` | `dc:channel-id` |

Additional channels (Telegram, Discord, Gmail) are added via Claude Code skills (`/add-telegram`, etc.) — they aren't part of the base codebase.

---

## File-Based IPC

Containers communicate with the host through JSON files in namespaced directories.

```mermaid
graph LR
    subgraph "Container → Host"
        M["messages/{uuid}.json<br/>{type: 'message', chatJid, text}"]
        T["tasks/{uuid}.json<br/>{type: 'schedule_task', prompt, ...}"]
    end

    subgraph "Host → Container"
        I["input/{uuid}.json<br/>{type: 'message', text}"]
        CL["input/_close<br/>(sentinel file)"]
    end

    subgraph "Snapshots (Host writes, Container reads)"
        CT["current_tasks.json"]
        AG["available_groups.json"]
    end

    M -->|IPC Watcher 1s| HOST[Host Orchestrator]
    T -->|IPC Watcher 1s| HOST
    HOST -->|piped message| I
    HOST -->|idle timeout| CL
    HOST -->|on container start| CT
    HOST -->|on container start| AG
```

All paths are under `data/ipc/{groupFolder}/`. The per-group namespacing prevents cross-group privilege escalation.

---

## Memory Hierarchy

```mermaid
graph TB
    subgraph "Loaded by All Groups"
        GLOBAL["groups/global/CLAUDE.md<br/>Global memory (read-only for non-main)"]
    end

    subgraph "Per-Group Memory"
        MAIN["groups/main/CLAUDE.md<br/>Main group memory + admin context"]
        FAM["groups/family/CLAUDE.md<br/>Family group memory"]
        WORK["groups/work/CLAUDE.md<br/>Work group memory"]
    end

    subgraph "Persistent Sessions"
        S1["data/sessions/main/.claude/<br/>Claude Code sessions, skills, settings"]
        S2["data/sessions/family/.claude/"]
        S3["data/sessions/work/.claude/"]
    end

    GLOBAL -.->|system prompt| MAIN
    GLOBAL -.->|system prompt| FAM
    GLOBAL -.->|system prompt| WORK

    MAIN --- S1
    FAM --- S2
    WORK --- S3
```

- **Global CLAUDE.md**: Loaded as the system prompt for all agent invocations. Contains identity, personality, formatting rules, and capabilities shared across all groups.
- **Group CLAUDE.md**: Each group's working directory contains its own CLAUDE.md with group-specific context, preferences, and notes.
- **Claude sessions**: The `.claude/` directory persists Claude Code's auto-memory, skills, and session transcripts between container runs.
- **Conversations archive**: The agent-runner's `PreCompactHook` archives full conversation transcripts to `groups/{folder}/conversations/` as markdown files.

---

## Project Layout

```
nanoclaw/
├── src/                          # Host process source
│   ├── index.ts                  # Orchestrator: state, message loop, agent invocation
│   ├── channels/
│   │   └── whatsapp.ts           # WhatsApp via Baileys (LID translation, group sync)
│   ├── config.ts                 # Constants: paths, timeouts, trigger pattern
│   ├── types.ts                  # TypeScript interfaces (Channel, RegisteredGroup, etc.)
│   ├── db.ts                     # SQLite queries (messages, chats, tasks, sessions)
│   ├── router.ts                 # XML message formatting, outbound routing
│   ├── container-runner.ts       # Container spawn, volume mounts, output parsing
│   ├── container-runtime.ts      # Docker/Apple Container abstraction
│   ├── group-queue.ts            # Per-group serialization, global concurrency
│   ├── group-folder.ts           # Folder validation (prevents path traversal)
│   ├── mount-security.ts         # Allowlist validation for additional mounts
│   ├── task-scheduler.ts         # Cron/interval/once task execution
│   ├── ipc.ts                    # File-based IPC watcher (1s poll)
│   ├── env.ts                    # .env reader (never loads into process.env)
│   └── logger.ts                 # Pino logger
│
├── container/                    # Agent container image
│   ├── Dockerfile                # node:22-slim + Chromium + claude-code + agent-browser
│   ├── build.sh                  # Build script
│   ├── agent-runner/             # Code that runs INSIDE the container
│   │   ├── src/
│   │   │   ├── index.ts          # Agent entry: stdin → SDK query → stdout markers
│   │   │   └── ipc-mcp-stdio.ts  # MCP server (send_message, schedule_task, etc.)
│   │   └── package.json          # @anthropic-ai/claude-agent-sdk, zod, etc.
│   └── skills/
│       └── agent-browser/        # Browser automation skill (Playwright CLI)
│
├── groups/                       # Per-group working directories
│   ├── global/CLAUDE.md          # Shared memory across all groups
│   └── main/CLAUDE.md            # Main channel memory + admin context
│
├── data/                         # Runtime state (not in git)
│   ├── sessions/{folder}/.claude/ # Per-group Claude Code sessions
│   └── ipc/{folder}/             # Per-group IPC directories
│
├── store/                        # Persistent storage (not in git)
│   ├── auth/                     # WhatsApp credentials (Baileys)
│   └── messages.db               # SQLite database
│
├── setup/                        # Setup steps (used by /setup skill)
├── docs/                         # Documentation
└── .claude/skills/               # Claude Code skills (/setup, /customize, /debug, etc.)
```

---

## Key Configuration

| Variable | Default | Description |
|----------|---------|-------------|
| `ASSISTANT_NAME` | `Andy` | Trigger word and response prefix |
| `ASSISTANT_HAS_OWN_NUMBER` | `false` | If true, bot has its own phone number |
| `POLL_INTERVAL` | `2000` ms | Message loop poll frequency |
| `IDLE_TIMEOUT` | `1800000` ms (30 min) | Keep container alive after last output |
| `CONTAINER_TIMEOUT` | `1800000` ms (30 min) | Hard container timeout |
| `MAX_CONCURRENT_CONTAINERS` | `5` | Global concurrency limit |
| `IPC_POLL_INTERVAL` | `1000` ms | IPC watcher frequency (host side) |
| `SCHEDULER_POLL_INTERVAL` | `60000` ms | Scheduled task check frequency |
| `CONTAINER_MAX_OUTPUT_SIZE` | `10485760` (10 MB) | Max accumulated stdout/stderr |
| `TRIGGER_PATTERN` | `^@{name}\b` (case-insensitive) | Regex for activating the bot |

---

## Startup Sequence

```mermaid
sequenceDiagram
    participant P as Process
    participant DB as SQLite
    participant CR as Container Runtime
    participant WA as WhatsApp
    participant ML as Message Loop
    participant SC as Scheduler
    participant IPC as IPC Watcher

    P->>DB: initDatabase() + migrations
    P->>DB: loadState() → cursors, sessions, groups
    P->>CR: ensureContainerRuntimeRunning()
    P->>CR: cleanupOrphans() → stop nanoclaw-* containers
    P->>WA: channel.connect()
    WA-->>P: onFirstOpen callback
    P->>P: recoverPendingMessages()
    P->>ML: startMessageLoop() → polls every 2s
    P->>SC: startSchedulerLoop() → polls every 60s
    P->>IPC: startIpcWatcher() → polls every 1s
```

### Shutdown

The process handles `SIGTERM`/`SIGINT` gracefully:
1. Disconnects all channels (WhatsApp)
2. Calls `queue.shutdown(10000)` — **detaches** containers (doesn't kill them)
3. Containers finish on their own via their timeout mechanisms
4. Prevents a host restart from killing working agents mid-response
