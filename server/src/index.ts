import http from 'http';
import fs from 'fs';
import path from 'path';
import { WebSocketServer, WebSocket } from 'ws';
import { v4 as uuidv4 } from 'uuid';
import { SessionRegistry } from './session.js';
import { RateLimiter } from './ratelimit.js';
import { deliver } from './bus.js';
import type { MeshMessage, AuthedSession } from './types.js';

const PORT = parseInt(process.env.PORT ?? '9474', 10);
const BASE_DIR = path.join(process.env.HOME ?? '/tmp', '.grip-session-mesh');
const TOKEN_PATH = path.join(BASE_DIR, 'token');
const AUTH_TIMEOUT_MS = 5_000;

function loadOrCreateToken(): string {
  fs.mkdirSync(BASE_DIR, { recursive: true });
  if (fs.existsSync(TOKEN_PATH)) return fs.readFileSync(TOKEN_PATH, 'utf8').trim();
  const token = require('crypto').randomBytes(32).toString('hex');
  fs.writeFileSync(TOKEN_PATH, token, { mode: 0o600 });
  return token;
}

const BEARER = loadOrCreateToken();
const registry = new SessionRegistry();
const limiter = new RateLimiter();

const httpServer = http.createServer((req, res) => {
  if (req.method === 'GET' && req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, sessions: registry.count() }));
  } else {
    res.writeHead(404);
    res.end();
  }
});

const wss = new WebSocketServer({ server: httpServer });

function closeUnauthed(socket: WebSocket): void {
  socket.close(4401, 'Authentication required');
}

function handleMessage(session: AuthedSession, raw: string): void {
  let msg: MeshMessage;
  try { msg = JSON.parse(raw); } catch { return; }
  if (!msg.id || !msg.from || !msg.to || !msg.kind || !msg.body) return;
  deliver(msg, registry, limiter, session.id);
}

wss.on('connection', (socket) => {
  const id = uuidv4();
  const timer = setTimeout(() => closeUnauthed(socket), AUTH_TIMEOUT_MS);
  let session: AuthedSession | null = null;

  socket.on('message', (data) => {
    const raw = data.toString();

    if (!session) {
      clearTimeout(timer);
      let envelope: { authorization?: string; name?: string };
      try { envelope = JSON.parse(raw); } catch { closeUnauthed(socket); return; }

      const expected = `Bearer ${BEARER}`;
      if (envelope.authorization !== expected || !envelope.name) {
        closeUnauthed(socket);
        return;
      }

      session = { id, name: envelope.name, socket, connectedAt: new Date().toISOString(), authenticated: true };
      registry.register(session);
      socket.send(JSON.stringify({ ok: true, sessionId: id }));
      return;
    }

    handleMessage(session, raw);
  });

  socket.on('close', () => {
    clearTimeout(timer);
    if (session) { registry.deregister(session.id); limiter.remove(session.id); }
  });
});

function shutdown(): void {
  wss.close(() => httpServer.close(() => process.exit(0)));
}

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

httpServer.listen(PORT, '127.0.0.1', () => {
  console.log(`grip-session-mesh server listening on 127.0.0.1:${PORT}`);
});
