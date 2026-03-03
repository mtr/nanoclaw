import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';

import { ASSISTANT_NAME, DATA_DIR, STORE_DIR } from './config.js';
import { isValidGroupFolder } from './group-folder.js';
import { logger } from './logger.js';
import {
  NewMessage,
  RegisteredGroup,
  ScheduledTask,
  TaskRunLog,
  Thread,
} from './types.js';

let db: Database.Database;

function createSchema(database: Database.Database): void {
  database.exec(`
    CREATE TABLE IF NOT EXISTS chats (
      jid TEXT PRIMARY KEY,
      name TEXT,
      last_message_time TEXT,
      channel TEXT,
      is_group INTEGER DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS messages (
      id TEXT,
      chat_jid TEXT,
      sender TEXT,
      sender_name TEXT,
      content TEXT,
      timestamp TEXT,
      is_from_me INTEGER,
      is_bot_message INTEGER DEFAULT 0,
      PRIMARY KEY (id, chat_jid),
      FOREIGN KEY (chat_jid) REFERENCES chats(jid)
    );
    CREATE INDEX IF NOT EXISTS idx_timestamp ON messages(timestamp);

    CREATE TABLE IF NOT EXISTS scheduled_tasks (
      id TEXT PRIMARY KEY,
      group_folder TEXT NOT NULL,
      chat_jid TEXT NOT NULL,
      prompt TEXT NOT NULL,
      schedule_type TEXT NOT NULL,
      schedule_value TEXT NOT NULL,
      next_run TEXT,
      last_run TEXT,
      last_result TEXT,
      status TEXT DEFAULT 'active',
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_next_run ON scheduled_tasks(next_run);
    CREATE INDEX IF NOT EXISTS idx_status ON scheduled_tasks(status);

    CREATE TABLE IF NOT EXISTS task_run_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      task_id TEXT NOT NULL,
      run_at TEXT NOT NULL,
      duration_ms INTEGER NOT NULL,
      status TEXT NOT NULL,
      result TEXT,
      error TEXT,
      FOREIGN KEY (task_id) REFERENCES scheduled_tasks(id)
    );
    CREATE INDEX IF NOT EXISTS idx_task_run_logs ON task_run_logs(task_id, run_at);

    CREATE TABLE IF NOT EXISTS router_state (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS sessions (
      thread_id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL
    );
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
    CREATE TABLE IF NOT EXISTS registered_groups (
      jid TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      folder TEXT NOT NULL UNIQUE,
      trigger_pattern TEXT NOT NULL,
      added_at TEXT NOT NULL,
      container_config TEXT,
      requires_trigger INTEGER DEFAULT 1
    );
    CREATE TABLE IF NOT EXISTS threads (
      id TEXT PRIMARY KEY,
      chat_jid TEXT NOT NULL,
      name TEXT NOT NULL,
      slug TEXT NOT NULL,
      created_at TEXT NOT NULL,
      passive_at TEXT,
      archived_at TEXT,
      start_timestamp TEXT NOT NULL,
      end_timestamp TEXT,
      UNIQUE(chat_jid, slug)
    );
    CREATE INDEX IF NOT EXISTS idx_threads_chat_jid ON threads(chat_jid);
  `);

  // Add context_mode column if it doesn't exist (migration for existing DBs)
  try {
    database.exec(
      `ALTER TABLE scheduled_tasks ADD COLUMN context_mode TEXT DEFAULT 'isolated'`,
    );
  } catch {
    /* column already exists */
  }

  // Add is_bot_message column if it doesn't exist (migration for existing DBs)
  try {
    database.exec(
      `ALTER TABLE messages ADD COLUMN is_bot_message INTEGER DEFAULT 0`,
    );
    // Backfill: mark existing bot messages that used the content prefix pattern
    database
      .prepare(`UPDATE messages SET is_bot_message = 1 WHERE content LIKE ?`)
      .run(`${ASSISTANT_NAME}:%`);
  } catch {
    /* column already exists */
  }

  // Add channel and is_group columns if they don't exist (migration for existing DBs)
  try {
    database.exec(`ALTER TABLE chats ADD COLUMN channel TEXT`);
    database.exec(`ALTER TABLE chats ADD COLUMN is_group INTEGER DEFAULT 0`);
    // Backfill from JID patterns
    database.exec(
      `UPDATE chats SET channel = 'whatsapp', is_group = 1 WHERE jid LIKE '%@g.us'`,
    );
    database.exec(
      `UPDATE chats SET channel = 'whatsapp', is_group = 0 WHERE jid LIKE '%@s.whatsapp.net'`,
    );
    database.exec(
      `UPDATE chats SET channel = 'discord', is_group = 1 WHERE jid LIKE 'dc:%'`,
    );
    database.exec(
      `UPDATE chats SET channel = 'telegram', is_group = 1 WHERE jid LIKE 'tg:%'`,
    );
  } catch {
    /* columns already exist */
  }

  // Rename archived_at → passive_at and add new archived_at for explicit archive
  try {
    database.exec(
      `ALTER TABLE threads RENAME COLUMN archived_at TO passive_at`,
    );
    database.exec(`ALTER TABLE threads ADD COLUMN archived_at TEXT`);
  } catch {
    /* already applied */
  }

  // Migrate sessions table from group_folder-keyed to thread_id-keyed.
  // The old schema stored one session per group, which caused stale context
  // (including voice blobs) to persist across thread resets. The new schema
  // ties sessions to threads so /new starts fresh and /resume restores context.
  try {
    // Check if the old schema exists by looking for the group_folder column
    const hasOldSchema = database
      .prepare(
        `SELECT COUNT(*) as cnt FROM pragma_table_info('sessions') WHERE name = 'group_folder'`,
      )
      .get() as { cnt: number };
    if (hasOldSchema.cnt > 0) {
      database.exec(`DROP TABLE sessions`);
      database.exec(`
        CREATE TABLE sessions (
          thread_id TEXT PRIMARY KEY,
          session_id TEXT NOT NULL
        )
      `);
    }
  } catch {
    /* migration already applied or table doesn't exist yet */
  }
}

