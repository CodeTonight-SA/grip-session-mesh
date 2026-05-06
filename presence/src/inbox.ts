import { DatabaseSync } from "node:sqlite";
import { v4 as uuidv4 } from "uuid";

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
