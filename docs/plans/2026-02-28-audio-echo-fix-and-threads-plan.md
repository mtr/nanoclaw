# Audio Echo-Loop Fix & Thread Management Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Fix the audio echo-loop bug (bot transcribes its own TTS output as user messages) and add thread management so conversations can be reset and resumed.

**Architecture:** Two independent changes. (1) Track outbound audio message IDs so inbound echoes are recognized as bot messages and skipped for transcription. (2) Add a `threads` table with timestamp-range semantics, intercept `/new`, `/threads`, `/resume` commands before the agent, and use Baileys `chatModify` to clear the WhatsApp chat on thread switches.

**Tech Stack:** TypeScript, Vitest, better-sqlite3, Baileys (@whiskeysockets/baileys)

---

### Task 1: Fix Audio Echo-Loop — Track Sent Audio IDs

**Files:**
- Modify: `src/channels/whatsapp.ts:28-262` (WhatsAppChannel class)
- Test: `src/channels/whatsapp.test.ts`

**Step 1: Write the failing tests**

Add these tests to `src/channels/whatsapp.test.ts` inside the `message handling` describe block:

```typescript
it('skips transcription for bot-sent audio messages', async () => {
  const opts = createTestOpts();
  const channel = new WhatsAppChannel(opts);

  await connectChannel(channel);

  // Bot sends audio — sendAudio returns a message with an ID
  fakeSocket.sendMessage.mockResolvedValueOnce({
    key: { id: 'bot-audio-1' },
  });
  await channel.sendAudio('registered@g.us', Buffer.from('audio'), 'audio/ogg; codecs=opus');

  // The same audio echoes back via messages.upsert
  await triggerMessages([
    {
      key: {
        id: 'bot-audio-1',
        remoteJid: 'registered@g.us',
        fromMe: true,
      },
      message: {
        audioMessage: { mimetype: 'audio/ogg; codecs=opus', ptt: true },
      },
      pushName: 'Andy',
      messageTimestamp: Math.floor(Date.now() / 1000),
    },
  ]);

  // Should NOT transcribe
  expect(transcribeAudioMessage).not.toHaveBeenCalled();
  // Should store as bot message
  expect(opts.onMessage).toHaveBeenCalledWith(
    'registered@g.us',
    expect.objectContaining({
      is_bot_message: true,
      content: '[Bot Audio]',
    }),
  );
});

it('still transcribes user voice messages normally', async () => {
  const opts = createTestOpts();
  const channel = new WhatsAppChannel(opts);

  await connectChannel(channel);

  await triggerMessages([
    {
      key: {
        id: 'user-voice-1',
        remoteJid: 'registered@g.us',
        participant: '5551234@s.whatsapp.net',
        fromMe: false,
      },
      message: {
        audioMessage: { mimetype: 'audio/ogg; codecs=opus', ptt: true },
      },
      pushName: 'Frank',
      messageTimestamp: Math.floor(Date.now() / 1000),
    },
  ]);

  expect(transcribeAudioMessage).toHaveBeenCalled();
  expect(opts.onMessage).toHaveBeenCalledWith(
    'registered@g.us',
    expect.objectContaining({
      content: '[Voice: Hello this is a voice message]',
      is_bot_message: false,
    }),
  );
});

it('uses fromMe as fallback for audio sent before restart', async () => {
  // Simulates: bot sent audio, restarted, the echo arrives (ID not tracked)
  const opts = createTestOpts();
  const channel = new WhatsAppChannel(opts);

  await connectChannel(channel);

  // Audio with fromMe=true but ID NOT in sentAudioIds
  await triggerMessages([
    {
      key: {
        id: 'unknown-audio',
        remoteJid: 'registered@g.us',
        fromMe: true,
      },
      message: {
        audioMessage: { mimetype: 'audio/ogg; codecs=opus', ptt: true },
      },
      pushName: 'Andy',
      messageTimestamp: Math.floor(Date.now() / 1000),
    },
  ]);

  // Should skip transcription (fromMe fallback) and mark as bot
  expect(transcribeAudioMessage).not.toHaveBeenCalled();
  expect(opts.onMessage).toHaveBeenCalledWith(
    'registered@g.us',
    expect.objectContaining({
      is_bot_message: true,
      content: '[Bot Audio]',
    }),
  );
});
```

