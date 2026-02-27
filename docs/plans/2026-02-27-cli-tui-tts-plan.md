# CLI TUI + TTS Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add a Textual-based terminal UI for chatting with NanoClaw agents, with bidirectional voice support (Whisper STT + OpenAI TTS) and multi-tier cost management.

**Architecture:** A lightweight HTTP API server inside NanoClaw exposes endpoints for sending messages (POST) and streaming responses (SSE). A virtual CLI Channel implements the `Channel` interface to route messages through the existing orchestrator. A separate Python/Textual TUI application connects as a client. TTS runs server-side using OpenAI's API.

**Tech Stack:** Node.js (HTTP server, TTS service, cost tracker), Python 3.12+ with Textual (TUI), OpenAI API (TTS), SQLite (cost tracking), SSE (response streaming)

**Design doc:** `docs/plans/2026-02-27-cli-tui-tts-design.md`

---

## Phase 1: Server-Side (Node.js/TypeScript)

### Task 1: CLI Channel (Virtual Routing Adapter)

**Files:**
- Create: `src/channels/cli.ts`
- Create: `src/channels/cli.test.ts`
- Modify: `src/types.ts` (add `ChannelOpts` base type)

**Context:** The CLI Channel implements the `Channel` interface (defined in `src/types.ts:81-90`) but does no I/O of its own. Its `sendMessage()` pushes responses into a callback (which the HTTP API will use to feed SSE streams). It owns JIDs starting with `cli:`. See `src/channels/whatsapp.ts` for the existing pattern.

**Step 1: Write the failing test**

```typescript
// src/channels/cli.test.ts
import { describe, it, expect, vi } from 'vitest';
import { CliChannel } from './cli.js';

describe('CliChannel', () => {
  const mockOpts = {
    onMessage: vi.fn(),
    onChatMetadata: vi.fn(),
    registeredGroups: vi.fn(() => ({})),
  };

  it('owns cli: JIDs', () => {
    const ch = new CliChannel(mockOpts);
    expect(ch.ownsJid('cli:main')).toBe(true);
    expect(ch.ownsJid('cli:work')).toBe(true);
    expect(ch.ownsJid('123@g.us')).toBe(false);
  });

  it('is always connected after connect()', async () => {
    const ch = new CliChannel(mockOpts);
    expect(ch.isConnected()).toBe(false);
    await ch.connect();
    expect(ch.isConnected()).toBe(true);
  });

  it('calls onOutbound when sendMessage is called', async () => {
    const onOutbound = vi.fn();
    const ch = new CliChannel(mockOpts);
    ch.setOutboundHandler(onOutbound);
    await ch.connect();
    await ch.sendMessage('cli:main', 'Hello from Lulu');
    expect(onOutbound).toHaveBeenCalledWith('cli:main', 'Hello from Lulu');
  });

  it('injects messages via injectMessage', () => {
    const ch = new CliChannel(mockOpts);
    ch.injectMessage('cli:main', 'user1', 'User One', 'Hello Lulu');
    expect(mockOpts.onMessage).toHaveBeenCalledWith(
      'cli:main',
      expect.objectContaining({
        chat_jid: 'cli:main',
        sender: 'user1',
        sender_name: 'User One',
        content: 'Hello Lulu',
      }),
    );
  });
});
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run src/channels/cli.test.ts`
Expected: FAIL — module `./cli.js` does not exist

**Step 3: Extract `ChannelOpts` base type**

In `src/types.ts`, add a base opts type after the `Channel` interface (around line 90). Both `WhatsAppChannelOpts` and the new CLI channel will use it:

```typescript
export interface ChannelOpts {
  onMessage: OnInboundMessage;
  onChatMetadata: OnChatMetadata;
  registeredGroups: () => Record<string, RegisteredGroup>;
}
```

Then update `src/channels/whatsapp.ts` to import and extend `ChannelOpts` instead of defining its own opts interface:

```typescript
import { ChannelOpts } from '../types.js';
export interface WhatsAppChannelOpts extends ChannelOpts {}
```

**Step 4: Implement the CLI Channel**

```typescript
// src/channels/cli.ts
import { randomUUID } from 'node:crypto';
import type { Channel, ChannelOpts } from '../types.js';

export type OutboundHandler = (jid: string, text: string) => void;

export class CliChannel implements Channel {
  name = 'cli';
  private connected = false;
  private opts: ChannelOpts;
  private onOutbound: OutboundHandler | null = null;

  constructor(opts: ChannelOpts) {
    this.opts = opts;
  }

  setOutboundHandler(handler: OutboundHandler): void {
    this.onOutbound = handler;
  }

  async connect(): Promise<void> {
    this.connected = true;
  }

  async sendMessage(jid: string, text: string): Promise<void> {
    this.onOutbound?.(jid, text);
  }

  isConnected(): boolean {
    return this.connected;
  }

  ownsJid(jid: string): boolean {
    return jid.startsWith('cli:');
  }

  async disconnect(): Promise<void> {
    this.connected = false;
  }

  /** Called by the HTTP API to inject an inbound message into the orchestrator. */
  injectMessage(
    chatJid: string,
    sender: string,
    senderName: string,
    content: string,
  ): void {
    this.opts.onMessage(chatJid, {
      id: randomUUID(),
      chat_jid: chatJid,
      sender,
      sender_name: senderName,
      content,
      timestamp: new Date().toISOString(),
      is_from_me: false,
      is_bot_message: false,
    });
  }
}
```

**Step 5: Run tests to verify they pass**

Run: `npx vitest run src/channels/cli.test.ts`
Expected: All 4 tests PASS

**Step 6: Commit**

```bash
git add src/channels/cli.ts src/channels/cli.test.ts src/types.ts src/channels/whatsapp.ts
git commit -m "feat: add virtual CLI channel for TUI routing"
```

---

### Task 2: TTS Service

**Files:**
- Create: `src/tts.ts`
- Create: `src/tts.test.ts`
- Create: `config/tts-instructions.txt`

**Context:** Follow the same pattern as `src/transcription.ts` — dynamic `import('openai')`, lazy `readEnvFile(['OPENAI_API_KEY'])`, and a clean async API. The TTS service takes text and returns an audio buffer. See `src/transcription.ts:18-53` for the OpenAI client setup pattern.

**Step 1: Write the failing test**

```typescript
// src/tts.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { synthesizeSpeech, type TtsConfig } from './tts.js';

// Mock the openai module
vi.mock('openai', () => {
  const mockArrayBuffer = new ArrayBuffer(8);
  return {
    default: class {
      audio = {
        speech: {
          create: vi.fn().mockResolvedValue({
            arrayBuffer: () => Promise.resolve(mockArrayBuffer),
          }),
        },
      };
    },
  };
});

// Mock env.ts
vi.mock('./env.js', () => ({
  readEnvFile: vi.fn(() => ({ OPENAI_API_KEY: 'test-key' })),
}));

describe('synthesizeSpeech', () => {
  it('returns a buffer of audio data', async () => {
    const result = await synthesizeSpeech('Hello world');
    expect(result).not.toBeNull();
    expect(result!.audio).toBeInstanceOf(Buffer);
  });

  it('returns null when API key is missing', async () => {
    const { readEnvFile } = await import('./env.js');
    vi.mocked(readEnvFile).mockReturnValueOnce({});
    const result = await synthesizeSpeech('Hello');
    expect(result).toBeNull();
  });

  it('accepts custom config', async () => {
    const config: TtsConfig = {
      voice: 'marin',
      model: 'gpt-4o-mini-tts',
      instructions: 'Speak calmly',
    };
    const result = await synthesizeSpeech('Hello', config);
    expect(result).not.toBeNull();
  });
});
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run src/tts.test.ts`
Expected: FAIL — module `./tts.js` does not exist

