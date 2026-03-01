import { describe, expect, it, vi } from 'vitest';

import {
  fetchPendingMessagesForScope,
  makeUniqueThreadSlug,
  resolveHandledCommandCursor,
} from './thread-helpers.js';
import type { NewMessage, Thread } from './types.js';

function makeMsg(content: string): NewMessage {
  return {
    id: `id-${content}`,
    chat_jid: 'group@g.us',
    sender: 'user@s.whatsapp.net',
    sender_name: 'User',
    content,
    timestamp: '2026-01-01T00:00:00.000Z',
  };
}

describe('resolveHandledCommandCursor', () => {
  it('uses command timestamp by default', () => {
    const cursor = resolveHandledCommandCursor('t-cmd', { handled: true });
    expect(cursor).toBe('t-cmd');
  });

  it('uses command-provided override when present', () => {
    const cursor = resolveHandledCommandCursor('t-cmd', {
      handled: true,
      cursorTimestamp: 't-thread-start',
    });
    expect(cursor).toBe('t-thread-start');
  });
});

describe('fetchPendingMessagesForScope', () => {
  it('uses thread-scoped fetch when active thread exists', () => {
    const globalFetch = vi.fn(() => [makeMsg('global')]);
    const threadFetch = vi.fn(() => [makeMsg('thread')]);

    const messages = fetchPendingMessagesForScope({
      chatJid: 'group@g.us',
      sinceTimestamp: 't0',
      assistantName: 'Andy',
      activeThreadId: 'thread-1',
      getMessagesSince: globalFetch,
      getMessagesSinceInThread: threadFetch,
    });

    expect(messages).toHaveLength(1);
    expect(messages[0].content).toBe('thread');
    expect(threadFetch).toHaveBeenCalledWith(
      'group@g.us',
      't0',
      'Andy',
      'thread-1',
    );
    expect(globalFetch).not.toHaveBeenCalled();
  });

  it('uses global fetch when no active thread exists', () => {
    const globalFetch = vi.fn(() => [makeMsg('global')]);
    const threadFetch = vi.fn(() => [makeMsg('thread')]);

    const messages = fetchPendingMessagesForScope({
      chatJid: 'group@g.us',
      sinceTimestamp: 't0',
      assistantName: 'Andy',
      activeThreadId: undefined,
      getMessagesSince: globalFetch,
      getMessagesSinceInThread: threadFetch,
    });

    expect(messages).toHaveLength(1);
    expect(messages[0].content).toBe('global');
    expect(globalFetch).toHaveBeenCalledWith('group@g.us', 't0', 'Andy');
    expect(threadFetch).not.toHaveBeenCalled();
  });
});

describe('makeUniqueThreadSlug', () => {
  it('returns base slug when unused', () => {
    const findBySlug = vi.fn(() => undefined);
    const slug = makeUniqueThreadSlug({
      chatJid: 'group@g.us',
      baseName: 'New conversation',
      findBySlug,
    });
    expect(slug).toBe('new-conversation');
  });

  it('adds numeric suffix when slug is already taken', () => {
    const findBySlug = vi.fn((_jid: string, slug: string) => {
      if (slug === 'new-conversation') {
        return {
          id: 't-old',
        } as Thread;
      }
      return undefined;
    });

    const slug = makeUniqueThreadSlug({
      chatJid: 'group@g.us',
      baseName: 'New conversation',
      findBySlug,
      currentThreadId: 't-current',
    });

    expect(slug).toBe('new-conversation-2');
  });

  it('allows keeping the same slug for the same thread id', () => {
    const findBySlug = vi.fn(() => ({ id: 't-current' }) as Thread);
    const slug = makeUniqueThreadSlug({
      chatJid: 'group@g.us',
      baseName: 'Current title',
      findBySlug,
      currentThreadId: 't-current',
    });
    expect(slug).toBe('current-title');
  });

  it('keeps max length while appending suffixes', () => {
    const baseName = 'x'.repeat(80);
    const firstSlug = 'x'.repeat(40);

    const findBySlug = vi.fn((_jid: string, slug: string) => {
      if (slug === firstSlug) {
        return { id: 't-old' } as Thread;
      }
      return undefined;
    });

    const slug = makeUniqueThreadSlug({
      chatJid: 'group@g.us',
      baseName,
      findBySlug,
    });

    expect(slug.length).toBeLessThanOrEqual(40);
    expect(slug.endsWith('-2')).toBe(true);
  });
});
