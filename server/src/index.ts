import http from 'http';
import fs from 'fs';
import path from 'path';
import { WebSocketServer, WebSocket } from 'ws';
import { v4 as uuidv4 } from 'uuid';
import { SessionRegistry } from './session.js';
import { RateLimiter } from './ratelimit.js';
import { deliver } from './bus.js';
import { classifyAuth } from './auth.js';
import type { MeshMessage, AuthedSession, AuthEnvelope } from './types.js';

const PORT = parseInt(process.env.PORT ?? '9474', 10);
const BASE_DIR = process.env.GRIP_MESH_DIR ?? path.join(process.env.HOME ?? '/tmp', '.grip-session-mesh');
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

function handleMessage(senderId: string, raw: string, fromRelay: boolean): void {
  let msg: MeshMessage;
  try { msg = JSON.parse(raw); } catch { return; }
  if (!msg.id || !msg.from || !msg.to || !msg.kind || !msg.body) return;
  deliver(msg, registry, limiter, senderId, fromRelay);
}

wss.on('connection', (socket) => {
  const id = uuidv4();
  const timer = setTimeout(() => closeUnauthed(socket), AUTH_TIMEOUT_MS);
  let session: AuthedSession | null = null;
  let isRelay = false;

  socket.on('message', (data) => {
    const raw = data.toString();

    if (!session && !isRelay) {
      clearTimeout(timer);
      let envelope: AuthEnvelope;
      try { envelope = JSON.parse(raw); } catch { closeUnauthed(socket); return; }

      const decision = classifyAuth(envelope, `Bearer ${BEARER}`);
      if (decision.kind === 'reject') { closeUnauthed(socket); return; }

      if (decision.kind === 'relay') {
        isRelay = true;
        registry.registerRelay(socket);
        socket.send(JSON.stringify({ ok: true, relay: true, sessionId: id }));
        return;
      }

      session = { id, name: decision.name, socket, connectedAt: new Date().toISOString(), authenticated: true };
      registry.register(session);
      socket.send(JSON.stringify({ ok: true, sessionId: id }));
      return;
    }

    // Messages from a relay are delivered locally and never re-relayed
    // (fromRelay=true); messages from a named session may fan out to relays.
    handleMessage(isRelay ? id : session!.id, raw, isRelay);
  });

  socket.on('close', () => {
    clearTimeout(timer);
    if (isRelay) registry.deregisterRelay(socket);
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