export function initDatabase(): void {
  const dbPath = path.join(STORE_DIR, 'messages.db');
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });

  db = new Database(dbPath);
  createSchema(db);

  // Migrate from JSON files if they exist
  migrateJsonState();
}

/** @internal - for tests only. Creates a fresh in-memory database. */
export function _initTestDatabase(): void {
  db = new Database(':memory:');
  createSchema(db);
}

/** Returns the active database instance. */
export function getDb(): Database.Database {
  return db;
}

/**
 * Store chat metadata only (no message content).
 * Used for all chats to enable group discovery without storing sensitive content.
 */
export function storeChatMetadata(
  chatJid: string,
  timestamp: string,
  name?: string,
  channel?: string,
  isGroup?: boolean,
): void {
  const ch = channel ?? null;
  const group = isGroup === undefined ? null : isGroup ? 1 : 0;

  if (name) {
    // Update with name, preserving existing timestamp if newer
    db.prepare(
      `
      INSERT INTO chats (jid, name, last_message_time, channel, is_group) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(jid) DO UPDATE SET
        name = excluded.name,
        last_message_time = MAX(last_message_time, excluded.last_message_time),
        channel = COALESCE(excluded.channel, channel),
        is_group = COALESCE(excluded.is_group, is_group)
    `,
    ).run(chatJid, name, timestamp, ch, group);
  } else {
    // Update timestamp only, preserve existing name if any
    db.prepare(
      `
      INSERT INTO chats (jid, name, last_message_time, channel, is_group) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(jid) DO UPDATE SET
        last_message_time = MAX(last_message_time, excluded.last_message_time),
        channel = COALESCE(excluded.channel, channel),
        is_group = COALESCE(excluded.is_group, is_group)
    `,
    ).run(chatJid, chatJid, timestamp, ch, group);
  }
}

/**
 * Update chat name without changing timestamp for existing chats.
 * New chats get the current time as their initial timestamp.
 * Used during group metadata sync.
 */
