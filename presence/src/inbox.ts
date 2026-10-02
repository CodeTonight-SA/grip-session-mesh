import { DatabaseSync } from "node:sqlite";
import { v4 as uuidv4 } from "uuid";
import { isLive, LivenessContext } from "./liveness.js";
import { listSessions } from "./registry.js";

export interface InboxMessage {
  id: string;
  recipient_id: string;
  from_name: string;
  body: string;
  kind: string;
  created_at: string;
  delivered: number;
}

export function broadcast(
  db: DatabaseSync,
  fromName: string,
  body: string,
  kind: string,
  recipientIds: string[]
): void {
  const now = new Date().toISOString();
  const insert = db.prepare(`
    INSERT INTO inbox (id, recipient_id, from_name, body, kind, created_at, delivered)
    VALUES (?, ?, ?, ?, ?, ?, 0)
  `);
  for (const rid of recipientIds) {
    insert.run(uuidv4(), rid, fromName, body, kind, now);
  }
}

export interface BroadcastResult {
  ok: true;
  sent_to: number;
  skipped_not_live: number;
  sender_excluded: boolean;
}

// Queue one message for every running session except the sender, and say how
// many rows were skipped as not running rather than counting them as sent.
export function broadcastToLive(
  db: DatabaseSync,
  message: { fromName: string; body: string; kind: string; senderId?: string },
  ctx: LivenessContext
): BroadcastResult {
  const everyone = listSessions(db);
  const others = everyone.filter((session) => session.id !== message.senderId);
  const live = others.filter((session) => isLive(session, ctx));
  broadcast(db, message.fromName, message.body, message.kind, live.map((session) => session.id));
  return {
    ok: true,
    sent_to: live.length,
    skipped_not_live: others.length - live.length,
    sender_excluded: others.length < everyone.length,
  };
}

export function readInbox(
  db: DatabaseSync,
  recipientId: string,
  markDelivered = true
): InboxMessage[] {
  const messages = db.prepare(
    `SELECT * FROM inbox WHERE recipient_id = ? AND delivered = 0 ORDER BY created_at`
  ).all(recipientId) as unknown as InboxMessage[];

  if (markDelivered && messages.length > 0) {
    const ids = messages.map((m) => m.id);
    const placeholders = ids.map(() => "?").join(",");
    db.prepare(`UPDATE inbox SET delivered = 1 WHERE id IN (${placeholders})`).run(...ids);
  }
  return messages;
}
