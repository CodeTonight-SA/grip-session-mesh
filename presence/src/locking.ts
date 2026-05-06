import { DatabaseSync } from "node:sqlite";

export interface Lock {
  resource: string;
  holder_id: string;
  holder_name: string;
  acquired_at: string;
  expires_at: string;
}

export function acquireLock(
  db: DatabaseSync,
  resource: string,
  holderId: string,
  holderName: string,
  ttlMinutes = 10
): { ok: boolean; error?: string } {
  const now = new Date();
  const existing = db.prepare(`SELECT * FROM locks WHERE resource = ?`).get(resource) as unknown as Lock | undefined;

  if (existing && existing.expires_at > now.toISOString()) {
    return { ok: false, error: `Lock held by ${existing.holder_name} until ${existing.expires_at}` };
  }

  const expiresAt = new Date(now.getTime() + ttlMinutes * 60_000).toISOString();
  db.prepare(`
    INSERT INTO locks (resource, holder_id, holder_name, acquired_at, expires_at)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(resource) DO UPDATE SET holder_id=excluded.holder_id, holder_name=excluded.holder_name,
      acquired_at=excluded.acquired_at, expires_at=excluded.expires_at
  `).run(resource, holderId, holderName, now.toISOString(), expiresAt);
  return { ok: true };
}

export function releaseLock(
  db: DatabaseSync,
  resource: string,
  holderId: string
): { ok: boolean; error?: string } {
  const existing = db.prepare(`SELECT * FROM locks WHERE resource = ?`).get(resource) as unknown as Lock | undefined;
  if (!existing) return { ok: true };
  if (existing.holder_id !== holderId) {
    return { ok: false, error: `Lock held by ${existing.holder_name}, not you` };
  }
  db.prepare(`DELETE FROM locks WHERE resource = ?`).run(resource);
  return { ok: true };
}

export function lockStatus(db: DatabaseSync): Lock[] {
  const now = new Date().toISOString();
  return db.prepare(`SELECT * FROM locks WHERE expires_at > ? ORDER BY acquired_at`).all(now) as unknown as Lock[];
}