export function updateChatName(chatJid: string, name: string): void {
  db.prepare(
    `
    INSERT INTO chats (jid, name, last_message_time) VALUES (?, ?, ?)
    ON CONFLICT(jid) DO UPDATE SET name = excluded.name
  `,
  ).run(chatJid, name, new Date().toISOString());
}

export interface ChatInfo {
  jid: string;
  name: string;
  last_message_time: string;
  channel: string;
  is_group: number;
}

/**
 * Get all known chats, ordered by most recent activity.
 */
export function getAllChats(): ChatInfo[] {
  return db
    .prepare(
      `
    SELECT jid, name, last_message_time, channel, is_group
    FROM chats
    ORDER BY last_message_time DESC
  `,
    )
    .all() as ChatInfo[];
}

/**
 * Get timestamp of last group metadata sync.
 */
export function getLastGroupSync(): string | null {
  // Store sync time in a special chat entry
  const row = db
    .prepare(`SELECT last_message_time FROM chats WHERE jid = '__group_sync__'`)
    .get() as { last_message_time: string } | undefined;
  return row?.last_message_time || null;
}

/**
 * Record that group metadata was synced.
 */
export function setLastGroupSync(): void {
  const now = new Date().toISOString();
  db.prepare(
    `INSERT OR REPLACE INTO chats (jid, name, last_message_time) VALUES ('__group_sync__', '__group_sync__', ?)`,
  ).run(now);
}

/**
 * Store a message with full content.
 * Only call this for registered groups where message history is needed.
 */
export function storeMessage(msg: NewMessage): void {
  db.prepare(
    `INSERT OR REPLACE INTO messages (id, chat_jid, sender, sender_name, content, timestamp, is_from_me, is_bot_message) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    msg.id,
    msg.chat_jid,
    msg.sender,
    msg.sender_name,
    msg.content,
    msg.timestamp,
    msg.is_from_me ? 1 : 0,
    msg.is_bot_message ? 1 : 0,
  );
}

/**
 * Store a message directly (for non-WhatsApp channels that don't use Baileys proto).
 */
export function storeMessageDirect(msg: {
  id: string;
  chat_jid: string;
  sender: string;
  sender_name: string;
  content: string;
  timestamp: string;
  is_from_me: boolean;
  is_bot_message?: boolean;
}): void {
  db.prepare(
    `INSERT OR REPLACE INTO messages (id, chat_jid, sender, sender_name, content, timestamp, is_from_me, is_bot_message) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    msg.id,
    msg.chat_jid,
    msg.sender,
    msg.sender_name,
    msg.content,
    msg.timestamp,
    msg.is_from_me ? 1 : 0,
    msg.is_bot_message ? 1 : 0,
  );
}

export function getNewMessages(
  jids: string[],
  lastTimestamp: string,
  botPrefix: string,
): { messages: NewMessage[]; newTimestamp: string } {
  if (jids.length === 0) return { messages: [], newTimestamp: lastTimestamp };

  const placeholders = jids.map(() => '?').join(',');
  // Filter bot messages using both the is_bot_message flag AND the content
  // prefix as a backstop for messages written before the migration ran.
  const sql = `
    SELECT id, chat_jid, sender, sender_name, content, timestamp
    FROM messages
    WHERE timestamp > ? AND chat_jid IN (${placeholders})
      AND is_bot_message = 0 AND content NOT LIKE ?
      AND content != '' AND content IS NOT NULL
    ORDER BY timestamp
  `;

  const rows = db
    .prepare(sql)
    .all(lastTimestamp, ...jids, `${botPrefix}:%`) as NewMessage[];

  let newTimestamp = lastTimestamp;
  for (const row of rows) {
    if (row.timestamp > newTimestamp) newTimestamp = row.timestamp;
  }

  return { messages: rows, newTimestamp };
}