**Step 3: Implement the TTS service**

```typescript
// src/tts.ts
import fs from 'node:fs';
import path from 'node:path';
import { readEnvFile } from './env.js';
import { logger } from './logger.js';

export interface TtsConfig {
  voice?: string;
  model?: string;
  instructions?: string;
  responseFormat?: 'opus' | 'mp3' | 'aac' | 'flac' | 'wav' | 'pcm';
}

export interface TtsResult {
  audio: Buffer;
  characterCount: number;
}

const DEFAULT_CONFIG: TtsConfig = {
  voice: 'marin',
  model: 'gpt-4o-mini-tts',
  responseFormat: 'opus',
};

let cachedInstructions: string | null = null;

function loadInstructions(): string {
  if (cachedInstructions !== null) return cachedInstructions;
  const instructionsFile =
    process.env.OPENAI_TTS_INSTRUCTIONS_FILE ||
    path.join(process.cwd(), 'config', 'tts-instructions.txt');
  try {
    cachedInstructions = fs.readFileSync(instructionsFile, 'utf-8').trim();
  } catch {
    cachedInstructions = '';
  }
  return cachedInstructions;
}

export function isTtsEnabled(): boolean {
  const env = readEnvFile(['OPENAI_TTS_ENABLED']);
  return env.OPENAI_TTS_ENABLED !== 'false';
}

export async function synthesizeSpeech(
  text: string,
  config?: TtsConfig,
): Promise<TtsResult | null> {
  const env = readEnvFile(['OPENAI_API_KEY', 'OPENAI_TTS_VOICE', 'OPENAI_TTS_MODEL']);
  const apiKey = env.OPENAI_API_KEY;
  if (!apiKey) {
    logger.warn('OPENAI_API_KEY not set — TTS unavailable');
    return null;
  }

  const voice = config?.voice || env.OPENAI_TTS_VOICE || DEFAULT_CONFIG.voice!;
  const model = config?.model || env.OPENAI_TTS_MODEL || DEFAULT_CONFIG.model!;
  const instructions = config?.instructions || loadInstructions();
  const responseFormat = config?.responseFormat || DEFAULT_CONFIG.responseFormat!;

  try {
    const OpenAI = (await import('openai')).default;
    const openai = new OpenAI({ apiKey });

    const response = await openai.audio.speech.create({
      model,
      voice,
      input: text,
      response_format: responseFormat,
      ...(instructions ? { instructions } : {}),
    });

    const arrayBuffer = await response.arrayBuffer();
    return {
      audio: Buffer.from(arrayBuffer),
      characterCount: text.length,
    };
  } catch (err) {
    logger.error({ err }, 'TTS synthesis failed');
    return null;
  }
}
```

**Step 4: Create the TTS instructions file**

```text
Voice Affect: Calm, composed, and reassuring; project quiet authority and confidence.
Tone: Sincere, empathetic, and gently authoritative—express genuine apology while conveying competence.
Pacing: Steady and moderate; unhurried enough to communicate care, yet efficient enough to demonstrate professionalism.
Emotion: Genuine empathy and understanding; speak with warmth, especially during apologies.
Pronunciation: Clear and precise, emphasizing key reassurances ("smoothly," "quickly," "promptly") to reinforce confidence.
Pauses: Brief pauses after offering assistance or requesting details, highlighting willingness to listen and support.
```

**Step 5: Run tests to verify they pass**

Run: `npx vitest run src/tts.test.ts`
Expected: All 3 tests PASS

**Step 6: Commit**

```bash
git add src/tts.ts src/tts.test.ts config/tts-instructions.txt
git commit -m "feat: add TTS service using OpenAI speech API"
```

---

### Task 3: Cost Tracker

**Files:**
- Create: `src/cost-tracker.ts`
- Create: `src/cost-tracker.test.ts`
- Modify: `src/db.ts` (add `tts_usage` and `tts_budgets` tables, export `getDb()`)

**Context:** The cost tracker records every TTS API call, computes running totals by period (daily/weekly/monthly), and enforces budget limits. It uses SQLite tables (see `src/db.ts` for migration patterns — `CREATE TABLE IF NOT EXISTS` + try/catch ALTER). Budget auto-derivation: if only monthly is set, daily = monthly / 30.44, weekly = monthly / 4.35.

**Step 1: Write the failing test**

```typescript
// src/cost-tracker.test.ts
import { describe, it, expect, beforeEach } from 'vitest';
import {
  recordTtsUsage,
  getTtsUsageSummary,
  setBudget,
  getBudgets,
  checkBudget,
} from './cost-tracker.js';

describe('CostTracker', () => {
  // Tests will use a fresh in-memory DB via test setup

  it('records TTS usage', () => {
    recordTtsUsage({
      characters: 500,
      costEstimate: 0.0075,
      model: 'gpt-4o-mini-tts',
      messageId: 'msg-1',
    });
    const summary = getTtsUsageSummary();
    expect(summary.today.characters).toBe(500);
    expect(summary.today.cost).toBeCloseTo(0.0075);
  });

  it('sets and retrieves budgets', () => {
    setBudget('monthly', 10.0);
    const budgets = getBudgets();
    expect(budgets.monthly).toBe(10.0);
    // Auto-derived values
    expect(budgets.weekly).toBeCloseTo(10.0 / 4.35, 1);
    expect(budgets.daily).toBeCloseTo(10.0 / 30.44, 1);
  });

  it('reports budget status with alert tier', () => {
    setBudget('daily', 1.0);
    recordTtsUsage({ characters: 1000, costEstimate: 0.85, model: 'gpt-4o-mini-tts', messageId: 'msg-2' });
    const status = checkBudget();
    expect(status.daily!.percentUsed).toBeCloseTo(85);
    expect(status.daily!.alertTier).toBe('warning'); // 80-95% = warning
  });

  it('blocks TTS when budget exceeded', () => {
    setBudget('daily', 0.50);
    recordTtsUsage({ characters: 5000, costEstimate: 0.55, model: 'gpt-4o-mini-tts', messageId: 'msg-3' });
    const status = checkBudget();
    expect(status.daily!.alertTier).toBe('exceeded');
    expect(status.ttsAllowed).toBe(false);
  });
});
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run src/cost-tracker.test.ts`
Expected: FAIL — module `./cost-tracker.js` does not exist

**Step 3: Add DB tables in `src/db.ts`**

Inside the `createSchema()` function, after the existing `CREATE TABLE IF NOT EXISTS` statements, add:

```sql
CREATE TABLE IF NOT EXISTS tts_usage (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  timestamp TEXT NOT NULL DEFAULT (datetime('now')),
  characters INTEGER NOT NULL,
  cost_estimate REAL NOT NULL,
  model TEXT NOT NULL,
  message_id TEXT
);

CREATE TABLE IF NOT EXISTS tts_budgets (
  period TEXT PRIMARY KEY,
  amount REAL NOT NULL,
  is_auto_derived INTEGER DEFAULT 0
);
```

Also export `getDb()` from `db.ts` so the cost tracker can access the database instance:

```typescript
export function getDb(): Database.Database {
  return db;
}
```

**Step 4: Implement cost tracker**