**Step 2: Run tests to verify they fail**

Run: `npx vitest run src/channels/whatsapp.test.ts`
Expected: 3 new tests FAIL (audio still gets transcribed, not marked as bot)

**Step 3: Implement the fix**

In `src/channels/whatsapp.ts`, make these changes:

1. Add a `sentAudioIds` Set to the class (after line 36):
```typescript
private sentAudioIds = new Set<string>();
private static readonly MAX_SENT_AUDIO_IDS = 100;
```

2. Update `sendAudio()` (line 251-262) to capture the returned message ID:
```typescript
async sendAudio(jid: string, audio: Buffer, mimetype: string): Promise<void> {
  if (!this.connected || !this.sock) {
    logger.warn({ jid }, 'WA disconnected, cannot send audio');
    return;
  }
  try {
    const sent = await this.sock.sendMessage(jid, { audio, mimetype, ptt: true });
    if (sent?.key?.id) {
      this.sentAudioIds.add(sent.key.id);
      // Prevent unbounded growth
      if (this.sentAudioIds.size > WhatsAppChannel.MAX_SENT_AUDIO_IDS) {
        const oldest = this.sentAudioIds.values().next().value;
        if (oldest) this.sentAudioIds.delete(oldest);
      }
    }
    logger.info({ jid, bytes: audio.length }, 'Audio message sent');
  } catch (err) {
    logger.warn({ jid, err }, 'Failed to send audio message');
  }
}
```

3. Update the voice message handling in `messages.upsert` (lines 195-210). Replace the voice message block with:
```typescript
// Transcribe voice messages before storing
let finalContent = content;
if (isVoiceMessage(msg)) {
  const msgId = msg.key.id || '';
  // Skip transcription for bot-sent audio (ID tracking + fromMe fallback)
  if (this.sentAudioIds.has(msgId) || fromMe) {
    this.sentAudioIds.delete(msgId);
    finalContent = '[Bot Audio]';
    // Override: this IS a bot message regardless of content prefix check
    this.opts.onMessage(chatJid, {
      id: msgId,
      chat_jid: chatJid,
      sender,
      sender_name: senderName,
      content: finalContent,
      timestamp,
      is_from_me: fromMe,
      is_bot_message: true,
    });
    continue;
  }
  try {
    const transcript = await transcribeAudioMessage(msg, this.sock);
    if (transcript) {
      finalContent = `[Voice: ${transcript}]`;
      logger.info({ chatJid, length: transcript.length }, 'Transcribed voice message');
    } else {
      finalContent = '[Voice Message - transcription unavailable]';
    }
  } catch (err) {
    logger.error({ err }, 'Voice transcription error');
    finalContent = '[Voice Message - transcription failed]';
  }
}
```

Note: We use `continue` after `onMessage` to skip the second `onMessage` call at the bottom of the loop.

**Step 4: Run tests to verify they pass**

Run: `npx vitest run src/channels/whatsapp.test.ts`
Expected: ALL tests PASS (including the 3 new ones)

**Step 5: Run full test suite**

Run: `npx vitest run`
Expected: ALL tests PASS

**Step 6: Commit**

```bash
git add src/channels/whatsapp.ts src/channels/whatsapp.test.ts
git commit -m "fix: skip transcription for bot-sent audio to prevent echo-loop

Track outbound audio message IDs and use fromMe as fallback.
Bot TTS voice notes are stored as [Bot Audio] with is_bot_message=true
instead of being transcribed and treated as user messages."
```

---

### Task 2: Add Thread Schema and CRUD Functions