export function getMessagesSince(
  chatJid: string,
  sinceTimestamp: string,
  botPrefix: string,
): NewMessage[] {
  // Filter bot messages using both the is_bot_message flag AND the content
  // prefix as a backstop for messages written before the migration ran.
  const sql = `
    SELECT id, chat_jid, sender, sender_name, content, timestamp
    FROM messages
    WHERE chat_jid = ? AND timestamp > ?
      AND is_bot_message = 0 AND content NOT LIKE ?
      AND content != '' AND content IS NOT NULL
    ORDER BY timestamp
  `;
  return db
    .prepare(sql)
    .all(chatJid, sinceTimestamp, `${botPrefix}:%`) as NewMessage[];
}

export function createTask(
  task: Omit<ScheduledTask, 'last_run' | 'last_result'>,
): void {
  db.prepare(
    `
    INSERT INTO scheduled_tasks (id, group_folder, chat_jid, prompt, schedule_type, schedule_value, context_mode, next_run, status, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `,
  ).run(
    task.id,
    task.group_folder,
    task.chat_jid,
    task.prompt,
    task.schedule_type,
    task.schedule_value,
    task.context_mode || 'isolated',
    task.next_run,
    task.status,
    task.created_at,
  );
}

export function getTaskById(id: string): ScheduledTask | undefined {
  return db.prepare('SELECT * FROM scheduled_tasks WHERE id = ?').get(id) as
    | ScheduledTask
    | undefined;
}

export function getTasksForGroup(groupFolder: string): ScheduledTask[] {
  return db
    .prepare(
      'SELECT * FROM scheduled_tasks WHERE group_folder = ? ORDER BY created_at DESC',
    )
    .all(groupFolder) as ScheduledTask[];
}

export function getAllTasks(): ScheduledTask[] {
  return db
    .prepare('SELECT * FROM scheduled_tasks ORDER BY created_at DESC')
    .all() as ScheduledTask[];
}

export function updateTask(
  id: string,
  updates: Partial<
    Pick<
      ScheduledTask,
      'prompt' | 'schedule_type' | 'schedule_value' | 'next_run' | 'status'
    >
  >,
): void {
  const fields: string[] = [];
  const values: unknown[] = [];

  if (updates.prompt !== undefined) {
    fields.push('prompt = ?');
    values.push(updates.prompt);
  }
  if (updates.schedule_type !== undefined) {
    fields.push('schedule_type = ?');
    values.push(updates.schedule_type);
  }
  if (updates.schedule_value !== undefined) {
    fields.push('schedule_value = ?');
    values.push(updates.schedule_value);
  }
  if (updates.next_run !== undefined) {
    fields.push('next_run = ?');
    values.push(updates.next_run);
  }
  if (updates.status !== undefined) {
    fields.push('status = ?');
    values.push(updates.status);
  }

  if (fields.length === 0) return;

  values.push(id);
  db.prepare(
    `UPDATE scheduled_tasks SET ${fields.join(', ')} WHERE id = ?`,
  ).run(...values);
}

export function deleteTask(id: string): void {
  // Delete child records first (FK constraint)
  db.prepare('DELETE FROM task_run_logs WHERE task_id = ?').run(id);
  db.prepare('DELETE FROM scheduled_tasks WHERE id = ?').run(id);
}

export function getDueTasks(): ScheduledTask[] {
  const now = new Date().toISOString();
  return db
    .prepare(
      `
    SELECT * FROM scheduled_tasks
    WHERE status = 'active' AND next_run IS NOT NULL AND next_run <= ?
    ORDER BY next_run
  `,
    )
    .all(now) as ScheduledTask[];
}

export function updateTaskAfterRun(
  id: string,
  nextRun: string | null,
  lastResult: string,
): void {
  const now = new Date().toISOString();
  db.prepare(
    `
    UPDATE scheduled_tasks
    SET next_run = ?, last_run = ?, last_result = ?, status = CASE WHEN ? IS NULL THEN 'completed' ELSE status END
    WHERE id = ?
  `,
  ).run(nextRun, now, lastResult, nextRun, id);
}