```typescript
// src/cost-tracker.ts
import { getDb } from './db.js';
import { logger } from './logger.js';

export interface TtsUsageRecord {
  characters: number;
  costEstimate: number;
  model: string;
  messageId?: string;
}

export interface UsageSummary {
  today: { characters: number; cost: number; count: number };
  thisWeek: { characters: number; cost: number; count: number };
  thisMonth: { characters: number; cost: number; count: number };
}

export interface BudgetPeriodStatus {
  budget: number;
  spent: number;
  percentUsed: number;
  alertTier: 'ok' | 'info' | 'warning' | 'critical' | 'exceeded';
}

export interface BudgetStatus {
  daily: BudgetPeriodStatus | null;
  weekly: BudgetPeriodStatus | null;
  monthly: BudgetPeriodStatus | null;
  ttsAllowed: boolean;
}

function alertTier(percent: number): BudgetPeriodStatus['alertTier'] {
  if (percent >= 100) return 'exceeded';
  if (percent >= 95) return 'critical';
  if (percent >= 80) return 'warning';
  if (percent >= 60) return 'info';
  return 'ok';
}

export function recordTtsUsage(record: TtsUsageRecord): void {
  const db = getDb();
  db.prepare(
    `INSERT INTO tts_usage (characters, cost_estimate, model, message_id)
     VALUES (?, ?, ?, ?)`,
  ).run(record.characters, record.costEstimate, record.model, record.messageId ?? null);
}

export function getTtsUsageSummary(): UsageSummary {
  const db = getDb();
  const query = (where: string) =>
    db
      .prepare(
        `SELECT COALESCE(SUM(characters), 0) as characters,
                COALESCE(SUM(cost_estimate), 0) as cost,
                COUNT(*) as count
         FROM tts_usage WHERE ${where}`,
      )
      .get() as { characters: number; cost: number; count: number };

  return {
    today: query(`date(timestamp) = date('now')`),
    thisWeek: query(`timestamp >= datetime('now', 'weekday 0', '-7 days')`),
    thisMonth: query(`strftime('%Y-%m', timestamp) = strftime('%Y-%m', 'now')`),
  };
}

export function setBudget(
  period: 'daily' | 'weekly' | 'monthly',
  amount: number,
): void {
  const db = getDb();
  const upsert = db.prepare(
    `INSERT OR REPLACE INTO tts_budgets (period, amount, is_auto_derived) VALUES (?, ?, ?)`,
  );

  // Set the explicit budget
  upsert.run(period, amount, 0);

  // Auto-derive other periods
  if (period === 'monthly') {
    upsert.run('weekly', amount / 4.35, 1);
    upsert.run('daily', amount / 30.44, 1);
  } else if (period === 'weekly') {
    upsert.run('daily', amount / 7, 1);
  }
  // Don't auto-derive upward (daily doesn't imply weekly/monthly)
}

export function getBudgets(): Record<string, number> {
  const db = getDb();
  const rows = db
    .prepare(`SELECT period, amount FROM tts_budgets`)
    .all() as Array<{ period: string; amount: number }>;
  const budgets: Record<string, number> = {};
  for (const row of rows) budgets[row.period] = row.amount;
  return budgets;
}

export function checkBudget(): BudgetStatus {
  const budgets = getBudgets();
  const usage = getTtsUsageSummary();

  function periodStatus(
    period: 'daily' | 'weekly' | 'monthly',
  ): BudgetPeriodStatus | null {
    const budget = budgets[period];
    if (budget == null) return null;
    const spentKey =
      period === 'daily' ? 'today' : period === 'weekly' ? 'thisWeek' : 'thisMonth';
    const spent = usage[spentKey].cost;
    const percentUsed = budget > 0 ? (spent / budget) * 100 : 0;
    return { budget, spent, percentUsed, alertTier: alertTier(percentUsed) };
  }

  const daily = periodStatus('daily');
  const weekly = periodStatus('weekly');
  const monthly = periodStatus('monthly');

  // TTS is blocked if ANY active period is exceeded
  const ttsAllowed = [daily, weekly, monthly].every(
    (s) => s === null || s.alertTier !== 'exceeded',
  );

  return { daily, weekly, monthly, ttsAllowed };
}
```

**Step 5: Run tests to verify they pass**

Run: `npx vitest run src/cost-tracker.test.ts`
Expected: All 4 tests PASS

Note: Tests may need a test setup file that initializes an in-memory SQLite database. Check if the existing test setup handles this; if not, create a `beforeEach` that calls `initDatabase()` with an in-memory DB or use a temp file.

**Step 6: Commit**

```bash
git add src/cost-tracker.ts src/cost-tracker.test.ts src/db.ts
git commit -m "feat: add TTS cost tracker with multi-tier budgets"
```

---

### Task 4: HTTP API Server

**Files:**
- Create: `src/api-server.ts`
- Create: `src/api-server.test.ts`

**Context:** Uses Node.js built-in `node:http` (no new dependencies). Listens on `127.0.0.1:$NANOCLAW_API_PORT` (default 3000). All requests require `Authorization: Bearer <NANOCLAW_API_KEY>`. SSE stream for real-time responses. The API bridges between HTTP clients and the CLI Channel.

**Step 1: Write the failing test**

```typescript
// src/api-server.test.ts
import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import http from 'node:http';
import { createApiServer } from './api-server.js';

// Test helpers
function request(
  method: string,
  path: string,
  body?: object,
  apiKey = 'test-key',
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    };
    if (apiKey) {
      headers['Authorization'] = `Bearer ${apiKey}`;
    }
    const req = http.request(
      { hostname: '127.0.0.1', port: 13579, path, method, headers },
      (res) => {
        let data = '';
        res.on('data', (chunk) => (data += chunk));
        res.on('end', () => resolve({ status: res.statusCode!, body: data }));
      },
    );
    req.on('error', reject);
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

describe('API Server', () => {
  let server: http.Server;

  beforeAll(async () => {
    server = createApiServer({
      port: 13579,
      apiKey: 'test-key',
      cliChannel: {
        injectMessage: vi.fn(),
      } as any,
      getGroups: vi.fn(() => ({})),
      getHistory: vi.fn(() => []),
    });
    await new Promise<void>((r) => server.listen(13579, '127.0.0.1', r));
  });

  afterAll(() => server.close());

  it('rejects requests without API key', async () => {
    const res = await request('GET', '/api/status', undefined, '');
    expect(res.status).toBe(401);
  });

  it('rejects requests with wrong API key', async () => {
    const res = await request('GET', '/api/status', undefined, 'wrong');
    expect(res.status).toBe(401);
  });

  it('returns status on GET /api/status', async () => {
    const res = await request('GET', '/api/status');
    expect(res.status).toBe(200);
    const data = JSON.parse(res.body);
    expect(data).toHaveProperty('ok', true);
  });

  it('accepts messages on POST /api/messages', async () => {
    const res = await request('POST', '/api/messages', {
      jid: 'cli:main',
      content: 'Hello',
      type: 'text',
    });
    expect(res.status).toBe(202);
  });

  it('returns 404 for unknown routes', async () => {
    const res = await request('GET', '/api/nonexistent');
    expect(res.status).toBe(404);
  });
});
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run src/api-server.test.ts`
Expected: FAIL — module `./api-server.js` does not exist

**Step 3: Implement the API server**

Key components:
1. Auth middleware — checks `Authorization: Bearer <key>` against `NANOCLAW_API_KEY`
2. SSE manager — tracks connected clients, pushes events to all
3. Route handlers — POST /api/messages, GET /api/messages/stream, GET /api/groups, GET /api/groups/:jid/history, GET /api/status, GET /api/audio/:id, GET /api/cost/summary, POST /api/cost/budget
4. Audio file management — stores TTS output in `data/audio/`, serves via GET

