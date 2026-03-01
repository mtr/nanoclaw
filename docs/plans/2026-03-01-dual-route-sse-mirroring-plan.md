# Dual-Route SSE Mirroring Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Mirror all outbound messages to the SSE stream so the TUI can display responses for WhatsApp groups.

**Architecture:** A single `broadcastMessage()` helper in `src/index.ts` wraps every `channel.sendMessage()` call. For non-`cli:` JIDs, it also pushes to SSE via `pushSseEvent`. The `cli:` guard prevents double-pushing since the CLI channel's outbound handler already pushes to SSE.

**Tech Stack:** TypeScript, vitest

**Design doc:** `docs/plans/2026-03-01-dual-route-sse-mirroring-design.md`

---

### Task 1: Add `broadcastMessage` helper and unit test

**Files:**
- Modify: `src/index.ts` (add helper near line 91, after `pushSseEvent` declaration; export for testing)

**Step 1: Write the failing test**

Add to the bottom of `src/routing.test.ts` (this file already tests index.ts exports):

```typescript
import { _broadcastMessage, _setPushSseEvent } from './index.js';

describe('broadcastMessage', () => {
  it('mirrors to SSE for non-cli JIDs', async () => {
    const sseSpy = vi.fn();
    _setPushSseEvent(sseSpy);

    const fakeChannel = { sendMessage: vi.fn() } as any;
    await _broadcastMessage(fakeChannel, 'group@g.us', 'Hello');

    expect(fakeChannel.sendMessage).toHaveBeenCalledWith('group@g.us', 'Hello');
    expect(sseSpy).toHaveBeenCalledWith('message', expect.objectContaining({
      jid: 'group@g.us',
      content: 'Hello',
    }));
  });

  it('skips SSE mirror for cli: JIDs', async () => {
    const sseSpy = vi.fn();
    _setPushSseEvent(sseSpy);

    const fakeChannel = { sendMessage: vi.fn() } as any;
    await _broadcastMessage(fakeChannel, 'cli:main', 'Hello');

    expect(fakeChannel.sendMessage).toHaveBeenCalledWith('cli:main', 'Hello');
    expect(sseSpy).not.toHaveBeenCalled();
  });

  it('works when pushSseEvent is null', async () => {
    _setPushSseEvent(null);

    const fakeChannel = { sendMessage: vi.fn() } as any;
    await _broadcastMessage(fakeChannel, 'group@g.us', 'Hello');

    expect(fakeChannel.sendMessage).toHaveBeenCalledWith('group@g.us', 'Hello');
    // No error thrown
  });
});
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run src/routing.test.ts`
Expected: FAIL — `_broadcastMessage` and `_setPushSseEvent` not exported from `./index.js`

**Step 3: Implement `broadcastMessage` and test helpers**

In `src/index.ts`, after the `pushSseEvent` declaration (line 90), add:

```typescript
/** Send via the owning channel AND mirror to SSE for TUI consumers. */
async function broadcastMessage(
  channel: Channel,
  jid: string,
  text: string,
): Promise<void> {
  await channel.sendMessage(jid, text);
  if (!jid.startsWith('cli:') && pushSseEvent) {
    pushSseEvent('message', {
      jid,
      content: text,
      audioUrl: null,
      timestamp: new Date().toISOString(),
    });
  }
}
```

Add test-only exports at the bottom of `src/index.ts` (near existing `_setRegisteredGroups` export):

```typescript
/** @internal Test-only setter for pushSseEvent */
export function _setPushSseEvent(
  fn: ((event: string, data: Record<string, unknown>) => void) | null,
): void {
  pushSseEvent = fn;
}

/** @internal Test-only access to broadcastMessage */
export const _broadcastMessage = broadcastMessage;
```

**Step 4: Run test to verify it passes**

Run: `npx vitest run src/routing.test.ts`
Expected: PASS

**Step 5: Commit**

```
feat: add broadcastMessage helper for SSE mirroring
```

---

### Task 2: Replace `channel.sendMessage` calls in `handleThreadCommand`

**Files:**
- Modify: `src/index.ts:203,214,228,235,241,249,261` — 7 replacements

**Step 1: Replace all 7 calls**

Each instance of `channel.sendMessage(chatJid, ...)` in `handleThreadCommand` becomes `broadcastMessage(channel, chatJid, ...)`:

| Line | Before | After |
|------|--------|-------|
| 203 | `await channel.sendMessage(chatJid, ...)` | `await broadcastMessage(channel, chatJid, ...)` |
| 214 | `await channel.sendMessage(chatJid, ...)` | `await broadcastMessage(channel, chatJid, ...)` |
| 228 | `await channel.sendMessage(chatJid, ...)` | `await broadcastMessage(channel, chatJid, ...)` |
| 235 | `await channel.sendMessage(chatJid, ...)` | `await broadcastMessage(channel, chatJid, ...)` |
| 241 | `await channel.sendMessage(chatJid, ...)` | `await broadcastMessage(channel, chatJid, ...)` |
| 249 | `await channel.sendMessage(chatJid, ...)` | `await broadcastMessage(channel, chatJid, ...)` |
| 261 | `await channel.sendMessage(chatJid, ...)` | `await broadcastMessage(channel, chatJid, ...)` |

**Step 2: Run full test suite**

Run: `npx vitest run`
Expected: All tests PASS

**Step 3: Commit**

```
feat: mirror thread command responses to SSE
```

---

### Task 3: Replace `channel.sendMessage` in agent streaming output

**Files:**
- Modify: `src/index.ts:411` — 1 replacement in `processGroupMessages`

**Step 1: Replace the call**

Line 411:
```typescript
// Before
await channel.sendMessage(chatJid, text);
// After
await broadcastMessage(channel, chatJid, text);
```

**Step 2: Run full test suite**

Run: `npx vitest run`
Expected: All tests PASS

**Step 3: Commit**

```
feat: mirror agent streaming output to SSE
```

---

### Task 4: Replace `channel.sendMessage` in scheduler and IPC callbacks

**Files:**
- Modify: `src/index.ts:851` — scheduler callback
- Modify: `src/index.ts:858` — IPC callback

**Step 1: Replace scheduler callback (line 851)**

```typescript
// Before
if (text) await channel.sendMessage(jid, text);
// After
if (text) await broadcastMessage(channel, jid, text);
```

**Step 2: Replace IPC callback (line 858)**

```typescript
// Before
return channel.sendMessage(jid, text);
// After
return broadcastMessage(channel, jid, text);
```

**Step 3: Run full test suite**

Run: `npx vitest run`
Expected: All tests PASS

**Step 4: Commit**

```
feat: mirror scheduler and IPC output to SSE
```

---

### Task 5: Manual smoke test

**Step 1: Build**

Run: `npm run build`
Expected: No TypeScript errors

**Step 2: Restart NanoClaw**

Run: `systemctl --user restart nanoclaw`

**Step 3: Test in TUI**

1. Open TUI
2. Switch to "main" (WhatsApp) group
3. Run `/threads`
4. Verify the thread list appears in the TUI **and** in the WhatsApp group
5. Switch to "CLI" group
6. Run `/threads`
7. Verify it still works as before (CLI threads only)

**Step 4: Final commit (if any formatting/cleanup needed)**

```
style: cleanup after SSE mirroring implementation
```
