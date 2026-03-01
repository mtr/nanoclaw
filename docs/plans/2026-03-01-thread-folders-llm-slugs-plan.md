# Per-Thread Folders with LLM-Generated Slugs — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Give each conversation thread a dedicated folder at `~/Documents/Lulu/{group}/{slug}/` with short, memorable LLM-generated slugs.

**Architecture:** A new `src/slug-generator.ts` module calls Claude Haiku to generate 2-4 word slugs from the first user message. Thread folders are created eagerly at `/new` time and mounted into the container at `/workspace/thread/`. A one-time migration renames existing threads.

**Tech Stack:** TypeScript, `@anthropic-ai/sdk`, vitest

**Design doc:** `docs/plans/2026-03-01-thread-folders-llm-slugs-design.md`

---

### Task 1: Add `@anthropic-ai/sdk` dependency

**Files:**
- Modify: `package.json`

**Step 1: Install the SDK**

Run: `npm install @anthropic-ai/sdk`

**Step 2: Verify installation**

Run: `node -e "import('@anthropic-ai/sdk').then(m => console.log('OK', typeof m.default))"`
Expected: `OK function`

**Step 3: Commit**

```
feat: add @anthropic-ai/sdk for orchestrator-side LLM calls
```

---

### Task 2: Create `src/slug-generator.ts` with Haiku slug generation

**Files:**
- Create: `src/slug-generator.ts`
- Create: `src/slug-generator.test.ts`

**Step 1: Write the failing tests**

Create `src/slug-generator.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { generateThreadSlug } from './slug-generator.js';

// Mock the Anthropic SDK
vi.mock('@anthropic-ai/sdk', () => {
  const mockCreate = vi.fn();
  return {
    default: vi.fn(() => ({
      messages: { create: mockCreate },
    })),
    __mockCreate: mockCreate,
  };
});

// Access the mock for test setup
async function getMockCreate() {
  const mod = await import('@anthropic-ai/sdk');
  return (mod as any).__mockCreate as ReturnType<typeof vi.fn>;
}

describe('generateThreadSlug', () => {
  let mockCreate: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    mockCreate = await getMockCreate();
    mockCreate.mockReset();
  });

  it('returns LLM-generated slug for a user message', async () => {
    mockCreate.mockResolvedValue({
      content: [{ type: 'text', text: 'x-twitter-setup' }],
    });

    const slug = await generateThreadSlug(
      'How do I set up X Twitter integration?',
      'test-api-key',
      [],
    );

    expect(slug).toBe('x-twitter-setup');
    expect(mockCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 30,
      }),
    );
  });

  it('strips whitespace and normalizes LLM output', async () => {
    mockCreate.mockResolvedValue({
      content: [{ type: 'text', text: '  Speaker Setup Guide  ' }],
    });

    const slug = await generateThreadSlug('Help me set up my speakers', 'key', []);
    expect(slug).toBe('speaker-setup-guide');
  });

  it('avoids existing slugs by passing them in the prompt', async () => {
    mockCreate.mockResolvedValue({
      content: [{ type: 'text', text: 'murial-brainstorm-2' }],
    });

    const slug = await generateThreadSlug(
      'I have an idea for Murial',
      'key',
      ['murial-brainstorm'],
    );

    expect(slug).toBe('murial-brainstorm-2');
    // Verify existing slugs were passed in the prompt
    const callArgs = mockCreate.mock.calls[0][0];
    expect(callArgs.messages[0].content).toContain('murial-brainstorm');
  });

  it('falls back to slugified message on API error', async () => {
    mockCreate.mockRejectedValue(new Error('API unavailable'));

    const slug = await generateThreadSlug(
      'How to build a web app',
      'key',
      [],
    );

    // Should fall back to simple slugify
    expect(slug).toBe('how-to-build-a-web-app');
  });

  it('falls back when LLM returns empty text', async () => {
    mockCreate.mockResolvedValue({
      content: [{ type: 'text', text: '' }],
    });

    const slug = await generateThreadSlug('My question', 'key', []);
    expect(slug).toBe('my-question');
  });

  it('truncates input to 500 chars', async () => {
    mockCreate.mockResolvedValue({
      content: [{ type: 'text', text: 'long-message' }],
    });

    const longMessage = 'a'.repeat(1000);
    await generateThreadSlug(longMessage, 'key', []);

    const callArgs = mockCreate.mock.calls[0][0];
    const userContent = callArgs.messages[0].content;
    // The message portion should be truncated
    expect(userContent.length).toBeLessThan(900);
  });
});
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run src/slug-generator.test.ts`
Expected: FAIL — `./slug-generator.js` does not exist