```typescript
// src/api-server.ts
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { logger } from './logger.js';
import { DATA_DIR } from './config.js';
import type { CliChannel } from './channels/cli.js';
import type { RegisteredGroup, NewMessage } from './types.js';

export interface ApiServerOpts {
  port: number;
  apiKey: string;
  cliChannel: CliChannel;
  getGroups: () => Record<string, RegisteredGroup>;
  getHistory: (jid: string, limit?: number) => NewMessage[];
}

interface SseClient {
  id: string;
  res: http.ServerResponse;
}

const sseClients: SseClient[] = [];

export function pushSseEvent(
  event: string,
  data: Record<string, unknown>,
): void {
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const client of sseClients) {
    client.res.write(payload);
  }
}

function parseBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    let body = '';
    req.on('data', (chunk: string) => (body += chunk));
    req.on('end', () => resolve(body));
  });
}

function jsonResponse(
  res: http.ServerResponse,
  status: number,
  data: unknown,
): void {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data));
}

export function createApiServer(opts: ApiServerOpts): http.Server {
  const audioDir = path.join(DATA_DIR, 'audio');
  fs.mkdirSync(audioDir, { recursive: true });

  const server = http.createServer(async (req, res) => {
    // CORS for local clients
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type');
    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }

    // Auth check
    const authHeader = req.headers.authorization || '';
    const token = authHeader.replace(/^Bearer\s+/i, '');
    if (token !== opts.apiKey) {
      jsonResponse(res, 401, { error: 'Unauthorized' });
      return;
    }

    const url = new URL(req.url || '/', `http://${req.headers.host}`);
    const pathname = url.pathname;

    try {
      // GET /api/status
      if (req.method === 'GET' && pathname === '/api/status') {
        jsonResponse(res, 200, {
          ok: true,
          channels: ['cli'],
          sseClients: sseClients.length,
        });
        return;
      }

      // POST /api/messages
      if (req.method === 'POST' && pathname === '/api/messages') {
        const raw = await parseBody(req);
        const msg = JSON.parse(raw);
        const { jid, content, type, sender, senderName } = msg;
        if (!jid || !content) {
          jsonResponse(res, 400, { error: 'jid and content are required' });
          return;
        }
        opts.cliChannel.injectMessage(
          jid,
          sender || 'cli-user',
          senderName || 'User',
          type === 'voice' ? `[Voice: ${content}]` : content,
        );
        jsonResponse(res, 202, { accepted: true });
        return;
      }

      // GET /api/messages/stream (SSE)
      if (req.method === 'GET' && pathname === '/api/messages/stream') {
        res.writeHead(200, {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          Connection: 'keep-alive',
        });
        const client: SseClient = { id: randomUUID(), res };
        sseClients.push(client);
        res.write(`event: connected\ndata: {"clientId":"${client.id}"}\n\n`);
        req.on('close', () => {
          const idx = sseClients.indexOf(client);
          if (idx !== -1) sseClients.splice(idx, 1);
        });
        return;
      }

      // GET /api/groups
      if (req.method === 'GET' && pathname === '/api/groups') {
        jsonResponse(res, 200, opts.getGroups());
        return;
      }

      // GET /api/groups/:jid/history
      const historyMatch = pathname.match(/^\/api\/groups\/(.+)\/history$/);
      if (req.method === 'GET' && historyMatch) {
        const jid = decodeURIComponent(historyMatch[1]);
        const limit = parseInt(url.searchParams.get('limit') || '50', 10);
        const history = opts.getHistory(jid, limit);
        jsonResponse(res, 200, history);
        return;
      }

      // GET /api/audio/:id
      const audioMatch = pathname.match(/^\/api\/audio\/(.+)$/);
      if (req.method === 'GET' && audioMatch) {
        const filename = audioMatch[1];
        // Prevent directory traversal
        if (filename.includes('..') || filename.includes('/')) {
          jsonResponse(res, 400, { error: 'Invalid audio ID' });
          return;
        }
        const audioFile = path.join(audioDir, filename);
        if (!fs.existsSync(audioFile)) {
          jsonResponse(res, 404, { error: 'Audio not found' });
          return;
        }
        const ext = path.extname(audioFile);
        const mimeTypes: Record<string, string> = {
          '.ogg': 'audio/ogg',
          '.mp3': 'audio/mpeg',
          '.opus': 'audio/opus',
        };
        res.writeHead(200, {
          'Content-Type': mimeTypes[ext] || 'application/octet-stream',
        });
        fs.createReadStream(audioFile).pipe(res);
        return;
      }

      // GET /api/cost/summary
      if (req.method === 'GET' && pathname === '/api/cost/summary') {
        const { getTtsUsageSummary, checkBudget } = await import(
          './cost-tracker.js'
        );
        jsonResponse(res, 200, {
          usage: getTtsUsageSummary(),
          budget: checkBudget(),
        });
        return;
      }

      // POST /api/cost/budget
      if (req.method === 'POST' && pathname === '/api/cost/budget') {
        const raw = await parseBody(req);
        const { period, amount } = JSON.parse(raw);
        if (
          !['daily', 'weekly', 'monthly'].includes(period) ||
          typeof amount !== 'number'
        ) {
          jsonResponse(res, 400, { error: 'Invalid period or amount' });
          return;
        }
        const { setBudget } = await import('./cost-tracker.js');
        setBudget(period, amount);
        jsonResponse(res, 200, { ok: true });
        return;
      }

      // 404
      jsonResponse(res, 404, { error: 'Not found' });
    } catch (err) {
      logger.error({ err }, 'API server error');
      jsonResponse(res, 500, { error: 'Internal server error' });
    }
  });

  return server;
}

/** Save a TTS audio buffer and return its ID for serving via /api/audio/:id */
export function saveAudioFile(audio: Buffer, format = 'ogg'): string {
  const audioDir = path.join(DATA_DIR, 'audio');
  fs.mkdirSync(audioDir, { recursive: true });
  const id = `${randomUUID()}.${format}`;
  fs.writeFileSync(path.join(audioDir, id), audio);
  return id;
}
```

**Step 4: Run tests to verify they pass**

Run: `npx vitest run src/api-server.test.ts`
Expected: All 5 tests PASS

**Step 5: Commit**

```bash
git add src/api-server.ts src/api-server.test.ts
git commit -m "feat: add HTTP API server with auth, SSE, and message routing"
```

---

### Task 5: Wire Everything into the Orchestrator

**Files:**
- Modify: `src/index.ts`
- Modify: `src/config.ts`
- Modify: `.env.example`

**Context:** This task connects the CLI Channel, HTTP API Server, and TTS service into the existing orchestrator (`src/index.ts`). The key integration points are: channel instantiation (line ~477-480), the `processGroupMessages` response path (line ~205), and the main function startup sequence.

**Step 1: Add new config constants**

In `src/config.ts`, add after the existing constants:

```typescript
// HTTP API
export const API_PORT = parseInt(process.env.NANOCLAW_API_PORT || '3000', 10);
export const API_ENABLED = process.env.NANOCLAW_API_ENABLED !== 'false';
```

In `.env.example`, add:

```env
# HTTP API for TUI
NANOCLAW_API_PORT=3000
NANOCLAW_API_KEY=
NANOCLAW_API_ENABLED=true

