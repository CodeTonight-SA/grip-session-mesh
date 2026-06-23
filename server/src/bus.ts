import fs from 'fs';
import path from 'path';
import type { MeshMessage } from './types.js';
import type { SessionRegistry } from './session.js';
import type { RateLimiter } from './ratelimit.js';

const DIRECT_LIMIT = 10 * 1024 * 1024;   // 10 MB
const BROADCAST_LIMIT = 256 * 1024;        // 256 KB

// Message-id dedup. The bidirectional relay topology (A->B and B->A links both
// forward) can push one message down two paths, so a peer bus can be asked to
// deliver the same message twice. Message ids are globally unique (the client
// mints crypto.randomUUID per send), so dropping an id we have already delivered
// removes the duplicate and can never drop a distinct message. Bounded LRU.
const SEEN_MAX = 4096;
const seenIds = new Set<string>();
const seenOrder: string[] = [];

function alreadyDelivered(id: string): boolean {
  if (seenIds.has(id)) return true;
  seenIds.add(id);
  seenOrder.push(id);
  if (seenOrder.length > SEEN_MAX) {
    const evicted = seenOrder.shift();
    if (evicted !== undefined) seenIds.delete(evicted);
  }
  return false;
}

/** Test-only: clear dedup memory so cases do not leak ids into each other. */
export function _resetDedup(): void {
  seenIds.clear();
  seenOrder.length = 0;
}

// Base directory is resolved per-call (not at module load) so tests can point
// it at a temp dir via GRIP_MESH_DIR without spawning a fresh process.
function meshDir(): string {
  return process.env.GRIP_MESH_DIR ?? path.join(process.env.HOME ?? '/tmp', '.grip-session-mesh');
}

function ensureInbound(recipientId: string): string {
  const inboundDir = path.join(meshDir(), 'inbound');
  fs.mkdirSync(inboundDir, { recursive: true });
  return path.join(inboundDir, `${recipientId}.jsonl`);
}

function appendLog(msg: MeshMessage, note: string): void {
  const logPath = path.join(meshDir(), 'log.jsonl');
  fs.mkdirSync(path.dirname(logPath), { recursive: true });
  const line = JSON.stringify({ ...msg, _note: note, _logged: new Date().toISOString() });
  fs.appendFileSync(logPath, line + '\n');
}

function writeInbound(recipientId: string, msg: MeshMessage): void {
  const file = ensureInbound(recipientId);
  fs.appendFileSync(file, JSON.stringify(msg) + '\n');
}

/**
 * Push a message to every connected relay (Layer 2 bridge) so a peer machine
 * can deliver it. Returns the number of relays the message was handed to.
 */
function pushToRelays(msg: MeshMessage, registry: SessionRegistry): number {
  const payload = JSON.stringify(msg);
  let sent = 0;
  for (const socket of registry.listRelays()) {
    try {
      socket.send(payload);
      sent++;
    } catch {
      // Relay socket is gone; its close handler will deregister it.
    }
  }
  return sent;
}

function deliverDirect(msg: MeshMessage, registry: SessionRegistry, fromRelay: boolean): string {
  if (Buffer.byteLength(msg.body) > DIRECT_LIMIT) return 'body_too_large';
  const recipient = registry.findByName(msg.to);
  if (recipient) {
    writeInbound(recipient.id, msg);
    return 'ok';
  }
  // Recipient is not on this bus. If the message originated locally, forward it
  // to peer machines so a remote bus can deliver it. A message that ARRIVED via
  // a relay is never re-relayed (loop prevention).
  if (!fromRelay && pushToRelays(msg, registry) > 0) return 'relayed';
  return 'recipient_not_found';
}

function deliverBroadcast(
  msg: MeshMessage,
  registry: SessionRegistry,
  limiter: RateLimiter,
  senderId: string,
  fromRelay: boolean,
): string {
  if (!limiter.allow(senderId)) return 'rate_limited';
  if (Buffer.byteLength(msg.body) > BROADCAST_LIMIT) return 'body_too_large';
  for (const s of registry.list()) {
    if (s.id !== senderId) writeInbound(s.id, msg);
  }
  // Fan a locally-originated broadcast out to peer machines too. A broadcast
  // that arrived via a relay reaches local sessions only — never echoed back.
  if (!fromRelay) pushToRelays(msg, registry);
  return 'ok';
}

export function deliver(
  msg: MeshMessage,
  registry: SessionRegistry,
  limiter: RateLimiter,
  senderId: string,
  fromRelay = false,
): string {
  // Drop a message id we have already delivered (relay double-push dedup).
  if (alreadyDelivered(msg.id)) {
    appendLog(msg, 'duplicate');
    return 'duplicate';
  }
  const result =
    msg.to === 'broadcast'
      ? deliverBroadcast(msg, registry, limiter, senderId, fromRelay)
      : deliverDirect(msg, registry, fromRelay);
  appendLog(msg, result);
  return result;
}
