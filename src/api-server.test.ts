import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import http from 'node:http';
import { createApiServer } from './api-server.js';

// Mock logger to avoid pino initialization side effects
vi.mock('./logger.js', () => ({
  logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

// Mock config to use a temp directory for DATA_DIR
vi.mock('./config.js', () => ({
  DATA_DIR: '/tmp/nanoclaw-test-data',
}));

// Test helpers
function request(
  method: string,
  path: string,
  body?: object,
  apiKey = 'test-key',
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    };
    if (apiKey) {
      headers['Authorization'] = `Bearer ${apiKey}`;
    }
    const req = http.request(
      { hostname: '127.0.0.1', port: 13579, path, method, headers },
      (res) => {
        let data = '';
        res.on('data', (chunk) => (data += chunk));
        res.on('end', () => resolve({ status: res.statusCode!, body: data }));
      },
    );
    req.on('error', reject);
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

describe('API Server', () => {
  let server: http.Server;

  beforeAll(async () => {
    server = createApiServer({
      port: 13579,
      apiKey: 'test-key',
      cliChannel: {
        injectMessage: vi.fn(),
      } as any,
      getGroups: vi.fn(() => ({})),
      getHistory: vi.fn(() => []),
    });
    await new Promise<void>((r) => server.listen(13579, '127.0.0.1', r));
  });

  afterAll(() => server.close());

  it('rejects requests without API key', async () => {
    const res = await request('GET', '/api/status', undefined, '');
    expect(res.status).toBe(401);
  });

  it('rejects requests with wrong API key', async () => {
    const res = await request('GET', '/api/status', undefined, 'wrong');
    expect(res.status).toBe(401);
  });

  it('returns status on GET /api/status', async () => {
    const res = await request('GET', '/api/status');
    expect(res.status).toBe(200);
    const data = JSON.parse(res.body);
    expect(data).toHaveProperty('ok', true);
  });

  it('accepts messages on POST /api/messages', async () => {
    const res = await request('POST', '/api/messages', {
      jid: 'cli:main',
      content: 'Hello',
      type: 'text',
    });
    expect(res.status).toBe(202);
  });

  it('returns 404 for unknown routes', async () => {
    const res = await request('GET', '/api/nonexistent');
    expect(res.status).toBe(404);
  });
});