# TTS
OPENAI_TTS_VOICE=marin
OPENAI_TTS_MODEL=gpt-4o-mini-tts
OPENAI_TTS_INSTRUCTIONS_FILE=config/tts-instructions.txt
OPENAI_TTS_ENABLED=true
OPENAI_TTS_BUDGET_MONTHLY=
OPENAI_TTS_BUDGET_WEEKLY=
OPENAI_TTS_BUDGET_DAILY=
```

**Step 2: Integrate CLI Channel and API Server into `main()`**

In `src/index.ts`, after the WhatsApp channel is created and connected (around line 480), add:

1. Import new modules at the top of the file
2. Create the CLI channel, push to channels array, connect
3. Wire the outbound handler to push SSE events (and optionally trigger TTS)
4. Start the HTTP API server
5. Pre-register the `cli:main` group

Key imports:
```typescript
import { CliChannel } from './channels/cli.js';
import { createApiServer, pushSseEvent, saveAudioFile } from './api-server.js';
import { synthesizeSpeech, isTtsEnabled } from './tts.js';
import { recordTtsUsage, checkBudget } from './cost-tracker.js';
import { API_PORT, API_ENABLED } from './config.js';
```

Key integration code (after WhatsApp channel setup in `main()`):

```typescript
// CLI channel
const cliChannel = new CliChannel(channelOpts);
channels.push(cliChannel);
await cliChannel.connect();

// Wire outbound handler
cliChannel.setOutboundHandler(async (jid, text) => {
  pushSseEvent('message', {
    jid,
    content: text,
    audioUrl: null,
    timestamp: new Date().toISOString(),
  });

  // TTS: check modality signal
  const shouldSpeak = text.includes('<audio>');
  if (shouldSpeak && isTtsEnabled()) {
    const budget = checkBudget();
    if (budget.ttsAllowed) {
      const cleanText = text.replace(/<audio>|<\/audio>/g, '').trim();
      const result = await synthesizeSpeech(cleanText);
      if (result) {
        const audioId = saveAudioFile(result.audio);
        recordTtsUsage({
          characters: result.characterCount,
          costEstimate: result.characterCount * 0.000015,
          model: 'gpt-4o-mini-tts',
        });
        pushSseEvent('audio', { jid, audioUrl: `/api/audio/${audioId}` });
      }
    } else {
      pushSseEvent('budget_warning', {
        message: 'TTS budget exceeded, text-only response',
      });
    }
  }
});

// HTTP API server
if (API_ENABLED) {
  const env = readEnvFile(['NANOCLAW_API_KEY']);
  const apiKey = env.NANOCLAW_API_KEY;
  if (apiKey) {
    const apiServer = createApiServer({
      port: API_PORT,
      apiKey,
      cliChannel,
      getGroups: () => registeredGroups,
      getHistory: (jid, limit) =>
        getMessagesSince(jid, new Date(0).toISOString(), limit || 50),
    });
    apiServer.listen(API_PORT, '127.0.0.1', () => {
      logger.info({ port: API_PORT }, 'HTTP API server listening');
    });
  } else {
    logger.info('NANOCLAW_API_KEY not set — HTTP API disabled');
  }
}

// Pre-register CLI group
if (!registeredGroups['cli:main']) {
  const cliGroup = {
    name: 'CLI',
    folder: 'cli',
    trigger: '',
    added_at: new Date().toISOString(),
    requiresTrigger: false,
  };
  setRegisteredGroup('cli:main', cliGroup);
  registeredGroups['cli:main'] = cliGroup;
  fs.mkdirSync(path.join(GROUPS_DIR, 'cli', 'logs'), { recursive: true });
}
```

**Step 3: Build and test manually**

Run: `npm run build`
Expected: Compilation succeeds without errors

Run: `npm run dev` (with `NANOCLAW_API_KEY=test-key` in `.env`)
Expected: Logs show "HTTP API server listening" on port 3000

Test with curl:
```bash
curl -H "Authorization: Bearer test-key" http://127.0.0.1:3000/api/status
# Expected: {"ok":true,"channels":["cli"],"sseClients":0}
```

**Step 4: Commit**

```bash
git add src/index.ts src/config.ts .env.example
git commit -m "feat: integrate CLI channel, HTTP API, and TTS into orchestrator"
```

---

## Phase 2: Client-Side (Python/Textual TUI)

### Task 6: Python Project Scaffolding

**Files:**
- Create: `tui/pyproject.toml`
- Create: `tui/src/nanoclaw_tui/__init__.py`
- Create: `tui/src/nanoclaw_tui/config.py`

**Context:** Set up the Python project using `uv` as the package manager (per global CLAUDE.md guidelines). Python 3.12+, type hints everywhere.

**Step 1: Create project structure**

```bash
mkdir -p tui/src/nanoclaw_tui/widgets tui/src/nanoclaw_tui/audio tui/tests
```

**Step 2: Create `pyproject.toml`**

```toml
[project]
name = "nanoclaw-tui"
version = "0.1.0"
description = "Terminal UI for NanoClaw"
requires-python = ">=3.12"
dependencies = [
    "textual>=1.0.0",
    "httpx>=0.27.0",
    "httpx-sse>=0.4.0",
    "sounddevice>=0.5.0",
    "soundfile>=0.12.0",
    "numpy>=1.26.0",
]

[project.optional-dependencies]
dev = [
    "pytest>=8.0",
    "pytest-asyncio>=0.24.0",
    "ruff>=0.8.0",
]

[project.scripts]
nanoclaw-tui = "nanoclaw_tui.app:main"

[build-system]
requires = ["hatchling"]
build-backend = "hatchling.build"

[tool.ruff]
target-version = "py312"
line-length = 100

[tool.pytest.ini_options]
asyncio_mode = "auto"
```

**Step 3: Create config module**

```python
# tui/src/nanoclaw_tui/__init__.py
"""NanoClaw Terminal UI."""

# tui/src/nanoclaw_tui/config.py
"""TUI configuration."""

from __future__ import annotations

import os
from dataclasses import dataclass, field


@dataclass
class TuiConfig:
    api_url: str = field(
        default_factory=lambda: os.environ.get(
            "NANOCLAW_API_URL", "http://127.0.0.1:3000"
        )
    )
    api_key: str = field(
        default_factory=lambda: os.environ.get("NANOCLAW_API_KEY", "")
    )
    audio_player: str = field(
        default_factory=lambda: os.environ.get("AUDIO_PLAYER", "auto")
    )
    default_jid: str = "cli:main"
```

**Step 4: Install dependencies**

```bash
cd tui && uv sync
```

**Step 5: Commit**

```bash
git add tui/
git commit -m "feat: scaffold Python TUI project with Textual"
```

---

### Task 7: API Client

**Files:**
- Create: `tui/src/nanoclaw_tui/api_client.py`
- Create: `tui/tests/test_api_client.py`

**Context:** HTTP client using `httpx` for requests. SSE streaming with reconnection on failure. Handles auth headers.

**Step 1: Write the failing test**

```python
# tui/tests/test_api_client.py
from __future__ import annotations

import pytest
from nanoclaw_tui.api_client import NanoClawClient


class TestNanoClawClient:
    def test_builds_auth_header(self) -> None:
        client = NanoClawClient(
            api_url="http://localhost:3000", api_key="test-key"
        )
        assert client.headers["Authorization"] == "Bearer test-key"

    def test_raises_on_empty_api_key(self) -> None:
        with pytest.raises(ValueError, match="API key"):
            NanoClawClient(api_url="http://localhost:3000", api_key="")
```

**Step 2: Run test to verify it fails**

Run: `cd tui && uv run pytest tests/test_api_client.py -v`
Expected: FAIL — module not found

**Step 3: Implement the API client**

```python
# tui/src/nanoclaw_tui/api_client.py
"""HTTP + SSE client for NanoClaw API."""

from __future__ import annotations

import asyncio
import json
from collections.abc import AsyncIterator
from dataclasses import dataclass
from typing import Any

import httpx


