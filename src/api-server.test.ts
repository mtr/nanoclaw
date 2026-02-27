/**
 * Integration tests for the NanoClaw HTTP API server.
 *
 * Manual end-to-end test checklist:
 * ---------------------------------
 * 1. Start the full NanoClaw service (`npm run dev`)
 * 2. Verify the API server is listening on the configured port (default 3000)
 * 3. Using curl or the Python TUI client:
 *    [ ] GET /api/status with valid Bearer token returns { ok: true }
 *    [ ] GET /api/status without token returns 401
 *    [ ] GET /api/groups returns the registered groups
 *    [ ] POST /api/messages with { jid, content } returns 202 and the
 *        message appears in the WhatsApp/CLI channel
 *    [ ] GET /api/messages/stream opens an SSE connection and receives
 *        a "connected" event immediately
 *    [ ] Sending a message triggers an SSE event on the stream
 *    [ ] GET /api/groups/:jid/history returns message history
 *    [ ] GET /api/cost/summary returns usage and budget info
 *    [ ] OPTIONS requests return CORS headers with 204
 *    [ ] Unknown routes return 404
 * 4. Verify the Python TUI connects, sends messages, and displays
 *    streamed responses in real time
 * 5. Verify graceful shutdown: stop the service and confirm SSE
 *    connections close cleanly
 */

import http from 'node:http';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createApiServer } from './api-server.js';
import { CliChannel } from './channels/cli.js';
import type { ApiServer } from './api-server.js';
import type { NewMessage, RegisteredGroup } from './types.js';