**Step 3: Implement `src/slug-generator.ts`**

```typescript
import Anthropic from '@anthropic-ai/sdk';

import { slugify } from './router.js';
import { logger } from './logger.js';

const MAX_INPUT_LENGTH = 500;

/**
 * Call Claude Haiku to generate a short, memorable thread slug from
 * the user's first message. Falls back to simple slugification on error.
 */
export async function generateThreadSlug(
  firstMessage: string,
  apiKey: string,
  existingSlugs: string[],
): Promise<string> {
  const truncated = firstMessage.slice(0, MAX_INPUT_LENGTH);
  const fallback = slugify(truncated);

  try {
    const client = new Anthropic({ apiKey });

    const avoidList =
      existingSlugs.length > 0
        ? `\nAvoid these existing slugs: ${existingSlugs.join(', ')}`
        : '';

    const response = await client.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 30,
      messages: [
        {
          role: 'user',
          content: `Generate a 2-4 word kebab-case slug that describes this conversation topic. Be specific and memorable. Return ONLY the slug, nothing else.${avoidList}\n\nMessage: ${truncated}`,
        },
      ],
    });

    const text =
      response.content[0]?.type === 'text'
        ? response.content[0].text.trim()
        : '';

    if (!text) return fallback;

    // Normalize: if Haiku returns natural language, slugify it
    const slug = text.includes('-') ? text.toLowerCase() : slugify(text);
    return slug || fallback;
  } catch (err) {
    logger.warn({ err }, 'LLM slug generation failed, using fallback');
    return fallback;
  }
}
```

**Step 4: Run test to verify it passes**

Run: `npx vitest run src/slug-generator.test.ts`
Expected: PASS

**Step 5: Commit**

```
feat: add LLM-powered thread slug generation via Haiku
```

---

### Task 3: Add `THREAD_DOCS_DIR` config and thread folder helpers

**Files:**
- Modify: `src/config.ts`
- Create: `src/thread-folder.ts`
- Create: `src/thread-folder.test.ts`

**Step 1: Write the failing tests**

Create `src/thread-folder.test.ts`:

```typescript
import { describe, it, expect, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

import { ensureThreadFolder, renameThreadFolder } from './thread-folder.js';

const TEST_BASE = path.join(os.tmpdir(), `nanoclaw-thread-test-${Date.now()}`);

afterEach(() => {
  fs.rmSync(TEST_BASE, { recursive: true, force: true });
});

describe('ensureThreadFolder', () => {
  it('creates the folder at base/group/slug', () => {
    const result = ensureThreadFolder(TEST_BASE, 'main', 'my-thread');
    expect(fs.existsSync(result)).toBe(true);
    expect(result).toBe(path.join(TEST_BASE, 'main', 'my-thread'));
  });

  it('is idempotent', () => {
    ensureThreadFolder(TEST_BASE, 'main', 'my-thread');
    const result = ensureThreadFolder(TEST_BASE, 'main', 'my-thread');
    expect(fs.existsSync(result)).toBe(true);
  });
});

describe('renameThreadFolder', () => {
  it('renames an existing folder', () => {
    const oldPath = ensureThreadFolder(TEST_BASE, 'main', 'old-slug');
    fs.writeFileSync(path.join(oldPath, 'test.md'), 'hello');

    const newPath = renameThreadFolder(TEST_BASE, 'main', 'old-slug', 'new-slug');
    expect(fs.existsSync(newPath)).toBe(true);
    expect(fs.existsSync(oldPath)).toBe(false);
    expect(fs.readFileSync(path.join(newPath, 'test.md'), 'utf-8')).toBe('hello');
  });

  it('creates new folder if old does not exist', () => {
    const newPath = renameThreadFolder(TEST_BASE, 'main', 'nonexistent', 'new-slug');
    expect(fs.existsSync(newPath)).toBe(true);
  });

  it('does nothing if old and new slug are the same', () => {
    const p = ensureThreadFolder(TEST_BASE, 'main', 'same');
    const result = renameThreadFolder(TEST_BASE, 'main', 'same', 'same');
    expect(result).toBe(p);
  });
});
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run src/thread-folder.test.ts`
Expected: FAIL — `./thread-folder.js` does not exist

**Step 3: Add config constant**

In `src/config.ts`, after the `DATA_DIR` line (line 32), add:

```typescript
export const THREAD_DOCS_DIR = path.resolve(
  process.env.NANOCLAW_THREAD_DOCS_DIR || path.join(HOME_DIR, 'Documents', 'Lulu'),
);
```