@dataclass
class SseEvent:
    event: str
    data: dict[str, Any]


class NanoClawClient:
    """Client for the NanoClaw HTTP API."""

    def __init__(self, api_url: str, api_key: str) -> None:
        if not api_key:
            raise ValueError("API key is required")
        self.api_url = api_url.rstrip("/")
        self.api_key = api_key
        self.headers = {
            "Authorization": f"Bearer {api_key}",
            "Content-Type": "application/json",
        }

    async def get_status(self) -> dict[str, Any]:
        async with httpx.AsyncClient() as client:
            resp = await client.get(
                f"{self.api_url}/api/status", headers=self.headers
            )
            resp.raise_for_status()
            return resp.json()

    async def send_message(
        self,
        jid: str,
        content: str,
        msg_type: str = "text",
        sender: str = "cli-user",
        sender_name: str = "User",
    ) -> None:
        async with httpx.AsyncClient() as client:
            resp = await client.post(
                f"{self.api_url}/api/messages",
                headers=self.headers,
                json={
                    "jid": jid,
                    "content": content,
                    "type": msg_type,
                    "sender": sender,
                    "senderName": sender_name,
                },
            )
            resp.raise_for_status()

    async def send_audio(self, jid: str, audio_data: bytes) -> None:
        import base64

        async with httpx.AsyncClient() as client:
            resp = await client.post(
                f"{self.api_url}/api/messages",
                headers=self.headers,
                json={
                    "jid": jid,
                    "content": base64.b64encode(audio_data).decode(),
                    "type": "voice",
                },
            )
            resp.raise_for_status()

    async def get_groups(self) -> dict[str, Any]:
        async with httpx.AsyncClient() as client:
            resp = await client.get(
                f"{self.api_url}/api/groups", headers=self.headers
            )
            resp.raise_for_status()
            return resp.json()

    async def get_history(
        self, jid: str, limit: int = 50
    ) -> list[dict[str, Any]]:
        async with httpx.AsyncClient() as client:
            resp = await client.get(
                f"{self.api_url}/api/groups/{jid}/history",
                headers=self.headers,
                params={"limit": limit},
            )
            resp.raise_for_status()
            return resp.json()

    async def get_cost_summary(self) -> dict[str, Any]:
        async with httpx.AsyncClient() as client:
            resp = await client.get(
                f"{self.api_url}/api/cost/summary", headers=self.headers
            )
            resp.raise_for_status()
            return resp.json()

    async def set_budget(self, period: str, amount: float) -> None:
        async with httpx.AsyncClient() as client:
            resp = await client.post(
                f"{self.api_url}/api/cost/budget",
                headers=self.headers,
                json={"period": period, "amount": amount},
            )
            resp.raise_for_status()

    async def download_audio(self, audio_url: str) -> bytes:
        async with httpx.AsyncClient() as client:
            resp = await client.get(
                f"{self.api_url}{audio_url}", headers=self.headers
            )
            resp.raise_for_status()
            return resp.content

    async def stream_events(self) -> AsyncIterator[SseEvent]:
        """Connect to SSE stream and yield events. Reconnects on failure."""
        while True:
            try:
                async with httpx.AsyncClient(timeout=None) as client:
                    async with client.stream(
                        "GET",
                        f"{self.api_url}/api/messages/stream",
                        headers=self.headers,
                    ) as resp:
                        resp.raise_for_status()
                        buffer = ""
                        async for chunk in resp.aiter_text():
                            buffer += chunk
                            while "\n\n" in buffer:
                                raw_event, buffer = buffer.split("\n\n", 1)
                                event_type = "message"
                                data_str = ""
                                for line in raw_event.strip().split("\n"):
                                    if line.startswith("event: "):
                                        event_type = line[7:]
                                    elif line.startswith("data: "):
                                        data_str = line[6:]
                                if data_str:
                                    yield SseEvent(
                                        event=event_type,
                                        data=json.loads(data_str),
                                    )
            except (httpx.ConnectError, httpx.ReadError):
                await asyncio.sleep(2)
```

**Step 4: Run tests to verify they pass**

Run: `cd tui && uv run pytest tests/test_api_client.py -v`
Expected: PASS

**Step 5: Commit**

```bash
git add tui/src/nanoclaw_tui/api_client.py tui/tests/test_api_client.py
git commit -m "feat(tui): add HTTP + SSE API client"
```

---

### Task 8: TUI Chat View, Input, and Main App

**Files:**
- Create: `tui/src/nanoclaw_tui/widgets/__init__.py`
- Create: `tui/src/nanoclaw_tui/widgets/chat_view.py`
- Create: `tui/src/nanoclaw_tui/widgets/input_bar.py`
- Create: `tui/src/nanoclaw_tui/app.py`
- Create: `tui/src/nanoclaw_tui/app.tcss`

**Context:** Core TUI app. Chat view uses Textual's `Markdown` widget for rich rendering. Input bar handles readline-style keybindings. The app connects to the NanoClaw API via the client from Task 7, loads history on startup, and listens for SSE events. See Textual docs (Context7 `/websites/textual_textualize_io`) for widget and CSS patterns.

**Step 1: Create the chat message widgets**

```python
# tui/src/nanoclaw_tui/widgets/__init__.py
"""TUI widgets."""

# tui/src/nanoclaw_tui/widgets/chat_view.py
"""Chat message display widgets."""

from __future__ import annotations

from textual.widgets import Markdown


class UserMessage(Markdown):
    """A message from the user."""

    DEFAULT_CSS = """
    UserMessage {
        margin: 0 0 1 0;
        padding: 0 1;
    }
    """


class AgentMessage(Markdown):
    """A message from the agent."""

    BORDER_TITLE = "Lulu"

    DEFAULT_CSS = """
    AgentMessage {
        margin: 0 0 1 0;
        padding: 0 1;
        border: round $accent;
    }
    """
```

**Step 2: Create the input bar**

```python
# tui/src/nanoclaw_tui/widgets/input_bar.py
"""Input bar with readline-style keybindings."""

from __future__ import annotations

from textual.widgets import Input


class MessageInput(Input):
    """Text input with message history."""

    DEFAULT_CSS = """
    MessageInput {
        dock: bottom;
        margin: 0 0;
    }
    """

    def __init__(self, **kwargs: object) -> None:
        super().__init__(placeholder="Type a message...", **kwargs)
        self._history: list[str] = []
        self._history_index: int = -1
```

**Step 3: Create the main app**

```python
# tui/src/nanoclaw_tui/app.py
"""Main NanoClaw TUI application."""

from __future__ import annotations

import sys

from textual.app import App, ComposeResult
from textual.binding import Binding
from textual.containers import VerticalScroll
from textual.widgets import Footer, Header, Static

from nanoclaw_tui.api_client import NanoClawClient
from nanoclaw_tui.config import TuiConfig
from nanoclaw_tui.widgets.chat_view import AgentMessage, UserMessage
from nanoclaw_tui.widgets.input_bar import MessageInput