**Files:**
- Modify: `src/db.ts:17-98` (createSchema), add new functions
- Modify: `src/types.ts` (add Thread interface)
- Test: `src/db.test.ts`

**Step 1: Write the failing tests**

Add to `src/db.test.ts`. First, update imports at the top to include thread functions:
```typescript
import {
  _initTestDatabase,
  createTask,
  createThread,
  archiveThread,
  getActiveThread,
  getThreads,
  getThreadBySlug,
  resumeThread,
  getMessagesSinceInThread,
  deleteTask,
  getAllChats,
  getMessagesSince,
  getNewMessages,
  getTaskById,
  storeChatMetadata,
  storeMessage,
  updateTask,
} from './db.js';
```

Then add a new describe block:
```typescript
// --- Thread management ---

describe('thread management', () => {
  const jid = 'group@g.us';

  beforeEach(() => {
    storeChatMetadata(jid, '2024-01-01T00:00:00.000Z');
  });

  it('creates a thread and retrieves it as active', () => {
    createThread({
      id: 't1',
      chat_jid: jid,
      name: 'First Topic',
      slug: 'first-topic',
      created_at: '2024-01-01T00:00:00.000Z',
      start_timestamp: '2024-01-01T00:00:00.000Z',
    });

    const active = getActiveThread(jid);
    expect(active).toBeDefined();
    expect(active!.id).toBe('t1');
    expect(active!.name).toBe('First Topic');
    expect(active!.slug).toBe('first-topic');
    expect(active!.archived_at).toBeNull();
  });

  it('archives the active thread', () => {
    createThread({
      id: 't2',
      chat_jid: jid,
      name: 'Topic 2',
      slug: 'topic-2',
      created_at: '2024-01-01T00:00:00.000Z',
      start_timestamp: '2024-01-01T00:00:00.000Z',
    });

    archiveThread('t2', '2024-01-01T01:00:00.000Z');

    const active = getActiveThread(jid);
    expect(active).toBeUndefined();
  });

  it('lists all threads for a group ordered by creation desc', () => {
    createThread({
      id: 't3',
      chat_jid: jid,
      name: 'Old Topic',
      slug: 'old-topic',
      created_at: '2024-01-01T00:00:00.000Z',
      start_timestamp: '2024-01-01T00:00:00.000Z',
    });
    archiveThread('t3', '2024-01-01T01:00:00.000Z');

    createThread({
      id: 't4',
      chat_jid: jid,
      name: 'New Topic',
      slug: 'new-topic',
      created_at: '2024-01-01T01:00:00.000Z',
      start_timestamp: '2024-01-01T01:00:00.000Z',
    });

    const threads = getThreads(jid);
    expect(threads).toHaveLength(2);
    expect(threads[0].name).toBe('New Topic');
    expect(threads[1].name).toBe('Old Topic');
  });

  it('finds thread by slug within a group', () => {
    createThread({
      id: 't5',
      chat_jid: jid,
      name: 'My Thread',
      slug: 'my-thread',
      created_at: '2024-01-01T00:00:00.000Z',
      start_timestamp: '2024-01-01T00:00:00.000Z',
    });

    const thread = getThreadBySlug(jid, 'my-thread');
    expect(thread).toBeDefined();
    expect(thread!.id).toBe('t5');

    const missing = getThreadBySlug(jid, 'nonexistent');
    expect(missing).toBeUndefined();
  });

  it('resumes an archived thread', () => {
    createThread({
      id: 't6',
      chat_jid: jid,
      name: 'Resumed',
      slug: 'resumed',
      created_at: '2024-01-01T00:00:00.000Z',
      start_timestamp: '2024-01-01T00:00:00.000Z',
    });
    archiveThread('t6', '2024-01-01T01:00:00.000Z');

    resumeThread('t6');

    const active = getActiveThread(jid);
    expect(active).toBeDefined();
    expect(active!.id).toBe('t6');
    expect(active!.archived_at).toBeNull();
    expect(active!.end_timestamp).toBeNull();
  });

  it('gets messages within a thread time window', () => {
    createThread({
      id: 't7',
      chat_jid: jid,
      name: 'Windowed',
      slug: 'windowed',
      created_at: '2024-01-01T00:00:00.000Z',
      start_timestamp: '2024-01-01T00:00:02.000Z',
    });

    // Message before thread window
    store({
      id: 'before',
      chat_jid: jid,
      sender: 'user@s.whatsapp.net',
      sender_name: 'User',
      content: 'before thread',
      timestamp: '2024-01-01T00:00:01.000Z',
    });

    // Message inside thread window
    store({
      id: 'inside',
      chat_jid: jid,
      sender: 'user@s.whatsapp.net',
      sender_name: 'User',
      content: 'inside thread',
      timestamp: '2024-01-01T00:00:03.000Z',
    });

    const msgs = getMessagesSinceInThread(jid, '', 'Andy', 't7');
    expect(msgs).toHaveLength(1);
    expect(msgs[0].content).toBe('inside thread');
  });

  it('respects end_timestamp for archived threads', () => {
    createThread({
      id: 't8',
      chat_jid: jid,
      name: 'Ended',
      slug: 'ended',
      created_at: '2024-01-01T00:00:00.000Z',
      start_timestamp: '2024-01-01T00:00:01.000Z',
    });
    archiveThread('t8', '2024-01-01T00:00:03.000Z');

    store({
      id: 'in-window',
      chat_jid: jid,
      sender: 'user@s.whatsapp.net',
      sender_name: 'User',
      content: 'in window',
      timestamp: '2024-01-01T00:00:02.000Z',
    });

    store({
      id: 'after-window',
      chat_jid: jid,
      sender: 'user@s.whatsapp.net',
      sender_name: 'User',
      content: 'after window',
      timestamp: '2024-01-01T00:00:04.000Z',
    });

    const msgs = getMessagesSinceInThread(jid, '', 'Andy', 't8');
    expect(msgs).toHaveLength(1);
    expect(msgs[0].content).toBe('in window');
  });

  it('generates unique slugs when name collides', () => {
    createThread({
      id: 'ta',
      chat_jid: jid,
      name: 'Same Name',
      slug: 'same-name',
      created_at: '2024-01-01T00:00:00.000Z',
      start_timestamp: '2024-01-01T00:00:00.000Z',
    });
    archiveThread('ta', '2024-01-01T01:00:00.000Z');

    // Second thread with same name should get a different slug
    createThread({
      id: 'tb',
      chat_jid: jid,
      name: 'Same Name',
      slug: 'same-name-2',
      created_at: '2024-01-01T01:00:00.000Z',
      start_timestamp: '2024-01-01T01:00:00.000Z',
    });

    const threads = getThreads(jid);
    const slugs = threads.map(t => t.slug);
    expect(new Set(slugs).size).toBe(slugs.length);
  });
});
```

