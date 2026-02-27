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