**Step 4: Implement `src/thread-folder.ts`**

```typescript
import fs from 'fs';
import path from 'path';

/**
 * Ensure the thread folder exists at `{base}/{groupFolder}/{slug}/`.
 * Returns the absolute path.
 */
export function ensureThreadFolder(
  base: string,
  groupFolder: string,
  slug: string,
): string {
  const dirPath = path.join(base, groupFolder, slug);
  fs.mkdirSync(dirPath, { recursive: true });
  return dirPath;
}

/**
 * Rename a thread folder from oldSlug to newSlug.
 * If the old folder doesn't exist, creates the new one.
 * Returns the new absolute path.
 */
export function renameThreadFolder(
  base: string,
  groupFolder: string,
  oldSlug: string,
  newSlug: string,
): string {
  if (oldSlug === newSlug) {
    return ensureThreadFolder(base, groupFolder, newSlug);
  }

  const oldPath = path.join(base, groupFolder, oldSlug);
  const newPath = path.join(base, groupFolder, newSlug);

  if (fs.existsSync(oldPath)) {
    fs.mkdirSync(path.dirname(newPath), { recursive: true });
    fs.renameSync(oldPath, newPath);
  } else {
    fs.mkdirSync(newPath, { recursive: true });
  }

  return newPath;
}
```

**Step 5: Run test to verify it passes**

Run: `npx vitest run src/thread-folder.test.ts`
Expected: PASS

**Step 6: Commit**

```
feat: add thread folder helpers and THREAD_DOCS_DIR config
```

---

### Task 4: Update default timestamp slug format

**Files:**
- Modify: `src/index.ts:205` — change `thread-${Date.now()}` to ISO format

**Step 1: Change the timestamp slug format**

In `src/index.ts`, line 205, replace:

```typescript
const newSlug = `thread-${Date.now()}`;
```

With:

```typescript
const newSlug = now.slice(0, 16).replace(/:/g, '-');
```

This produces slugs like `2026-03-01T22-30` instead of `thread-1740580341234`.

**Step 2: Run full test suite**

Run: `npx vitest run`
Expected: All tests PASS

**Step 3: Commit**

```
feat: use ISO timestamp format for default thread slugs
```

---

### Task 5: Create thread folder on `/new` and wire LLM slug on first message

**Files:**
- Modify: `src/index.ts:204-213` — create folder on `/new`
- Modify: `src/index.ts:354-376` — replace auto-naming with LLM call

**Step 1: Import new modules at top of `src/index.ts`**

Add imports:

```typescript
import { generateThreadSlug } from './slug-generator.js';
import { ensureThreadFolder, renameThreadFolder } from './thread-folder.js';
import { THREAD_DOCS_DIR } from './config.js'; // add to existing config import
```

**Step 2: Create thread folder eagerly in `/new` handler**

After `createThread({...})` (after line 213), add:

```typescript
ensureThreadFolder(THREAD_DOCS_DIR, group.folder, newSlug);
```

Note: `group` is not in scope in `handleThreadCommand`. You will need to look up the group from `registeredGroups[chatJid]` and pass `group.folder` through. The cleanest approach is to add `groupFolder: string` as a parameter to `handleThreadCommand` and pass it from both call sites.

Update `handleThreadCommand` signature:

```typescript
async function handleThreadCommand(
  chatJid: string,
  content: string,
  channel: Channel,
  groupFolder: string,
): Promise<ThreadCommandResult> {
```

Update both call sites (in `startMessageLoop` ~line 633 and in `processGroupMessages` ~line 313):

```typescript
// In startMessageLoop:
const result = await handleThreadCommand(chatJid, msg.content, channel, group.folder);

// In processGroupMessages:
const result = await handleThreadCommand(chatJid, msg.content, channel, group.folder);
```

Then after `createThread({...})`:

```typescript
ensureThreadFolder(THREAD_DOCS_DIR, groupFolder, newSlug);
```

**Step 3: Replace auto-naming with LLM slug generation**

Replace the auto-naming block in `processGroupMessages` (lines 354-376):