**Step 2: Run tests to verify they fail**

Run: `npx vitest run src/db.test.ts`
Expected: FAIL — functions don't exist yet

**Step 3: Add Thread interface to types.ts**

Add at the end of `src/types.ts` (before the Channel interface):
```typescript
export interface Thread {
  id: string;
  chat_jid: string;
  name: string;
  slug: string;
  created_at: string;
  archived_at: string | null;
  start_timestamp: string;
  end_timestamp: string | null;
}
```

**Step 4: Add threads table to schema**

In `src/db.ts`, inside `createSchema()` (within the `database.exec(...)` template literal, after the `registered_groups` table definition around line 97):
```sql
CREATE TABLE IF NOT EXISTS threads (
  id TEXT PRIMARY KEY,
  chat_jid TEXT NOT NULL,
  name TEXT NOT NULL,
  slug TEXT NOT NULL,
  created_at TEXT NOT NULL,
  archived_at TEXT,
  start_timestamp TEXT NOT NULL,
  end_timestamp TEXT,
  UNIQUE(chat_jid, slug)
);
CREATE INDEX IF NOT EXISTS idx_threads_chat_jid ON threads(chat_jid);
```

**Step 5: Add thread CRUD functions to db.ts**

Add `Thread` to the imports from `./types.js` and add these functions after the session accessors (around line 533):