class NanoClawTui(App[None]):
    """NanoClaw Terminal User Interface."""

    TITLE = "NanoClaw TUI"
    CSS_PATH = "app.tcss"

    BINDINGS = [
        Binding("ctrl+q", "quit", "Quit"),
        Binding("ctrl+g", "toggle_sidebar", "Groups"),
        Binding("ctrl+r", "search", "Search"),
    ]

    def __init__(self, config: TuiConfig | None = None) -> None:
        super().__init__()
        self.config = config or TuiConfig()
        self.client = NanoClawClient(
            api_url=self.config.api_url,
            api_key=self.config.api_key,
        )
        self.current_jid = self.config.default_jid

    def compose(self) -> ComposeResult:
        yield Header()
        with VerticalScroll(id="chat-view"):
            yield Static("Connecting to NanoClaw...", id="status")
        yield MessageInput(id="message-input")
        yield Footer()

    async def on_mount(self) -> None:
        """Start SSE listener and load history."""
        self.run_worker(self._listen_for_events(), exclusive=True)
        try:
            history = await self.client.get_history(self.current_jid)
            chat_view = self.query_one("#chat-view")
            status = self.query_one("#status")
            status.remove()
            for msg in history:
                if msg.get("is_from_me") or msg.get("is_bot_message"):
                    await chat_view.mount(AgentMessage(msg["content"]))
                else:
                    await chat_view.mount(UserMessage(msg["content"]))
            chat_view.scroll_end(animate=False)
        except Exception:
            self.query_one("#status", Static).update(
                "Failed to connect. Is NanoClaw running?"
            )

    async def on_input_submitted(self, event: MessageInput.Submitted) -> None:
        """Handle message submission."""
        text = event.value.strip()
        if not text:
            return
        event.input.value = ""

        chat_view = self.query_one("#chat-view")
        await chat_view.mount(UserMessage(text))
        chat_view.scroll_end(animate=False)

        try:
            await self.client.send_message(self.current_jid, text)
        except Exception as e:
            await chat_view.mount(Static(f"[red]Failed to send: {e}[/red]"))

    async def _listen_for_events(self) -> None:
        """Listen for SSE events from NanoClaw."""
        async for event in self.client.stream_events():
            if event.event == "message":
                chat_view = self.query_one("#chat-view")
                await chat_view.mount(
                    AgentMessage(event.data.get("content", ""))
                )
                chat_view.scroll_end(animate=False)

    def action_toggle_sidebar(self) -> None:
        """Toggle the group sidebar (implemented in Task 9)."""

    def action_search(self) -> None:
        """Open message search (future enhancement)."""


def main() -> None:
    config = TuiConfig()
    if not config.api_key:
        print(
            "Error: NANOCLAW_API_KEY not set. "
            "Set it in your environment or .env file."
        )
        sys.exit(1)
    app = NanoClawTui(config)
    app.run()


if __name__ == "__main__":
    main()
```

**Step 4: Create the Textual CSS**

```css
/* tui/src/nanoclaw_tui/app.tcss */
Screen {
    layout: vertical;
}

#chat-view {
    height: 1fr;
    padding: 1 2;
}

MessageInput {
    dock: bottom;
    margin: 0 1;
}
```

**Step 5: Test manually**

```bash
cd tui && NANOCLAW_API_KEY=test-key uv run nanoclaw-tui
```

Expected: TUI launches with header, footer, input bar. Shows connection status.

**Step 6: Commit**

```bash
git add tui/src/nanoclaw_tui/widgets/ tui/src/nanoclaw_tui/app.py tui/src/nanoclaw_tui/app.tcss
git commit -m "feat(tui): add chat view, input bar, and main app"
```

---

### Task 9: Session Sidebar (Group Switching)

**Files:**
- Create: `tui/src/nanoclaw_tui/widgets/session_sidebar.py`
- Modify: `tui/src/nanoclaw_tui/app.py` (integrate sidebar)
- Modify: `tui/src/nanoclaw_tui/app.tcss` (sidebar layout)

**Context:** A sidebar listing available groups. Active group is highlighted. Clicking or pressing Enter switches the active conversation. Toggled via `Ctrl+G`. Uses Textual's `OptionList` widget.

**Step 1: Implement the sidebar widget**

```python
# tui/src/nanoclaw_tui/widgets/session_sidebar.py
"""Group session sidebar for switching conversations."""

from __future__ import annotations

from typing import Any

from textual.app import ComposeResult
from textual.containers import Vertical
from textual.message import Message
from textual.widgets import Label, OptionList
from textual.widgets.option_list import Option


class GroupSelected(Message):
    """Emitted when a group is selected."""

    def __init__(self, jid: str, name: str) -> None:
        super().__init__()
        self.jid = jid
        self.name = name


class SessionSidebar(Vertical):
    """Sidebar showing available groups."""

    DEFAULT_CSS = """
    SessionSidebar {
        width: 20;
        dock: left;
        border-right: solid $accent;
        padding: 1;
        display: none;
    }

    SessionSidebar.visible {
        display: block;
    }
    """

    def compose(self) -> ComposeResult:
        yield Label("Groups", id="sidebar-title")
        yield OptionList(id="group-list")

    def update_groups(
        self, groups: dict[str, Any], active_jid: str
    ) -> None:
        option_list = self.query_one("#group-list", OptionList)
        option_list.clear_options()
        for jid, group in groups.items():
            prefix = "\u25cf " if jid == active_jid else "\u25cb "
            name = group.get("name", jid) if isinstance(group, dict) else jid
            option_list.add_option(Option(f"{prefix}{name}", id=jid))

    def on_option_list_option_selected(
        self, event: OptionList.OptionSelected
    ) -> None:
        if event.option.id:
            self.post_message(
                GroupSelected(
                    jid=str(event.option.id), name=event.option.prompt
                )
            )
```

**Step 2: Integrate into app.py**

Add `SessionSidebar` to `compose()` and handle `GroupSelected` messages. Wire `action_toggle_sidebar` to toggle the sidebar's `visible` CSS class. On group selection, update `current_jid`, clear chat view, and reload history.

**Step 3: Update CSS for sidebar layout**

Add to `app.tcss`:

```css
#main-content {
    layout: horizontal;
    height: 1fr;
}
```

**Step 4: Test manually**

Run the TUI, press `Ctrl+G` to toggle sidebar, verify groups appear.

**Step 5: Commit**

```bash
git add tui/src/nanoclaw_tui/widgets/session_sidebar.py tui/src/nanoclaw_tui/app.py tui/src/nanoclaw_tui/app.tcss
git commit -m "feat(tui): add session sidebar for group switching"
```

---

### Task 10: Audio — Microphone Capture and Playback

**Files:**
- Create: `tui/src/nanoclaw_tui/audio/__init__.py`
- Create: `tui/src/nanoclaw_tui/audio/recorder.py`
- Create: `tui/src/nanoclaw_tui/audio/player.py`
- Modify: `tui/src/nanoclaw_tui/app.py` (integrate push-to-talk and playback)

**Context:** Push-to-talk uses `sounddevice` to capture audio from the default microphone. Recording starts on `Ctrl+Space` press, stops on release, and sends the audio to NanoClaw via the API. Playback uses a subprocess call to `mpv`, `ffplay`, or `afplay` (auto-detected). Audio files are also saved locally for replay.

**Step 1: Implement the audio recorder**

```python
# tui/src/nanoclaw_tui/audio/__init__.py
"""Audio recording and playback."""

# tui/src/nanoclaw_tui/audio/recorder.py
"""Microphone capture for push-to-talk."""

from __future__ import annotations

import io

import numpy as np