export function logTaskRun(log: TaskRunLog): void {
  db.prepare(
    `
    INSERT INTO task_run_logs (task_id, run_at, duration_ms, status, result, error)
    VALUES (?, ?, ?, ?, ?, ?)
  `,
  ).run(
    log.task_id,
    log.run_at,
    log.duration_ms,
    log.status,
    log.result,
    log.error,
  );
}

// --- Router state accessors ---

export function getRouterState(key: string): string | undefined {
  const row = db
    .prepare('SELECT value FROM router_state WHERE key = ?')
    .get(key) as { value: string } | undefined;
  return row?.value;
}

export function setRouterState(key: string, value: string): void {
  db.prepare(
    'INSERT OR REPLACE INTO router_state (key, value) VALUES (?, ?)',
  ).run(key, value);
}

// --- Session accessors (keyed by thread ID) ---

export function getSession(threadId: string): string | undefined {
  const row = db
    .prepare('SELECT session_id FROM sessions WHERE thread_id = ?')
    .get(threadId) as { session_id: string } | undefined;
  return row?.session_id;
}

export function setSession(threadId: string, sessionId: string): void {
  db.prepare(
    'INSERT OR REPLACE INTO sessions (thread_id, session_id) VALUES (?, ?)',
  ).run(threadId, sessionId);
}

export function deleteSession(threadId: string): void {
  db.prepare('DELETE FROM sessions WHERE thread_id = ?').run(threadId);
}

export function getAllSessions(): Record<string, string> {
  const rows = db
    .prepare('SELECT thread_id, session_id FROM sessions')
    .all() as Array<{ thread_id: string; session_id: string }>;
  const result: Record<string, string> = {};
  for (const row of rows) {
    result[row.thread_id] = row.session_id;
  }
  return result;
}

// --- Thread accessors ---

