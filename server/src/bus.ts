import fs from 'fs';
import path from 'path';
import type { MeshMessage } from './types.js';
import type { SessionRegistry } from './session.js';
import type { RateLimiter } from './ratelimit.js';

const BASE_DIR = path.join(process.env.HOME ?? '/tmp', '.grip-session-mesh');
const INBOUND_DIR = path.join(BASE_DIR, 'inbound');
const LOG_PATH = path.join(BASE_DIR, 'log.jsonl');

const DIRECT_LIMIT = 10 * 1024 * 1024;   // 10 MB
const BROADCAST_LIMIT = 256 * 1024;        // 256 KB

function ensureInbound(recipientId: string): string {
  fs.mkdirSync(INBOUND_DIR, { recursive: true });
  return path.join(INBOUND_DIR, `${recipientId}.jsonl`);
}

function appendLog(msg: MeshMessage, note: string): void {
  const line = JSON.stringify({ ...msg, _note: note, _logged: new Date().toISOString() });
  fs.appendFileSync(LOG_PATH, line + '\n');
}

function writeInbound(recipientId: string, msg: MeshMessage): void {
  const file = ensureInbound(recipientId);
  fs.appendFileSync(file, JSON.stringify(msg) + '\n');
}

function deliverDirect(msg: MeshMessage, registry: SessionRegistry): string {
  if (Buffer.byteLength(msg.body) > DIRECT_LIMIT) return 'body_too_large';
  const recipient = registry.findByName(msg.to);
  if (!recipient) return 'recipient_not_found';
  writeInbound(recipient.id, msg);
  return 'ok';
}

function deliverBroadcast(
  msg: MeshMessage,
  registry: SessionRegistry,
  limiter: RateLimiter,
  senderId: string,
): string {
  if (!limiter.allow(senderId)) return 'rate_limited';
  if (Buffer.byteLength(msg.body) > BROADCAST_LIMIT) return 'body_too_large';
  for (const s of registry.list()) {
    if (s.id !== senderId) writeInbound(s.id, msg);
  }
  return 'ok';
}

export function deliver(
  msg: MeshMessage,
  registry: SessionRegistry,
  limiter: RateLimiter,
  senderId: string,
): string {
  const result =
    msg.to === 'broadcast'
      ? deliverBroadcast(msg, registry, limiter, senderId)
      : deliverDirect(msg, registry);
  appendLog(msg, result);
  return result;
}