```typescript
// Auto-name thread from first user message using LLM
if (
  activeThread &&
  activeThread.name === 'New conversation' &&
  agentMessages.length > 0
) {
  const firstContent = agentMessages[0].content;
  const existingSlugs = getThreads(chatJid).map((t) => t.slug);

  // Read API key for LLM call
  const secrets = readEnvFile(['ANTHROPIC_API_KEY']);
  const apiKey = secrets.ANTHROPIC_API_KEY;

  let slug: string;
  if (apiKey) {
    slug = await generateThreadSlug(firstContent, apiKey, existingSlugs);
    // Ensure uniqueness
    slug = makeUniqueThreadSlug({
      chatJid,
      baseName: slug,
      currentThreadId: activeThread.id,
      findBySlug: getThreadBySlug,
    });
  } else {
    const autoName = firstContent.slice(0, 60).replace(/\n/g, ' ');
    slug = makeUniqueThreadSlug({
      chatJid,
      baseName: autoName,
      currentThreadId: activeThread.id,
      findBySlug: getThreadBySlug,
    });
  }

  const displayName = slug.replace(/-/g, ' ');
  try {
    const oldSlug = activeThread.slug;
    updateThreadName(activeThread.id, displayName, slug);
    renameThreadFolder(THREAD_DOCS_DIR, group.folder, oldSlug, slug);
  } catch (err) {
    logger.warn(
      { chatJid, threadId: activeThread.id, slug, err },
      'Failed to auto-name active thread',
    );
  }
}
```

You'll need to import `readEnvFile`:

```typescript
import { readEnvFile } from './env.js';
```

