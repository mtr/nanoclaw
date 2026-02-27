import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { logger } from './logger.js';
import { DATA_DIR } from './config.js';
import type { CliChannel } from './channels/cli.js';
import type { RegisteredGroup, NewMessage } from './types.js';

export interface ApiServerOpts {
  port: number;
  apiKey: string;
  cliChannel: CliChannel;
  getGroups: () => Record<string, RegisteredGroup>;
  getHistory: (jid: string, limit?: number) => NewMessage[];
}

interface SseClient {
  id: string;
  res: http.ServerResponse;
}

const sseClients: SseClient[] = [];

export function pushSseEvent(
  event: string,
  data: Record<string, unknown>,
): void {
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const client of sseClients) {
    client.res.write(payload);
  }
}

function parseBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    let body = '';
    req.on('data', (chunk: string) => (body += chunk));
    req.on('end', () => resolve(body));
  });
}

function jsonResponse(
  res: http.ServerResponse,
  status: number,
  data: unknown,
): void {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data));
}

export function createApiServer(opts: ApiServerOpts): http.Server {
  const audioDir = path.join(DATA_DIR, 'audio');
  fs.mkdirSync(audioDir, { recursive: true });

  const server = http.createServer(async (req, res) => {
    // CORS for local clients
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader(
      'Access-Control-Allow-Headers',
      'Authorization, Content-Type',
    );
    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }

    // Auth check
    const authHeader = req.headers.authorization || '';
    const token = authHeader.replace(/^Bearer\s+/i, '');
    if (token !== opts.apiKey) {
      jsonResponse(res, 401, { error: 'Unauthorized' });
      return;
    }

    const url = new URL(req.url || '/', `http://${req.headers.host}`);
    const pathname = url.pathname;

    try {
      // GET /api/status
      if (req.method === 'GET' && pathname === '/api/status') {
        jsonResponse(res, 200, {
          ok: true,
          channels: ['cli'],
          sseClients: sseClients.length,
        });
        return;
      }

      // POST /api/messages
      if (req.method === 'POST' && pathname === '/api/messages') {
        const raw = await parseBody(req);
        const msg = JSON.parse(raw);
        const { jid, content, type, sender, senderName } = msg;
        if (!jid || !content) {
          jsonResponse(res, 400, { error: 'jid and content are required' });
          return;
        }
        opts.cliChannel.injectMessage(
          jid,
          sender || 'cli-user',
          senderName || 'User',
          type === 'voice' ? `[Voice: ${content}]` : content,
        );
        jsonResponse(res, 202, { accepted: true });
        return;
      }

      // GET /api/messages/stream (SSE)
      if (req.method === 'GET' && pathname === '/api/messages/stream') {
        res.writeHead(200, {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          Connection: 'keep-alive',
        });
        const client: SseClient = { id: randomUUID(), res };
        sseClients.push(client);
        res.write(`event: connected\ndata: {"clientId":"${client.id}"}\n\n`);
        req.on('close', () => {
          const idx = sseClients.indexOf(client);
          if (idx !== -1) sseClients.splice(idx, 1);
        });
        return;
      }

      // GET /api/groups
      if (req.method === 'GET' && pathname === '/api/groups') {
        jsonResponse(res, 200, opts.getGroups());
        return;
      }

      // GET /api/groups/:jid/history
      const historyMatch = pathname.match(/^\/api\/groups\/(.+)\/history$/);
      if (req.method === 'GET' && historyMatch) {
        const jid = decodeURIComponent(historyMatch[1]);
        const limit = parseInt(url.searchParams.get('limit') || '50', 10);
        const history = opts.getHistory(jid, limit);
        jsonResponse(res, 200, history);
        return;
      }

      // GET /api/audio/:id
      const audioMatch = pathname.match(/^\/api\/audio\/(.+)$/);
      if (req.method === 'GET' && audioMatch) {
        const filename = audioMatch[1];
        // Prevent directory traversal
        if (filename.includes('..') || filename.includes('/')) {
          jsonResponse(res, 400, { error: 'Invalid audio ID' });
          return;
        }
        const audioFile = path.join(audioDir, filename);
        if (!fs.existsSync(audioFile)) {
          jsonResponse(res, 404, { error: 'Audio not found' });
          return;
        }
        const ext = path.extname(audioFile);
        const mimeTypes: Record<string, string> = {
          '.ogg': 'audio/ogg',
          '.mp3': 'audio/mpeg',
          '.opus': 'audio/opus',
        };
        res.writeHead(200, {
          'Content-Type': mimeTypes[ext] || 'application/octet-stream',
        });
        fs.createReadStream(audioFile).pipe(res);
        return;
      }

      // GET /api/cost/summary
      if (req.method === 'GET' && pathname === '/api/cost/summary') {
        const { getTtsUsageSummary, checkBudget } = await import(
          './cost-tracker.js'
        );
        jsonResponse(res, 200, {
          usage: getTtsUsageSummary(),
          budget: checkBudget(),
        });
        return;
      }

      // POST /api/cost/budget
      if (req.method === 'POST' && pathname === '/api/cost/budget') {
        const raw = await parseBody(req);
        const { period, amount } = JSON.parse(raw);
        if (
          !['daily', 'weekly', 'monthly'].includes(period) ||
          typeof amount !== 'number'
        ) {
          jsonResponse(res, 400, { error: 'Invalid period or amount' });
          return;
        }
        const { setBudget } = await import('./cost-tracker.js');
        setBudget(period, amount);
        jsonResponse(res, 200, { ok: true });
        return;
      }

      // 404
      jsonResponse(res, 404, { error: 'Not found' });
    } catch (err) {
      logger.error({ err }, 'API server error');
      jsonResponse(res, 500, { error: 'Internal server error' });
    }
  });

  return server;
}

/** Save a TTS audio buffer and return its ID for serving via /api/audio/:id */
export function saveAudioFile(audio: Buffer, format = 'ogg'): string {
  const audioDir = path.join(DATA_DIR, 'audio');
  fs.mkdirSync(audioDir, { recursive: true });
  const id = `${randomUUID()}.${format}`;
  fs.writeFileSync(path.join(audioDir, id), audio);
  return id;
}