export function createThread(
  thread: Omit<Thread, 'passive_at' | 'archived_at' | 'end_timestamp'>,
): void {
  db.prepare(
    `INSERT INTO threads (id, chat_jid, name, slug, created_at, start_timestamp)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(
    thread.id,
    thread.chat_jid,
    thread.name,
    thread.slug,
    thread.created_at,
    thread.start_timestamp,
  );
}

/** Auto-archive: marks a thread as passively archived (via /new or /resume). */
export function passivateThread(threadId: string, endTimestamp: string): void {
  db.prepare(
    `UPDATE threads SET passive_at = ?, end_timestamp = ? WHERE id = ?`,
  ).run(endTimestamp, endTimestamp, threadId);
}

/** Explicit archive: marks a thread as intentionally archived via /archive. */
export function archiveThread(threadId: string, timestamp: string): void {
  db.prepare(
    `UPDATE threads SET archived_at = ?, end_timestamp = ?,
     passive_at = COALESCE(passive_at, ?) WHERE id = ?`,
  ).run(timestamp, timestamp, timestamp, threadId);
}

/** Clears explicit archive flag. Thread remains passively archived (needs /resume). */
export function unarchiveThread(threadId: string): void {
  db.prepare(`UPDATE threads SET archived_at = NULL WHERE id = ?`).run(
    threadId,
  );
}

export function getActiveThread(chatJid: string): Thread | undefined {
  return db
    .prepare(
      `SELECT * FROM threads WHERE chat_jid = ? AND passive_at IS NULL AND archived_at IS NULL LIMIT 1`,
    )
    .get(chatJid) as Thread | undefined;
}

export function getThreads(
  chatJid: string,
  opts?: { includeArchived?: boolean; onlyArchived?: boolean },
): Thread[] {
  if (opts?.onlyArchived) {
    return db
      .prepare(
        `SELECT * FROM threads WHERE chat_jid = ? AND archived_at IS NOT NULL ORDER BY created_at DESC`,
      )
      .all(chatJid) as Thread[];
  }
  if (opts?.includeArchived) {
    return db
      .prepare(
        `SELECT * FROM threads WHERE chat_jid = ? ORDER BY created_at DESC`,
      )
      .all(chatJid) as Thread[];
  }
  // Default: exclude explicitly archived
  return db
    .prepare(
      `SELECT * FROM threads WHERE chat_jid = ? AND archived_at IS NULL ORDER BY created_at DESC`,
    )
    .all(chatJid) as Thread[];
}

export function getThreadBySlug(
  chatJid: string,
  slug: string,
): Thread | undefined {
  return db
    .prepare(`SELECT * FROM threads WHERE chat_jid = ? AND slug = ?`)
    .get(chatJid, slug) as Thread | undefined;
}

export function resumeThread(threadId: string): void {
  // Look up the thread to passivate any other active thread for the same group
  const thread = db
    .prepare(`SELECT chat_jid FROM threads WHERE id = ?`)
    .get(threadId) as { chat_jid: string } | undefined;
  if (thread) {
    const now = new Date().toISOString();
    db.prepare(
      `UPDATE threads SET passive_at = ?, end_timestamp = ? WHERE chat_jid = ? AND passive_at IS NULL AND archived_at IS NULL AND id != ?`,
    ).run(now, now, thread.chat_jid, threadId);
  }
  db.prepare(
    `UPDATE threads SET passive_at = NULL, archived_at = NULL, end_timestamp = NULL WHERE id = ?`,
  ).run(threadId);
}

export function getMessagesSinceInThread(
  chatJid: string,
  sinceTimestamp: string,
  botPrefix: string,
  threadId: string,
): NewMessage[] {
  const thread = db
    .prepare(`SELECT * FROM threads WHERE id = ?`)
    .get(threadId) as Thread | undefined;
  if (!thread) return [];

  const effectiveSince =
    sinceTimestamp > thread.start_timestamp
      ? sinceTimestamp
      : thread.start_timestamp;

  if (thread.end_timestamp) {
    return db
      .prepare(
        `
      SELECT id, chat_jid, sender, sender_name, content, timestamp
      FROM messages
      WHERE chat_jid = ? AND timestamp > ? AND timestamp < ?
        AND is_bot_message = 0 AND content NOT LIKE ?
        AND content != '' AND content IS NOT NULL
      ORDER BY timestamp
    `,
      )
      .all(
        chatJid,
        effectiveSince,
        thread.end_timestamp,
        `${botPrefix}:%`,
      ) as NewMessage[];
  }

  return db
    .prepare(
      `
    SELECT id, chat_jid, sender, sender_name, content, timestamp
    FROM messages
    WHERE chat_jid = ? AND timestamp > ?
      AND is_bot_message = 0 AND content NOT LIKE ?
      AND content != '' AND content IS NOT NULL
    ORDER BY timestamp
  `,
    )
    .all(chatJid, effectiveSince, `${botPrefix}:%`) as NewMessage[];
}

export function getThreadMessageCount(threadId: string): number {
  const thread = db
    .prepare(`SELECT * FROM threads WHERE id = ?`)
    .get(threadId) as Thread | undefined;
  if (!thread) return 0;

  if (thread.end_timestamp) {
    const row = db
      .prepare(
        `SELECT COUNT(*) as count FROM messages
       WHERE chat_jid = ? AND timestamp > ? AND timestamp < ?`,
      )
      .get(thread.chat_jid, thread.start_timestamp, thread.end_timestamp) as {
      count: number;
    };
    return row.count;
  }

  const row = db
    .prepare(
      `SELECT COUNT(*) as count FROM messages
     WHERE chat_jid = ? AND timestamp > ?`,
    )
    .get(thread.chat_jid, thread.start_timestamp) as { count: number };
  return row.count;
}

export function updateThreadName(
  threadId: string,
  name: string,
  slug: string,
): void {
  db.prepare(`UPDATE threads SET name = ?, slug = ? WHERE id = ?`).run(
    name,
    slug,
    threadId,
  );
}

// --- Registered group accessors ---

export function getRegisteredGroup(
  jid: string,
): (RegisteredGroup & { jid: string }) | undefined {
  const row = db
    .prepare('SELECT * FROM registered_groups WHERE jid = ?')
    .get(jid) as
    | {
        jid: string;
        name: string;
        folder: string;
        trigger_pattern: string;
        added_at: string;
        container_config: string | null;
        requires_trigger: number | null;
      }
    | undefined;
  if (!row) return undefined;
  if (!isValidGroupFolder(row.folder)) {
    logger.warn(
      { jid: row.jid, folder: row.folder },
      'Skipping registered group with invalid folder',
    );
    return undefined;
  }
  return {
    jid: row.jid,
    name: row.name,
    folder: row.folder,
    trigger: row.trigger_pattern,
    added_at: row.added_at,
    containerConfig: row.container_config
      ? JSON.parse(row.container_config)
      : undefined,
    requiresTrigger:
      row.requires_trigger === null ? undefined : row.requires_trigger === 1,
  };
}

export function setRegisteredGroup(jid: string, group: RegisteredGroup): void {
  if (!isValidGroupFolder(group.folder)) {
    throw new Error(`Invalid group folder "${group.folder}" for JID ${jid}`);
  }
  db.prepare(
    `INSERT OR REPLACE INTO registered_groups (jid, name, folder, trigger_pattern, added_at, container_config, requires_trigger)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    jid,
    group.name,
    group.folder,
    group.trigger,
    group.added_at,
    group.containerConfig ? JSON.stringify(group.containerConfig) : null,
    group.requiresTrigger === undefined ? 1 : group.requiresTrigger ? 1 : 0,
  );
}

