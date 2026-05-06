import { DatabaseSync } from "node:sqlite";

export interface Session {
  id: string;
  name: string;
  machine: string | null;
  role: string | null;
  pair_partner: string | null;
  registered_at: string;
  last_heartbeat: string;
}

interface RegisterParams {
  id: string;
  name: string;
  machine?: string;
  role?: string;
}

export function registerSession(db: DatabaseSync, params: RegisterParams): void {
  const now = new Date().toISOString();
  db.prepare(`
    INSERT INTO sessions (id, name, machine, role, pair_partner, registered_at, last_heartbeat)
    VALUES (?, ?, ?, ?, NULL, ?, ?)
    ON CONFLICT(id) DO UPDATE SET name=excluded.name, machine=excluded.machine,
      role=excluded.role, last_heartbeat=excluded.last_heartbeat
  `).run(params.id, params.name, params.machine ?? null, params.role ?? null, now, now);
}

export function heartbeat(db: DatabaseSync, id: string): void {
  db.prepare(`UPDATE sessions SET last_heartbeat = ? WHERE id = ?`)
    .run(new Date().toISOString(), id);
}

export function deregister(db: DatabaseSync, id: string): void {
  db.prepare(`DELETE FROM sessions WHERE id = ?`).run(id);
}

export function listSessions(db: DatabaseSync): Session[] {
  return db.prepare(`SELECT * FROM sessions ORDER BY registered_at`).all() as unknown as Session[];
}