```typescript
// --- Thread accessors ---

export function createThread(
  thread: Omit<Thread, 'archived_at' | 'end_timestamp'>,
): void {
  db.prepare(
    `INSERT INTO threads (id, chat_jid, name, slug, created_at, start_timestamp)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(
    thread.id, thread.chat_jid, thread.name, thread.slug,
    thread.created_at, thread.start_timestamp,
  );
}

export function archiveThread(threadId: string, endTimestamp: string): void {
  db.prepare(
    `UPDATE threads SET archived_at = ?, end_timestamp = ? WHERE id = ?`,
  ).run(endTimestamp, endTimestamp, threadId);
}

export function getActiveThread(chatJid: string): Thread | undefined {
  return db.prepare(
    `SELECT * FROM threads WHERE chat_jid = ? AND archived_at IS NULL LIMIT 1`,
  ).get(chatJid) as Thread | undefined;
}

export function getThreads(chatJid: string): Thread[] {
  return db.prepare(
    `SELECT * FROM threads WHERE chat_jid = ? ORDER BY created_at DESC`,
  ).all(chatJid) as Thread[];
}

export function getThreadBySlug(
  chatJid: string, slug: string,
): Thread | undefined {
  return db.prepare(
    `SELECT * FROM threads WHERE chat_jid = ? AND slug = ?`,
  ).get(chatJid, slug) as Thread | undefined;
}

export function resumeThread(threadId: string): void {
  db.prepare(
    `UPDATE threads SET archived_at = NULL, end_timestamp = NULL WHERE id = ?`,
  ).run(threadId);
}

export function getMessagesSinceInThread(
  chatJid: string,
  sinceTimestamp: string,
  botPrefix: string,
  threadId: string,
): NewMessage[] {
  const thread = db.prepare(
    `SELECT * FROM threads WHERE id = ?`,
  ).get(threadId) as Thread | undefined;
  if (!thread) return [];

  const effectiveSince =
    sinceTimestamp > thread.start_timestamp
      ? sinceTimestamp
      : thread.start_timestamp;

  if (thread.end_timestamp) {
    return db.prepare(`
      SELECT id, chat_jid, sender, sender_name, content, timestamp
      FROM messages
      WHERE chat_jid = ? AND timestamp > ? AND timestamp < ?
        AND is_bot_message = 0 AND content NOT LIKE ?
        AND content != '' AND content IS NOT NULL
      ORDER BY timestamp
    `).all(
      chatJid, effectiveSince, thread.end_timestamp, `${botPrefix}:%`,
    ) as NewMessage[];
  }

  return db.prepare(`
    SELECT id, chat_jid, sender, sender_name, content, timestamp
    FROM messages
    WHERE chat_jid = ? AND timestamp > ?
      AND is_bot_message = 0 AND content NOT LIKE ?
      AND content != '' AND content IS NOT NULL
    ORDER BY timestamp
  `).all(chatJid, effectiveSince, `${botPrefix}:%`) as NewMessage[];
}

export function getThreadMessageCount(threadId: string): number {
  const thread = db.prepare(
    `SELECT * FROM threads WHERE id = ?`,
  ).get(threadId) as Thread | undefined;
  if (!thread) return 0;

  if (thread.end_timestamp) {
    const row = db.prepare(
      `SELECT COUNT(*) as count FROM messages
       WHERE chat_jid = ? AND timestamp >= ? AND timestamp < ?`,
    ).get(
      thread.chat_jid, thread.start_timestamp, thread.end_timestamp,
    ) as { count: number };
    return row.count;
  }

  const row = db.prepare(
    `SELECT COUNT(*) as count FROM messages
     WHERE chat_jid = ? AND timestamp >= ?`,
  ).get(thread.chat_jid, thread.start_timestamp) as { count: number };
  return row.count;
}