export function getAllRegisteredGroups(): Record<string, RegisteredGroup> {
  const rows = db.prepare('SELECT * FROM registered_groups').all() as Array<{
    jid: string;
    name: string;
    folder: string;
    trigger_pattern: string;
    added_at: string;
    container_config: string | null;
    requires_trigger: number | null;
  }>;
  const result: Record<string, RegisteredGroup> = {};
  for (const row of rows) {
    if (!isValidGroupFolder(row.folder)) {
      logger.warn(
        { jid: row.jid, folder: row.folder },
        'Skipping registered group with invalid folder',
      );
      continue;
    }
    result[row.jid] = {
      name: row.name,
      folder: row.folder,
      trigger: row.trigger_pattern,
      added_at: row.added_at,
      containerConfig: row.container_config
        ? JSON.parse(row.container_config)
        : undefined,
      requiresTrigger:
        row.requires_trigger === null ? undefined : row.requires_trigger === 1,
    };
  }
  return result;
}

// --- JSON migration ---

function migrateJsonState(): void {
  const migrateFile = (filename: string) => {
    const filePath = path.join(DATA_DIR, filename);
    if (!fs.existsSync(filePath)) return null;
    try {
      const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
      fs.renameSync(filePath, `${filePath}.migrated`);
      return data;
    } catch {
      return null;
    }
  };

  // Migrate router_state.json
  const routerState = migrateFile('router_state.json') as {
    last_timestamp?: string;
    last_agent_timestamp?: Record<string, string>;
  } | null;
  if (routerState) {
    if (routerState.last_timestamp) {
      setRouterState('last_timestamp', routerState.last_timestamp);
    }
    if (routerState.last_agent_timestamp) {
      setRouterState(
        'last_agent_timestamp',
        JSON.stringify(routerState.last_agent_timestamp),
      );
    }
  }

  // Migrate sessions.json (legacy: group_folder-keyed, no longer used)
  // These entries are harmless — they won't match any thread_id and will be
  // naturally superseded as new thread-scoped sessions are created.
  const sessions = migrateFile('sessions.json') as Record<
    string,
    string
  > | null;
  if (sessions) {
    // Skip — old format used group_folder keys, not thread IDs
  }

  // Migrate registered_groups.json
  const groups = migrateFile('registered_groups.json') as Record<
    string,
    RegisteredGroup
  > | null;
  if (groups) {
    for (const [jid, group] of Object.entries(groups)) {
      try {
        setRegisteredGroup(jid, group);
      } catch (err) {
        logger.warn(
          { jid, folder: group.folder, err },
          'Skipping migrated registered group with invalid folder',
        );
      }
    }
  }
}
