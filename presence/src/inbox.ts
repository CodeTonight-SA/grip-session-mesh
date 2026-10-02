import { DatabaseSync } from "node:sqlite";
import { v4 as uuidv4 } from "uuid";
import { classify, LivenessContext } from "./liveness.js";
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
  running: number;
  unconfirmed: number;
  gone: number;
  sender_excluded: boolean;
}

// Queue one message for every session except the sender and those known to
// have gone. Sessions that cannot be confirmed either way are queued anyway and
// counted separately: a missed message is the failure this exists to prevent.
export function broadcastUnlessGone(
  db: DatabaseSync,
  message: { fromName: string; body: string; kind: string; senderId?: string },
  ctx: LivenessContext
): BroadcastResult {
  const everyone = listSessions(db);
  const others = everyone.filter((session) => session.id !== message.senderId);
  const counts = { running: 0, unconfirmed: 0, gone: 0 };
  const recipients: string[] = [];
  for (const session of others) {
    const state = classify(session, ctx);
    counts[state] += 1;
    if (state !== "gone") recipients.push(session.id);
  }
  broadcast(db, message.fromName, message.body, message.kind, recipients);
  return {
    ok: true,
    sent_to: recipients.length,
    ...counts,
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