class AudioRecorder:
    """Records audio from the default microphone."""

    def __init__(
        self, sample_rate: int = 16000, channels: int = 1
    ) -> None:
        self.sample_rate = sample_rate
        self.channels = channels
        self._recording = False
        self._frames: list[np.ndarray] = []
        self._stream: object | None = None

    def start(self) -> None:
        """Start recording from the microphone."""
        import sounddevice as sd

        self._frames = []
        self._recording = True
        self._stream = sd.InputStream(
            samplerate=self.sample_rate,
            channels=self.channels,
            dtype="int16",
            callback=self._callback,
        )
        self._stream.start()  # type: ignore[union-attr]

    def stop(self) -> bytes:
        """Stop recording and return OGG audio data as bytes."""
        import soundfile as sf

        self._recording = False
        if self._stream is not None:
            self._stream.stop()  # type: ignore[union-attr]
            self._stream.close()  # type: ignore[union-attr]
            self._stream = None

        if not self._frames:
            return b""

        audio_data = np.concatenate(self._frames)
        buffer = io.BytesIO()
        sf.write(
            buffer,
            audio_data,
            self.sample_rate,
            format="OGG",
            subtype="VORBIS",
        )
        return buffer.getvalue()

    @property
    def is_recording(self) -> bool:
        return self._recording

    def _callback(
        self,
        indata: np.ndarray,
        frames: int,
        time_info: object,
        status: object,
    ) -> None:
        if self._recording:
            self._frames.append(indata.copy())
```

**Step 2: Implement the audio player**

```python
# tui/src/nanoclaw_tui/audio/player.py
"""Audio playback using system audio players."""

from __future__ import annotations

import asyncio
import shutil
import tempfile
from pathlib import Path


def detect_player() -> str | None:
    """Auto-detect an available audio player."""
    for player in ("mpv", "ffplay", "afplay", "aplay"):
        if shutil.which(player):
            return player
    return None


async def play_audio(
    audio_data: bytes, player: str | None = None
) -> Path:
    """Play audio data and return the file path for later replay."""
    player = player or detect_player()

    tmp = Path(tempfile.mktemp(suffix=".ogg"))
    tmp.write_bytes(audio_data)

    if player:
        cmd_map: dict[str, list[str]] = {
            "mpv": ["mpv", "--no-video", "--really-quiet", str(tmp)],
            "ffplay": [
                "ffplay", "-nodisp", "-autoexit",
                "-loglevel", "quiet", str(tmp),
            ],
            "afplay": ["afplay", str(tmp)],
            "aplay": ["aplay", str(tmp)],
        }
        cmd = cmd_map.get(player, [player, str(tmp)])
        proc = await asyncio.create_subprocess_exec(
            *cmd,
            stdout=asyncio.subprocess.DEVNULL,
            stderr=asyncio.subprocess.DEVNULL,
        )
        await proc.wait()

    return tmp
```

**Step 3: Integrate into app.py**

Add `Ctrl+Space` binding for push-to-talk. On key press, start recording and show a recording indicator. On key release, stop recording, send audio via API, and show "Sending voice message..." in chat.

For playback, when an SSE `audio` event arrives, download the audio file and play it.

**Step 4: Test manually**

Test push-to-talk and playback with the TUI running against a live NanoClaw instance.

**Step 5: Commit**

```bash
git add tui/src/nanoclaw_tui/audio/ tui/src/nanoclaw_tui/app.py
git commit -m "feat(tui): add push-to-talk recording and audio playback"
```

---

### Task 11: Cost Monitor Widget

**Files:**
- Create: `tui/src/nanoclaw_tui/widgets/cost_monitor.py`
- Modify: `tui/src/nanoclaw_tui/app.py` (integrate cost display and commands)

**Context:** A small widget in the header area showing today's TTS spend vs daily budget. Changes color at alert thresholds. Also registers `/cost` and `/budget` commands in the Textual command palette.

**Step 1: Implement the cost widget**

```python
# tui/src/nanoclaw_tui/widgets/cost_monitor.py
"""TTS cost monitoring widget."""

from __future__ import annotations

from typing import Any

from textual.reactive import reactive
from textual.widgets import Static


class CostMonitor(Static):
    """Displays current TTS spend in the header."""

    DEFAULT_CSS = """
    CostMonitor {
        dock: right;
        width: auto;
        padding: 0 1;
    }

    CostMonitor.ok { color: $success; }
    CostMonitor.info { color: $warning; }
    CostMonitor.warning { color: $error; }
    CostMonitor.critical { color: $error; background: $error-darken-3; }
    CostMonitor.exceeded { color: $text; background: $error; }
    """

    spent: reactive[float] = reactive(0.0)
    budget: reactive[float] = reactive(0.0)
    alert_tier: reactive[str] = reactive("ok")

    def render(self) -> str:
        if self.budget > 0:
            return f"${self.spent:.2f}/${self.budget:.2f}"
        return f"${self.spent:.2f}"

    def watch_alert_tier(self, tier: str) -> None:
        self.remove_class("ok", "info", "warning", "critical", "exceeded")
        self.add_class(tier)

    def update_from_api(self, cost_data: dict[str, Any]) -> None:
        """Update from API cost summary response."""
        usage = cost_data.get("usage", {})
        budget_status = cost_data.get("budget", {})

        today = usage.get("today", {})
        self.spent = today.get("cost", 0.0)

        daily = budget_status.get("daily")
        if daily:
            self.budget = daily.get("budget", 0.0)
            self.alert_tier = daily.get("alertTier", "ok")
```

**Step 2: Integrate into app**

Add `CostMonitor` to the header area. Set up a periodic worker that polls `/api/cost/summary` every 30 seconds and updates the widget.

Register commands in the Textual command palette:
- "Show cost summary" — displays daily/weekly/monthly breakdown
- "Set daily budget" / "Set weekly budget" / "Set monthly budget"

**Step 3: Commit**

```bash
git add tui/src/nanoclaw_tui/widgets/cost_monitor.py tui/src/nanoclaw_tui/app.py
git commit -m "feat(tui): add cost monitor widget and budget commands"
```

---

## Phase 3: Integration Testing and Polish

### Task 12: End-to-End Integration Test

**Files:**
- Create: `tests/integration/test_api_tui.test.ts` (Node.js side)

**Step 1: Write an integration test that:**
1. Starts the NanoClaw API server on a test port
2. Sends a message via POST /api/messages
3. Verifies the message appears in the database
4. Verifies SSE stream receives events

**Step 2: Manual end-to-end test checklist**

- [ ] Start NanoClaw with `npm run dev` (API enabled)
- [ ] Start TUI with `cd tui && uv run nanoclaw-tui`
- [ ] Send a text message, verify response appears
- [ ] Send a voice message (Ctrl+Space), verify transcription + response
- [ ] Verify TTS audio plays on voice responses
- [ ] Switch groups via sidebar (Ctrl+G), verify history loads
- [ ] Check cost monitor updates after TTS responses
- [ ] Set a budget via command palette, verify enforcement
- [ ] Test with NanoClaw stopped, verify reconnection behavior
- [ ] Test with invalid API key, verify error message

**Step 3: Commit**

```bash
git add tests/integration/
git commit -m "test: add integration tests for API + TUI"
```

---

### Task 13: Documentation and Launch Script

**Files:**
- Create: `docs/TUI.md`
- Create: `scripts/start-tui.sh`
- Modify: `package.json` (add `tui` script)
- Modify: `.env.example` (final review)

**Step 1: Add a launch script**

```bash
#!/usr/bin/env bash
# scripts/start-tui.sh
set -euo pipefail
cd "$(dirname "$0")/.."

# Source .env if it exists
if [ -f .env ]; then
    set -a
    # shellcheck disable=SC1091
    source .env
    set +a
fi

cd tui
uv run nanoclaw-tui "$@"
```

**Step 2: Add npm script**

```json
"tui": "bash scripts/start-tui.sh"
```

**Step 3: Write TUI documentation**

Document: installation, configuration, keybindings, voice setup, cost management.

**Step 4: Commit**

```bash
git add scripts/start-tui.sh package.json docs/TUI.md .env.example
git commit -m "docs: add TUI documentation and launch script"
```