export function updateThreadName(
  threadId: string, name: string, slug: string,
): void {
  db.prepare(
    `UPDATE threads SET name = ?, slug = ? WHERE id = ?`,
  ).run(name, slug, threadId);
}
```

**Step 6: Run tests to verify they pass**

Run: `npx vitest run src/db.test.ts`
Expected: ALL tests PASS

**Step 7: Commit**

```bash
git add src/types.ts src/db.ts src/db.test.ts
git commit -m "feat: add threads table and CRUD for conversation management

Thread model uses timestamp ranges to scope messages.
Supports create, archive, resume, and thread-scoped queries."
```

---

### Task 3: Add clearChat to WhatsApp Channel

**Files:**
- Modify: `src/types.ts:81-92` (Channel interface)
- Modify: `src/channels/whatsapp.ts` (add clearChat method)
- Test: `src/channels/whatsapp.test.ts`

**Step 1: Write the failing test**

Add `chatModify` to `createFakeSocket()` in the test file:
```typescript
chatModify: vi.fn().mockResolvedValue(undefined),
```

Add a new describe block in `src/channels/whatsapp.test.ts`:

```typescript
describe('clearChat', () => {
  it('calls chatModify with clear:true', async () => {
    const opts = createTestOpts();
    const channel = new WhatsAppChannel(opts);

    await connectChannel(channel);

    await channel.clearChat('registered@g.us');

    expect(fakeSocket.chatModify).toHaveBeenCalledWith(
      { clear: true, lastMessages: [] },
      'registered@g.us',
    );
  });

  it('handles clearChat failure gracefully', async () => {
    fakeSocket.chatModify.mockRejectedValueOnce(new Error('Failed'));

    const opts = createTestOpts();
    const channel = new WhatsAppChannel(opts);

    await connectChannel(channel);

    // Should not throw
    await expect(
      channel.clearChat('registered@g.us'),
    ).resolves.toBeUndefined();
  });
});
```

**Step 2: Run tests to verify they fail**

Run: `npx vitest run src/channels/whatsapp.test.ts`
Expected: FAIL — `clearChat` doesn't exist yet

**Step 3: Add clearChat to Channel interface**

In `src/types.ts`, add to the `Channel` interface (after `sendAudio`):
```typescript
clearChat?(jid: string): Promise<void>;
```

**Step 4: Implement clearChat in WhatsAppChannel**

In `src/channels/whatsapp.ts`, add after `sendAudio()` method:
```typescript
async clearChat(jid: string): Promise<void> {
  if (!this.connected || !this.sock) {
    logger.warn({ jid }, 'WA disconnected, cannot clear chat');
    return;
  }
  try {
    await this.sock.chatModify({ clear: true, lastMessages: [] }, jid);
    logger.info({ jid }, 'Chat cleared');
  } catch (err) {
    logger.warn({ jid, err }, 'Failed to clear chat');
  }
}
```

**Step 5: Run tests to verify they pass**

Run: `npx vitest run src/channels/whatsapp.test.ts`
Expected: ALL tests PASS

**Step 6: Commit**

```bash
git add src/types.ts src/channels/whatsapp.ts src/channels/whatsapp.test.ts
git commit -m "feat: add clearChat method to WhatsApp channel

Uses Baileys chatModify({clear:true}) to clear chat history.
Added as optional method on Channel interface."
```

---

### Task 4: Intercept Thread Commands in Message Loop

**Files:**
- Modify: `src/index.ts:149-293` (processGroupMessages)
- Modify: `src/router.ts` (add slugify helper)
- Test: `src/formatting.test.ts`

**Step 1: Add slugify helper to router.ts**

Add to `src/router.ts`:
```typescript
export function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 40) || 'untitled';
}
```

**Step 2: Write tests for slugify**

Add to `src/formatting.test.ts` (update imports to include `slugify`):
```typescript
import { slugify } from './router.js';

