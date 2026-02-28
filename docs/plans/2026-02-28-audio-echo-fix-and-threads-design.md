# Audio Echo-Loop Fix & Thread Management

Date: 2026-02-28

## Problem 1: Audio Echo-Loop

When TTS is enabled, every bot reply sends two things to WhatsApp:
1. A text message prefixed with `Lulu:` (correctly tagged `is_bot_message=1`)
2. An audio voice note (no prefix — just audio bytes)

The audio voice note echoes back through `messages.upsert`, gets transcribed by Whisper, and is stored as `[Voice: ...]` with `is_bot_message=0`. After a server restart, the system treats these transcriptions as user messages, creating an echo loop where Lulu thinks the user is repeating her own words back to her.

### Solution: Track Outbound Audio Message IDs (Approach B)

1. `WhatsAppChannel.sendAudio()` captures the returned `WAMessageKey.id` and adds it to an in-memory `Set<string>` called `sentAudioIds`.

2. The `messages.upsert` handler checks incoming voice messages against `sentAudioIds` before transcribing. If matched:
   - Remove from set
   - Store with `is_bot_message=true`, content `[Bot Audio]`
   - Skip transcription

3. Secondary guard: also check `fromMe` as a fallback for the case where the server restarts between sending audio and receiving the echo.

4. Size cap of 100 entries on `sentAudioIds` as a safety net.

### Files to modify
- `src/channels/whatsapp.ts` — add `sentAudioIds`, update `sendAudio()`, update `messages.upsert` handler

## Problem 2: No Chat/Thread Management

All messages in a group accumulate in a single stream. There's no way to start a fresh conversation — every invocation gets the full backlog since the last cursor position.

### Solution: DB-Backed Thread Model

#### Schema

```sql
CREATE TABLE threads (
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
```

#### Thread lifecycle

- Each group has exactly one active thread (`archived_at IS NULL`).
- On startup, if a group has no active thread, create a default one with `start_timestamp` set to the earliest message timestamp (or epoch).

#### Commands

| Command | Action |
|---------|--------|
| `/new` or `/reset` | Archive current thread, create new one, clear WhatsApp chat, confirm |
| `/threads` | List all threads for this group (slug, name, date range, message count) |
| `/resume <slug>` | Archive current thread, un-archive target, clear WhatsApp chat |

#### Message querying

`getMessagesSince()` gains thread-awareness: when an active thread exists, only messages within `[start_timestamp, end_timestamp)` are included in Claude context.

#### Auto-naming

When a thread is archived, auto-generate its name from the first user message content (truncated to ~40 chars, slugified for the slug field).

#### WhatsApp chat clearing

Use Baileys `chatModify({ clear: true, lastMessages })` to clear the WhatsApp chat on `/new`, `/reset`, and `/resume`. This clears messages on the bot's account side.

#### Command interception

Thread commands are intercepted by the orchestrator in the message processing loop, before forwarding to the agent container. They are never sent to Claude.

### Files to modify
- `src/db.ts` — add `threads` table, thread CRUD, modify message queries
- `src/index.ts` — intercept thread commands, pass thread context to agent
- `src/channels/whatsapp.ts` — add `clearChat()` method
- `src/channels/types.ts` — add `clearChat?()` to channel interface
