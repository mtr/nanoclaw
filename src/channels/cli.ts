import { randomUUID } from 'node:crypto';
import type { Channel, ChannelOpts } from '../types.js';

export type OutboundHandler = (jid: string, text: string) => void;

export class CliChannel implements Channel {
  name = 'cli';
  private connected = false;
  private opts: ChannelOpts;
  private onOutbound: OutboundHandler | null = null;

  constructor(opts: ChannelOpts) {
    this.opts = opts;
  }

  setOutboundHandler(handler: OutboundHandler): void {
    this.onOutbound = handler;
  }

  async connect(): Promise<void> {
    this.connected = true;
  }

  async sendMessage(jid: string, text: string): Promise<void> {
    this.onOutbound?.(jid, text);
  }

  isConnected(): boolean {
    return this.connected;
  }

  ownsJid(jid: string): boolean {
    return jid.startsWith('cli:');
  }

  async disconnect(): Promise<void> {
    this.connected = false;
  }

  /** Called by the HTTP API to inject an inbound message into the orchestrator. */
  injectMessage(
    chatJid: string,
    sender: string,
    senderName: string,
    content: string,
  ): void {
    this.opts.onMessage(chatJid, {
      id: randomUUID(),
      chat_jid: chatJid,
      sender,
      sender_name: senderName,
      content,
      timestamp: new Date().toISOString(),
      is_from_me: false,
      is_bot_message: false,
    });
  }
}