// Mock logger to avoid pino initialization side effects
vi.mock('./logger.js', () => ({
  logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

// Mock config to use a temp directory for DATA_DIR
vi.mock('./config.js', () => ({
  DATA_DIR: '/tmp/nanoclaw-test-data',
}));

const TEST_API_KEY = 'test-api-key-12345';

function makeCliChannel(): CliChannel {
  return new CliChannel({
    onMessage: vi.fn(),
    onChatMetadata: vi.fn(),
    registeredGroups: () => ({}),
  });
}

function startServer(apiServer: ApiServer): Promise<number> {
  return new Promise((resolve, reject) => {
    apiServer.server.once('error', reject);
    apiServer.server.listen(0, '127.0.0.1', () => {
      const addr = apiServer.server.address();
      if (addr && typeof addr === 'object') {
        resolve(addr.port);
      }
    });
  });
}

function closeServer(apiServer: ApiServer): Promise<void> {
  return new Promise((resolve, reject) => {
    apiServer.server.closeAllConnections();
    apiServer.server.close((err?: Error) => (err ? reject(err) : resolve()));
  });
}

function request(
  port: number,
  method: string,
  path: string,
  opts: { body?: unknown; token?: string } = {},
): Promise<{
  status: number;
  headers: http.IncomingHttpHeaders;
  body: string;
}> {
  return new Promise((resolve, reject) => {
    const headers: Record<string, string> = {};
    if (opts.token) headers['Authorization'] = `Bearer ${opts.token}`;
    if (opts.body) headers['Content-Type'] = 'application/json';

    const req = http.request(
      { hostname: '127.0.0.1', port, path, method, headers },
      (res) => {
        let body = '';
        res.on('data', (chunk: Buffer) => (body += chunk));
        res.on('end', () =>
          resolve({ status: res.statusCode!, headers: res.headers, body }),
        );
      },
    );
    req.on('error', reject);
    if (opts.body) req.write(JSON.stringify(opts.body));
    req.end();
  });
}

describe('API server integration', () => {
  let apiServer: ApiServer;
  let port: number;
  let cliChannel: CliChannel;
  let mockGroups: Record<string, RegisteredGroup>;
  let mockHistory: NewMessage[];

  beforeEach(async () => {
    mockGroups = {
      'test@g.us': {
        name: 'Test Group',
        folder: 'test-group',
        trigger: '@Andy',
        added_at: '2026-01-01T00:00:00.000Z',
      },
    };
    mockHistory = [
      {
        id: 'msg-1',
        chat_jid: 'test@g.us',
        sender: 'user1',
        sender_name: 'Alice',
        content: 'Hello',
        timestamp: '2026-01-01T12:00:00.000Z',
        is_from_me: false,
        is_bot_message: false,
      },
    ];
    cliChannel = makeCliChannel();
    apiServer = createApiServer({
      apiKey: TEST_API_KEY,
      cliChannel,
      getGroups: () => mockGroups,
      getHistory: (_jid: string, _limit?: number) => mockHistory,
    });
    port = await startServer(apiServer);
  });

  afterEach(async () => {
    await closeServer(apiServer);
  });

  // --- Auth ---

  it('rejects requests without an API key', async () => {
    const res = await request(port, 'GET', '/api/status');
    expect(res.status).toBe(401);
    expect(JSON.parse(res.body)).toEqual({ error: 'Unauthorized' });
  });

  it('rejects requests with an invalid API key', async () => {
    const res = await request(port, 'GET', '/api/status', {
      token: 'wrong-key',
    });
    expect(res.status).toBe(401);
  });

  it('accepts requests with a valid API key', async () => {
    const res = await request(port, 'GET', '/api/status', {
      token: TEST_API_KEY,
    });
    expect(res.status).toBe(200);
  });

  // --- CORS ---

  it('responds to OPTIONS with 204 and CORS headers', async () => {
    const res = await request(port, 'OPTIONS', '/api/status');
    expect(res.status).toBe(204);
    expect(res.headers['access-control-allow-origin']).toBe('*');
    expect(res.headers['access-control-allow-headers']).toContain(
      'Authorization',
    );
    expect(res.headers['access-control-allow-methods']).toContain('GET');
  });

  // --- GET /api/status ---

  it('GET /api/status returns ok with channel info', async () => {
    const res = await request(port, 'GET', '/api/status', {
      token: TEST_API_KEY,
    });
    expect(res.status).toBe(200);
    const data = JSON.parse(res.body);
    expect(data.ok).toBe(true);
    expect(data.channels).toEqual(['cli']);
    expect(typeof data.sseClients).toBe('number');
  });

  // --- GET /api/groups ---

  it('GET /api/groups returns registered groups', async () => {
    const res = await request(port, 'GET', '/api/groups', {
      token: TEST_API_KEY,
    });
    expect(res.status).toBe(200);
    const data = JSON.parse(res.body);
    expect(data['test@g.us']).toBeDefined();
    expect(data['test@g.us'].name).toBe('Test Group');
  });

  // --- GET /api/groups/:jid/history ---

  it('GET /api/groups/:jid/history returns message history', async () => {
    const res = await request(
      port,
      'GET',
      `/api/groups/${encodeURIComponent('test@g.us')}/history`,
      { token: TEST_API_KEY },
    );
    expect(res.status).toBe(200);
    const data = JSON.parse(res.body);
    expect(data).toHaveLength(1);
    expect(data[0].id).toBe('msg-1');
    expect(data[0].content).toBe('Hello');
  });

  it('GET /api/groups/:jid/history passes limit parameter', async () => {
    const getHistory = vi.fn((_jid: string, _limit?: number) => mockHistory);
    await closeServer(apiServer);

    apiServer = createApiServer({
      apiKey: TEST_API_KEY,
      cliChannel,
      getGroups: () => mockGroups,
      getHistory,
    });
    port = await startServer(apiServer);

    await request(
      port,
      'GET',
      `/api/groups/${encodeURIComponent('test@g.us')}/history?limit=10`,
      { token: TEST_API_KEY },
    );
    expect(getHistory).toHaveBeenCalledWith('test@g.us', 10);
  });

  // --- POST /api/messages ---

  it('POST /api/messages injects message via CliChannel and returns 202', async () => {
    const res = await request(port, 'POST', '/api/messages', {
      token: TEST_API_KEY,
      body: { jid: 'cli:test@g.us', content: 'Hello from test' },
    });
    expect(res.status).toBe(202);
    expect(JSON.parse(res.body)).toEqual({ accepted: true });

    const onMessage = cliChannel['opts'].onMessage as ReturnType<typeof vi.fn>;
    expect(onMessage).toHaveBeenCalledTimes(1);
    const [chatJid, msg] = onMessage.mock.calls[0];
    expect(chatJid).toBe('cli:test@g.us');
    expect(msg.content).toBe('Hello from test');
    expect(msg.sender).toBe('cli-user');
    expect(msg.sender_name).toBe('User');
  });

  it('POST /api/messages with custom sender fields', async () => {
    const res = await request(port, 'POST', '/api/messages', {
      token: TEST_API_KEY,
      body: {
        jid: 'cli:test@g.us',
        content: 'Custom sender',
        sender: 'alice',
        senderName: 'Alice',
      },
    });
    expect(res.status).toBe(202);

    const onMessage = cliChannel['opts'].onMessage as ReturnType<typeof vi.fn>;
    const [, msg] = onMessage.mock.calls[0];
    expect(msg.sender).toBe('alice');
    expect(msg.sender_name).toBe('Alice');
  });

  it('POST /api/messages with voice type wraps content', async () => {
    await request(port, 'POST', '/api/messages', {
      token: TEST_API_KEY,
      body: {
        jid: 'cli:test@g.us',
        content: 'transcribed text',
        type: 'voice',
      },
    });

    const onMessage = cliChannel['opts'].onMessage as ReturnType<typeof vi.fn>;
    const [, msg] = onMessage.mock.calls[0];
    expect(msg.content).toBe('[Voice: transcribed text]');
  });

  it('POST /api/messages rejects missing jid', async () => {
    const res = await request(port, 'POST', '/api/messages', {
      token: TEST_API_KEY,
      body: { content: 'no jid' },
    });
    expect(res.status).toBe(400);
    expect(JSON.parse(res.body).error).toBe('jid and content are required');
  });

  it('POST /api/messages rejects missing content', async () => {
    const res = await request(port, 'POST', '/api/messages', {
      token: TEST_API_KEY,
      body: { jid: 'cli:test@g.us' },
    });
    expect(res.status).toBe(400);
  });

  it('POST /api/messages rejects invalid JSON', async () => {
    const res = await new Promise<{
      status: number;
      headers: http.IncomingHttpHeaders;
      body: string;
    }>((resolve, reject) => {
      const req = http.request(
        {
          hostname: '127.0.0.1',
          port,
          path: '/api/messages',
          method: 'POST',
          headers: {
            Authorization: `Bearer ${TEST_API_KEY}`,
            'Content-Type': 'application/json',
          },
        },
        (res) => {
          let body = '';
          res.on('data', (chunk: Buffer) => (body += chunk));
          res.on('end', () =>
            resolve({ status: res.statusCode!, headers: res.headers, body }),
          );
        },
      );
      req.on('error', reject);
      req.write('not valid json {{{');
      req.end();
    });

    expect(res.status).toBe(400);
    expect(JSON.parse(res.body).error).toBe('Invalid JSON body');
  });

  // --- 404 ---

  it('returns 404 for unknown routes', async () => {
    const res = await request(port, 'GET', '/api/nonexistent', {
      token: TEST_API_KEY,
    });
    expect(res.status).toBe(404);
    expect(JSON.parse(res.body)).toEqual({ error: 'Not found' });
  });

  // --- SSE ---

  it('GET /api/messages/stream establishes SSE connection and receives events', async () => {
    const events = await new Promise<string[]>((resolve, reject) => {
      const collected: string[] = [];
      const timer = setTimeout(() => {
        reject(new Error('SSE test timed out'));
      }, 5000);

      const req = http.request(
        {
          hostname: '127.0.0.1',
          port,
          path: '/api/messages/stream',
          method: 'GET',
          headers: { Authorization: `Bearer ${TEST_API_KEY}` },
        },
        (res) => {
          expect(res.statusCode).toBe(200);
          expect(res.headers['content-type']).toBe('text/event-stream');
          expect(res.headers['cache-control']).toBe('no-cache');

          let buffer = '';
          res.on('data', (chunk: Buffer) => {
            buffer += chunk.toString();
            // Parse SSE events from the buffer (events are separated by \n\n)
            const parts = buffer.split('\n\n');
            // The last element might be incomplete; keep it in the buffer
            buffer = parts.pop() || '';

            for (const part of parts) {
              if (part.trim()) {
                collected.push(part);
              }
            }

            // After receiving the connected event, push a test event
            if (
              collected.length === 1 &&
              collected[0].includes('event: connected')
            ) {
              apiServer.pushSseEvent('message', {
                jid: 'test@g.us',
                text: 'Hello SSE',
              });
            }

            // After receiving both events, resolve
            if (collected.length >= 2) {
              clearTimeout(timer);
              req.destroy();
              resolve(collected);
            }
          });
        },
      );
      req.on('error', (err) => {
        // ECONNRESET is expected when we destroy the request
        if ((err as NodeJS.ErrnoException).code !== 'ECONNRESET') {
          reject(err);
        }
      });
      req.end();
    });

    // Verify connected event
    expect(events[0]).toContain('event: connected');
    const connectedData = events[0]
      .split('\n')
      .find((l) => l.startsWith('data: '));
    expect(connectedData).toBeDefined();
    const connectedPayload = JSON.parse(connectedData!.replace('data: ', ''));
    expect(connectedPayload.clientId).toBeDefined();

    // Verify pushed message event
    expect(events[1]).toContain('event: message');
    const msgData = events[1].split('\n').find((l) => l.startsWith('data: '));
    expect(msgData).toBeDefined();
    const msgPayload = JSON.parse(msgData!.replace('data: ', ''));
    expect(msgPayload.jid).toBe('test@g.us');
    expect(msgPayload.text).toBe('Hello SSE');
  });

  it('SSE client count is reflected in /api/status', async () => {
    // Before any SSE connection
    const before = await request(port, 'GET', '/api/status', {
      token: TEST_API_KEY,
    });
    expect(JSON.parse(before.body).sseClients).toBe(0);

    // Open an SSE connection
    const sseReq = await new Promise<http.ClientRequest>((resolve) => {
      const req = http.request(
        {
          hostname: '127.0.0.1',
          port,
          path: '/api/messages/stream',
          method: 'GET',
          headers: { Authorization: `Bearer ${TEST_API_KEY}` },
        },
        (res) => {
          // Wait for the connected event before checking status
          res.once('data', () => resolve(req));
        },
      );
      req.end();
    });

    const during = await request(port, 'GET', '/api/status', {
      token: TEST_API_KEY,
    });
    expect(JSON.parse(during.body).sseClients).toBe(1);

    // Close the SSE connection
    sseReq.destroy();

    // Give the server a moment to clean up the client
    await new Promise((r) => setTimeout(r, 50));

    const after = await request(port, 'GET', '/api/status', {
      token: TEST_API_KEY,
    });
    expect(JSON.parse(after.body).sseClients).toBe(0);
  });
});