describe('slugify', () => {
  it('converts text to lowercase slug', () => {
    expect(slugify('Hello World')).toBe('hello-world');
  });

  it('strips special characters', () => {
    expect(slugify('Hello! @World #123')).toBe('hello-world-123');
  });

  it('truncates to 40 chars', () => {
    const long = 'a'.repeat(60);
    expect(slugify(long).length).toBeLessThanOrEqual(40);
  });

  it('returns untitled for empty input', () => {
    expect(slugify('')).toBe('untitled');
    expect(slugify('!!!')).toBe('untitled');
  });
});
```

**Step 3: Run slugify tests**

Run: `npx vitest run src/formatting.test.ts`
Expected: ALL PASS

**Step 4: Add thread command interception to index.ts**

In `src/index.ts`, add imports at the top:
```typescript
import { randomUUID } from 'crypto';
import {
  archiveThread,
  createThread,
  getActiveThread,
  getMessagesSinceInThread,
  getThreadBySlug,
  getThreadMessageCount,
  getThreads,
  resumeThread,
  updateThreadName,
} from './db.js';
```

Also import `slugify` from `./router.js`.

Add a `THREAD_COMMANDS` constant and `handleThreadCommand` function before `processGroupMessages`:

```typescript
const THREAD_COMMANDS = /^\/(new|reset|threads|resume)\b/;

async function handleThreadCommand(
  chatJid: string,
  content: string,
  channel: Channel,
): Promise<boolean> {
  const match = content.trim().match(THREAD_COMMANDS);
  if (!match) return false;

  const command = match[1];

  if (command === 'new' || command === 'reset') {
    const now = new Date().toISOString();
    const active = getActiveThread(chatJid);

    if (active) {
      archiveThread(active.id, now);
      logger.info(
        { chatJid, threadId: active.id, threadName: active.name },
        'Thread archived',
      );
    }

    const newId = randomUUID();
    const newSlug = `thread-${Date.now()}`;
    createThread({
      id: newId,
      chat_jid: chatJid,
      name: 'New conversation',
      slug: newSlug,
      created_at: now,
      start_timestamp: now,
    });

    await channel.clearChat?.(chatJid);

    const archivedInfo = active
      ? ` Previous thread "${active.name}" archived.`
      : '';
    await channel.sendMessage(
      chatJid,
      `Fresh conversation started.${archivedInfo}`,
    );

    lastAgentTimestamp[chatJid] = now;
    saveState();

    return true;
  }

  if (command === 'threads') {
    const threads = getThreads(chatJid);
    if (threads.length === 0) {
      await channel.sendMessage(
        chatJid,
        'No threads yet. Send /new to start one.',
      );
      return true;
    }

    const lines = threads.map((t, i) => {
      const status = t.archived_at ? '' : ' (active)';
      const count = getThreadMessageCount(t.id);
      const date = t.created_at.split('T')[0];
      return `${i + 1}. ${t.slug}${status} — "${t.name}" (${date}, ${count} msgs)`;
    });

    await channel.sendMessage(
      chatJid,
      `Threads:\n${lines.join('\n')}`,
    );
    return true;
  }

  if (command === 'resume') {
    const slug = content.trim().split(/\s+/)[1];
    if (!slug) {
      await channel.sendMessage(chatJid, 'Usage: /resume <slug>');
      return true;
    }

    const target = getThreadBySlug(chatJid, slug);
    if (!target) {
      await channel.sendMessage(
        chatJid,
        `Thread "${slug}" not found. Use /threads to list.`,
      );
      return true;
    }

    if (!target.archived_at) {
      await channel.sendMessage(
        chatJid,
        `Thread "${slug}" is already active.`,
      );
      return true;
    }

    const now = new Date().toISOString();
    const active = getActiveThread(chatJid);
    if (active) {
      archiveThread(active.id, now);
    }

    resumeThread(target.id);
    await channel.clearChat?.(chatJid);
    await channel.sendMessage(
      chatJid,
      `Resumed thread "${target.name}".`,
    );

    lastAgentTimestamp[chatJid] = target.start_timestamp;
    saveState();

    return true;
  }

  return false;
}
```

**Step 5: Wire into processGroupMessages**

In `processGroupMessages()`, after fetching `missedMessages` (around line 162-168), add thread command handling and replace the rest of the message processing logic:

After `if (missedMessages.length === 0) return true;`, insert:

```typescript
// Handle thread commands before agent processing
for (const msg of missedMessages) {
  if (THREAD_COMMANDS.test(msg.content.trim())) {
    const handled = await handleThreadCommand(chatJid, msg.content, channel);
    if (handled) {
      lastAgentTimestamp[chatJid] = msg.timestamp;
      saveState();
    }
  }
}

