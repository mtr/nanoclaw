# Dual-Route SSE Mirroring

**Date**: 2026-03-01
**Status**: Approved

## Problem

When the TUI views a WhatsApp group (e.g., "main") and runs commands like `/threads`, the response is sent only to WhatsApp. The TUI never sees it because:

1. The TUI sends messages with the WhatsApp JID (`120363...@g.us`)
2. The message loop resolves the channel via `findChannel(channels, chatJid)` — which returns the WhatsApp channel
3. Responses go to WhatsApp only; the SSE stream (which the TUI listens on) gets nothing

## Solution

A `broadcastMessage()` helper in `src/index.ts` that sends via the owning channel AND mirrors to SSE for non-`cli:` JIDs.

```typescript
async function broadcastMessage(
  channel: Channel,
  jid: string,
  text: string,
): Promise<void> {
  await channel.sendMessage(jid, text);
  if (!jid.startsWith('cli:')) {
    pushSseEvent?.('message', {
      jid,
      content: text,
      audioUrl: null,
      timestamp: new Date().toISOString(),
    });
  }
}
```

### Why skip `cli:` JIDs

The `CliChannel.outboundHandler` already pushes to SSE for `cli:` JIDs. The guard prevents double-pushing.

## Call sites to update

| Location | Description |
|----------|-------------|
| `handleThreadCommand` (7 calls) | Thread command responses |
| Streaming agent output callback | Agent text responses |
| Scheduler `sendMessage` | Scheduled task output |
| IPC `sendMessage` | IPC-initiated messages |

## Scope

- **Files changed**: `src/index.ts` only
- **No TUI changes**: The SSE listener already filters by `jid == current_jid`
- **No interface changes**: Channel, router, and api-server are untouched

## Design decisions

- **Always mirror**: All outbound messages to non-CLI JIDs are pushed to SSE, regardless of whether the TUI is actively viewing that group. The TUI client-side filter handles relevance.
- **Full mirror**: Messages sent from TUI go to WhatsApp, and all responses come back to TUI. Both sides see everything.