And import `getThreads` from `./db.js` (check if it's already imported — it likely is).

**Step 4: Run full test suite**

Run: `npx vitest run`
Expected: All tests PASS

**Step 5: Commit**

```
feat: create thread folders and generate LLM slugs on first message
```

---

### Task 6: Mount thread folder into container

**Files:**
- Modify: `src/container-runner.ts:58-221` — add thread folder mount
- Modify: `src/container-runner.ts:263-290` — pass thread slug to `buildVolumeMounts`

**Step 1: Add thread slug parameter to `buildVolumeMounts`**

Update the function signature at line 58:

```typescript
function buildVolumeMounts(
  group: RegisteredGroup,
  isMain: boolean,
  threadSlug?: string,
): VolumeMount[] {
```

**Step 2: Add thread folder mount**

After the `additionalMounts` block (after line 218, before `return mounts;`), add:

```typescript
// Per-thread document folder (e.g., ~/Documents/Lulu/main/my-thread/)
if (threadSlug) {
  const threadDir = ensureThreadFolder(THREAD_DOCS_DIR, group.folder, threadSlug);
  mounts.push({
    hostPath: threadDir,
    containerPath: '/workspace/thread',
    readonly: false,
  });
}
```

Import at top of file:

```typescript
import { ensureThreadFolder } from './thread-folder.js';
import { THREAD_DOCS_DIR } from './config.js'; // add to existing config import
```

**Step 3: Pass thread slug from `runContainerAgent`**

In `runContainerAgent` (line 274), the thread slug needs to come from the caller. Add `threadSlug?: string` to `ContainerInput`:

In the `ContainerInput` interface (around line 34):

```typescript
export interface ContainerInput {
  prompt: string;
  sessionId?: string;
  groupFolder: string;
  chatJid: string;
  isMain: boolean;
  isScheduledTask?: boolean;
  assistantName?: string;
  secrets?: Record<string, string>;
  threadSlug?: string;  // <-- add this
}
```

Update line 274:

```typescript
const mounts = buildVolumeMounts(group, input.isMain, input.threadSlug);
```

**Step 4: Pass thread slug from `runAgent` in `src/index.ts`**

In `runAgent` (around line 559), add the slug to the input:

```typescript
const activeThread = threadId ? getActiveThread(chatJid) ?? undefined : undefined;
// ... (existing code) ...
const output = await runContainerAgent(
  group,
  {
    prompt,
    sessionId,
    groupFolder: group.folder,
    chatJid,
    isMain,
    assistantName: ASSISTANT_NAME,
    threadSlug: activeThread?.slug,  // <-- add this
  },
  ...
```

Note: `runAgent` already receives `threadId`, but the active thread is looked up inside `processGroupMessages`. You need to get the thread's slug. The simplest approach is to look up the thread by ID inside `runAgent`:

```typescript
import { getActiveThread } from './db.js'; // already imported elsewhere
```

Actually, check if `getActiveThread` returns by chatJid — it does. But `threadId` is already available. You can use:

```typescript
import { getThreadById } from './db.js';
```

If `getThreadById` doesn't exist, you may need to look up the active thread by chatJid:

```typescript
const threadSlug = threadId
  ? getActiveThread(chatJid)?.slug
  : undefined;
```

**Step 5: Run full test suite**

Run: `npx vitest run`
Expected: All tests PASS

**Step 6: Commit**

```
feat: mount thread folder into container at /workspace/thread
```

---

### Task 7: Migration script for existing threads

**Files:**
- Create: `src/migrate-thread-slugs.ts`

**Step 1: Create the migration module**

```typescript
import { readEnvFile } from './env.js';
import { getThreads, updateThreadName, getThreadBySlug } from './db.js';
import { generateThreadSlug } from './slug-generator.js';
import { makeUniqueThreadSlug } from './thread-helpers.js';
import { ensureThreadFolder } from './thread-folder.js';
import { THREAD_DOCS_DIR } from './config.js';
import { logger } from './logger.js';

/**
 * Migrate existing threads: generate LLM slugs and create folders.
 * Uses thread.name (which is the auto-generated name from the first message)
 * as input to Haiku.
 */
export async function migrateExistingThreads(
  chatJids: string[],
): Promise<{ migrated: number; failed: number }> {
  const secrets = readEnvFile(['ANTHROPIC_API_KEY']);
  const apiKey = secrets.ANTHROPIC_API_KEY;
  if (!apiKey) {
    logger.warn('No ANTHROPIC_API_KEY — skipping thread slug migration');
    return { migrated: 0, failed: 0 };
  }

  let migrated = 0;
  let failed = 0;

  for (const chatJid of chatJids) {
    const threads = getThreads(chatJid);
    const existingSlugs = threads.map((t) => t.slug);

    for (const thread of threads) {
      // Skip threads that already have a non-timestamp slug
      if (!thread.slug.startsWith('thread-') && !thread.slug.startsWith('20')) {
        // Already has a content-based slug — just ensure folder exists
        const groupFolder = chatJid.startsWith('cli:') ? 'cli' : 'main';
        ensureThreadFolder(THREAD_DOCS_DIR, groupFolder, thread.slug);
        continue;
      }

      try {
        const input = thread.name !== 'New conversation'
          ? thread.name
          : thread.slug;

        const llmSlug = await generateThreadSlug(input, apiKey, existingSlugs);
        const uniqueSlug = makeUniqueThreadSlug({
          chatJid,
          baseName: llmSlug,
          currentThreadId: thread.id,
          findBySlug: getThreadBySlug,
        });

        const displayName = uniqueSlug.replace(/-/g, ' ');
        const groupFolder = chatJid.startsWith('cli:') ? 'cli' : 'main';

        updateThreadName(thread.id, displayName, uniqueSlug);
        ensureThreadFolder(THREAD_DOCS_DIR, groupFolder, uniqueSlug);

        existingSlugs.push(uniqueSlug);
        migrated++;

        logger.info(
          { threadId: thread.id, oldSlug: thread.slug, newSlug: uniqueSlug },
          'Migrated thread slug',
        );
      } catch (err) {
        failed++;
        logger.error({ threadId: thread.id, err }, 'Failed to migrate thread slug');
      }
    }
  }

  return { migrated, failed };
}
```

**Step 2: Wire migration to a `/migrate-threads` command**

In `src/index.ts`, add a new regex after `THREAD_COMMANDS`:

```typescript
const ADMIN_COMMANDS = /^\/(migrate-threads)\b/;
```

Handle it in the message loop (inside the command interception block), or add it to `handleThreadCommand`. The simplest approach: check for it in the loop before the thread commands check and call `migrateExistingThreads` with all registered JIDs.

**Step 3: Run full test suite**

Run: `npx vitest run`
Expected: All tests PASS

**Step 4: Commit**

```
feat: add /migrate-threads command for existing thread slug migration
```

---

### Task 8: Update CLAUDE.md documentation

**Files:**
- Modify: `groups/main/CLAUDE.md` — document `/workspace/thread/` mount

**Step 1: Add thread folder documentation**

Add to the mount table in `groups/main/CLAUDE.md`:

```markdown
| /workspace/thread | ~/Documents/Lulu/main/{thread-slug} | read-write — per-conversation file storage |
```

**Step 2: Commit**

```
docs: document /workspace/thread mount for agent
```

---

### Task 9: Build and smoke test

**Step 1: Build**

Run: `npm run build`
Expected: No TypeScript errors

**Step 2: Restart NanoClaw**

Run: `systemctl --user restart nanoclaw`

**Step 3: Manual test**

1. Open TUI → CLI group → send `/new`
2. Verify `~/Documents/Lulu/cli/` has a folder with timestamp slug
3. Send a message (e.g., "Help me plan a trip to Japan")
4. Check that the folder was renamed to something like `japan-trip-planning`
5. Run `/threads` — verify the new slug appears
6. Run `/migrate-threads` in main group — verify existing threads get renamed
7. Check `~/Documents/Lulu/main/` has folders for all migrated threads

**Step 4: Commit any fixes**

```
fix: adjustments from smoke testing
```
