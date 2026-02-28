import { slugify } from './router.js';
import { NewMessage, Thread } from './types.js';

export interface ThreadCommandResult {
  handled: boolean;
  cursorTimestamp?: string;
}

export interface PendingMessagesScopeArgs {
  chatJid: string;
  sinceTimestamp: string;
  assistantName: string;
  activeThreadId?: string;
  getMessagesSince: (
    chatJid: string,
    sinceTimestamp: string,
    botPrefix: string,
  ) => NewMessage[];
  getMessagesSinceInThread: (
    chatJid: string,
    sinceTimestamp: string,
    botPrefix: string,
    threadId: string,
  ) => NewMessage[];
}

export interface UniqueSlugArgs {
  chatJid: string;
  baseName: string;
  findBySlug: (chatJid: string, slug: string) => Thread | undefined;
  currentThreadId?: string;
  maxLength?: number;
}

/**
 * Use command timestamp by default, but allow command-specific overrides
 * (e.g. /resume should rewind cursor to the resumed thread start).
 */
export function resolveHandledCommandCursor(
  commandTimestamp: string,
  result: ThreadCommandResult,
): string {
  return result.cursorTimestamp ?? commandTimestamp;
}

/**
 * Fetch pending messages in the active thread when present; otherwise use
 * chat-wide pending messages.
 */
export function fetchPendingMessagesForScope(
  args: PendingMessagesScopeArgs,
): NewMessage[] {
  if (args.activeThreadId) {
    return args.getMessagesSinceInThread(
      args.chatJid,
      args.sinceTimestamp,
      args.assistantName,
      args.activeThreadId,
    );
  }
  return args.getMessagesSince(
    args.chatJid,
    args.sinceTimestamp,
    args.assistantName,
  );
}

/**
 * Generate a chat-unique thread slug, preserving max length and allowing
 * the current thread to keep its own slug during rename.
 */
export function makeUniqueThreadSlug(args: UniqueSlugArgs): string {
  const maxLength = args.maxLength ?? 40;
  const base = slugify(args.baseName).slice(0, maxLength);
  let candidate = base;
  let suffixIndex = 2;

  while (true) {
    const existing = args.findBySlug(args.chatJid, candidate);
    if (!existing || existing.id === args.currentThreadId) {
      return candidate;
    }

    const suffix = `-${suffixIndex}`;
    const headLen = Math.max(1, maxLength - suffix.length);
    candidate = `${base.slice(0, headLen)}${suffix}`;
    suffixIndex += 1;
  }
}
