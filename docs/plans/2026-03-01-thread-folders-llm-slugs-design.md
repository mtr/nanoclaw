# Per-Thread Folders with LLM-Generated Slugs

**Date**: 2026-03-01
**Status**: Approved

## Problem

Threads currently use truncated-message slugs (`can-you-please-research-the-topic-on-how`) that are hard to remember and navigate. There are no per-thread folders, so agent-generated files all land in the shared group folder with no organization by conversation.

## Solution

1. **LLM-generated slugs**: Use Claude Haiku to produce short, memorable, 2-4 word slugs (e.g., `x-twitter-integration`, `speaker-setup-guide`) from the first user message.
2. **Per-thread folders**: Create `~/Documents/Lulu/{group}/{slug}/` for each thread, mounted into the container at `/workspace/thread/`.

## Folder Structure

```
~/Documents/Lulu/
├── main/
│   ├── x-twitter-integration/
│   ├── murial-app-brainstorm/
│   └── speaker-setup-research/
└── cli/
    └── cueball-tips/
```

- Top-level: `~/Documents/Lulu/` (configurable via env var)
- Second level: `group.folder` name
- Third level: thread slug (LLM-generated)

## Slug Generation

### New module: `src/slug-generator.ts`

```typescript
async function generateThreadSlug(
  firstMessage: string,
  existingSlugs: string[],
): Promise<string>
```

- Calls `claude-haiku-4-5-20251001` via `@anthropic-ai/sdk`
- Prompt asks for a 2-4 word kebab-case slug that's specific and memorable
- Input: first user message (truncated to ~500 chars), plus existing slugs to avoid collisions
- Falls back to current `slugify(firstMessage)` if API call fails
- Uses `ANTHROPIC_API_KEY` from environment

### Timing

- **Immediate**: Called when the first user message arrives, before agent processing starts
- Adds ~200-500ms latency on the first message only

### Default timestamp slug format

Changed from `thread-1740580341234` to `2026-03-01T22-30` (ISO date with time, filesystem-safe).

## Container Mount

- Thread folder mounted at `/workspace/thread/` (read-write)
- Created eagerly at `/new` time (with timestamp slug), renamed when Haiku generates the real slug
- On `/resume`, the resumed thread's folder is mounted

## Migration

One-time migration for existing threads:
1. Iterate all threads in the database
2. Call Haiku with each thread's `name` field to generate a proper slug
3. Update the database slug
4. Create the folder at `~/Documents/Lulu/{group}/{new-slug}/`
5. Runs on startup or via `/migrate-threads` command

## Files Changed

| File | Change |
|------|--------|
| `src/slug-generator.ts` | New — Haiku API call for slug generation |
| `src/index.ts` | Replace auto-naming with Haiku call; update `/new` timestamp format |
| `src/container-runner.ts` | Add thread folder mount at `/workspace/thread/` |
| `src/thread-helpers.ts` | Update `makeUniqueThreadSlug` to work with LLM output |
| `groups/main/CLAUDE.md` | Document `/workspace/thread/` path |
| `package.json` | Add `@anthropic-ai/sdk` dependency |

## Design Decisions

- **Eager folder creation**: Every thread gets a folder at `/new` time, even if empty
- **Full mount on /resume**: Resumed threads get their folder mounted read-write
- **Orchestrator-side API call**: Slug generation happens in the orchestrator, not the container. Keeps thread management centralized.
- **Graceful fallback**: If Haiku fails, fall back to the current slugify approach
- **Migrate existing**: Retroactively rename all 10 existing threads with Haiku-generated slugs
