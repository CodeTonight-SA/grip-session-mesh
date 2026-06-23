#!/usr/bin/env node
/*
 * mesh-client.js — the missing per-session client for grip-session-mesh.
 *
 * The bus (server/) registers a session ONLY while a WebSocket stays open
 * (server/src/index.ts: socket.on('close') -> deregister), routes by NAME
 * (bus.ts: registry.findByName), and the inbound queue is keyed to the UUID
 * the bus assigns at registration. A Claude Code session can't hold a WS open
 * itself, so this lightweight client does it: it registers, stays connected
 * (auto-reconnect), records its assigned UUID for the Monitor, and drains an
 * outbound queue file to send. Receiving is handled by the bus writing
 * inbound/<uuid>.jsonl + the mesh-inbound.sh Monitor reading it.
 *
 * Zero dependencies: Node >=22 ships a global WebSocket and crypto.randomUUID.
 *
 * Usage:
 *   node mesh-client.js <name> [ws-url]      # default ws://127.0.0.1:9474
 *
 * Send a message (from anywhere): append one JSON object per line to
 *   ~/.grip-session-mesh/outbound/<name>.jsonl
 *   {"to":"<peer-name>|broadcast","kind":"message","body":"..."}
 * The client drains it within ~1s. The helper client/mesh-send.sh wraps this.
 *
 * On registration the assigned UUID is written to
 *   ~/.grip-session-mesh/<name>.session
 * so the receive Monitor can be started with GRIP_MESH_SESSION_ID=$(cat ...).
 */
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');

const NAME = process.argv[2];
if (!NAME) {
  console.error('usage: mesh-client.js <name> [ws-url]');
  process.exit(2);
}
const URL = process.argv[3] || 'ws://127.0.0.1:9474';
const MESH = path.join(os.homedir(), '.grip-session-mesh');
const OUTBOX = path.join(MESH, 'outbound', `${NAME}.jsonl`);
const IDFILE = path.join(MESH, `${NAME}.session`);

fs.mkdirSync(path.join(MESH, 'outbound'), { recursive: true });

function token() {
  return fs.readFileSync(path.join(MESH, 'token'), 'utf8').trim();
}

let ws = null;
let pollTimer = null;

function startPolling() {
  stopPolling();
  pollTimer = setInterval(drainOutbox, 1000);
}
function stopPolling() {
  if (pollTimer) clearInterval(pollTimer);
  pollTimer = null;
}

function drainOutbox() {
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  if (!fs.existsSync(OUTBOX)) return;
  const tmp = `${OUTBOX}.drain.${process.pid}`;
  let lines;
  try {
    fs.renameSync(OUTBOX, tmp); // atomic drain — a concurrent appender starts a fresh file
    lines = fs.readFileSync(tmp, 'utf8').split('\n').filter(Boolean);
    fs.unlinkSync(tmp);
  } catch {
    return;
  }
  for (const line of lines) {
    let q;
    try { q = JSON.parse(line); } catch { continue; }
    if (!q.to || q.body === undefined) continue;
    const msg = {
      id: crypto.randomUUID(),
      from: NAME,
      to: q.to,
      kind: q.kind || 'message',
      body: String(q.body),
    };
    ws.send(JSON.stringify(msg));
    console.log(`[mesh-client] sent to=${msg.to} kind=${msg.kind}`);
  }
}

function connect() {
  ws = new WebSocket(URL);

  ws.addEventListener('open', () => {
    ws.send(JSON.stringify({ authorization: `Bearer ${token()}`, name: NAME }));
  });

  ws.addEventListener('message', (ev) => {
    let m;
    try { m = JSON.parse(ev.data); } catch { return; }
    if (m.ok && m.sessionId) {
      fs.writeFileSync(IDFILE, m.sessionId);
      console.log(`[mesh-client] registered name=${NAME} id=${m.sessionId}`);
      startPolling();
    }
  });

  ws.addEventListener('close', (ev) => {
    stopPolling();
    console.log(`[mesh-client] disconnected (code=${ev.code}); reconnecting in 2s`);
    setTimeout(connect, 2000);
  });

  ws.addEventListener('error', (ev) => {
    console.error(`[mesh-client] ws error: ${ev.message || 'unknown'}`);
  });
}

process.on('SIGTERM', () => { try { ws && ws.close(); } catch {} process.exit(0); });
process.on('SIGINT', () => { try { ws && ws.close(); } catch {} process.exit(0); });

console.log(`[mesh-client] connecting name=${NAME} url=${URL}`);
connect();
