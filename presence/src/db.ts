import { DatabaseSync } from "node:sqlite";
import { mkdirSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join, dirname } from "node:path";

const DEFAULT_DB_PATH = join(homedir(), ".grip-session-mesh", "presence.db");

const DDL = `
CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  machine TEXT,
  role TEXT,
  pair_partner TEXT,
  registered_at TEXT NOT NULL,
  last_heartbeat TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS locks (
  resource TEXT PRIMARY KEY,
  holder_id TEXT NOT NULL,
  holder_name TEXT NOT NULL,
  acquired_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS inbox (
  id TEXT PRIMARY KEY,
  recipient_id TEXT NOT NULL,
  from_name TEXT NOT NULL,
  body TEXT NOT NULL,
  kind TEXT NOT NULL,
  created_at TEXT NOT NULL,
  delivered INTEGER NOT NULL DEFAULT 0
);
`;

export function openDb(path?: string): DatabaseSync {
  const dbPath = path ?? process.env.GRIP_PRESENCE_DB ?? DEFAULT_DB_PATH;
  if (dbPath !== ":memory:" && !existsSync(dirname(dbPath))) {
    mkdirSync(dirname(dbPath), { recursive: true });
  }
  const db = new DatabaseSync(dbPath);
  db.exec(DDL);
  return db;
}

let _db: DatabaseSync | null = null;

export function getDb(): DatabaseSync {
  if (!_db) _db = openDb();
  return _db;
}