// Re-fetch messages using thread scope
const activeThread = getActiveThread(chatJid);
const threadMessages = activeThread
  ? getMessagesSinceInThread(
      chatJid, lastAgentTimestamp[chatJid] || '', ASSISTANT_NAME, activeThread.id,
    )
  : getMessagesSince(chatJid, lastAgentTimestamp[chatJid] || '', ASSISTANT_NAME);

// Filter out thread commands from agent input
const agentMessages = threadMessages.filter(
  m => !THREAD_COMMANDS.test(m.content.trim()),
);

if (agentMessages.length === 0) return true;
```

Then replace the reference to `missedMessages` in the rest of the function with `agentMessages`.

Also add thread auto-naming after the filter:
```typescript
// Auto-name thread from first user message
if (
  activeThread &&
  activeThread.name === 'New conversation' &&
  agentMessages.length > 0
) {
  const firstContent = agentMessages[0].content;
  const autoName = firstContent.slice(0, 60).replace(/\n/g, ' ');
  updateThreadName(activeThread.id, autoName, slugify(autoName));
}
```

**Step 6: Run all tests**

Run: `npx vitest run`
Expected: ALL tests PASS

**Step 7: Run typecheck**

Run: `npx tsc --noEmit`
Expected: No errors

**Step 8: Commit**

```bash
git add src/index.ts src/router.ts src/formatting.test.ts
git commit -m "feat: intercept thread commands (/new, /threads, /resume)

/new archives current thread, creates fresh one, clears WA chat.
/threads lists all threads with message counts.
/resume restores an archived thread.
Auto-names threads from first user message content."
```

---

### Task 5: Ensure Default Thread on Startup

**Files:**
- Modify: `src/index.ts` (startup section)

**Step 1: Add ensureDefaultThreads function**

In `src/index.ts`, add after `recoverPendingMessages`:

```typescript
function ensureDefaultThreads(): void {
  for (const chatJid of Object.keys(registeredGroups)) {
    const active = getActiveThread(chatJid);
    if (!active) {
      const id = randomUUID();
      const now = new Date().toISOString();
      createThread({
        id,
        chat_jid: chatJid,
        name: 'Default',
        slug: 'default',
        created_at: now,
        start_timestamp: '',
      });
      logger.info({ chatJid }, 'Created default thread for group');
    }
  }
}
```

**Step 2: Call from main()**

In `main()`, after `loadState()` and before `recoverPendingMessages()`:
```typescript
ensureDefaultThreads();
```

**Step 3: Run all tests and typecheck**

Run: `npx vitest run && npx tsc --noEmit`
Expected: ALL pass, no type errors

**Step 4: Build the project**

Run: `npm run build`
Expected: Compiles with no errors

**Step 5: Commit**

```bash
git add src/index.ts
git commit -m "feat: ensure default thread exists on startup

Creates a default thread for groups that don't have one,
with start_timestamp='' to include all historical messages."
```

---

### Task 6: Final Integration Check

**Step 1: Build**

Run: `npm run build`
Expected: No errors

**Step 2: Full test suite**

Run: `npx vitest run`
Expected: ALL tests PASS

**Step 3: Typecheck**

Run: `npx tsc --noEmit`
Expected: No type errors
