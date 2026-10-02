// Drives the BUILT server over stdio, exactly as Claude Code and Codex do, so
// these tests compile against any version of src/ and fail on behaviour rather
// than on a missing symbol.
//
// The fixture is the shape measured on 2026-10-01: rows for sessions that are
// running and busy, running but idle at their prompt (their heartbeat is stale,
// because nothing beats while a session waits for its operator), ended, and
// superseded by /clear, plus rows from a harness with no Claude Code record.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync, ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { openDb } from "../src/db.js";

const SERVER = join(__dirname, "..", "src", "index.js");
const MINUTE = 60_000;

let work: string;
let dbPath: string;
let env: NodeJS.ProcessEnv;

// A pid that certainly belonged to a process which has exited.
function deadPid(): number {
  return spawnSync(process.execPath, ["-e", ""]).pid as number;
}

function writeRecord(sessionsDir: string, sessionId: string, pid: number): void {
  // The real file is <config dir>/sessions/<pid>.json with these keys.
  writeFileSync(join(sessionsDir, `${pid}.json`), JSON.stringify({
    pid, sessionId, kind: "interactive", entrypoint: "cli", status: "idle",
  }));
}

function seed(rows: Array<[string, number]>): void {
  const db = openDb(dbPath);
  const insert = db.prepare(`INSERT INTO sessions (id, name, machine, role, pair_partner,
    registered_at, last_heartbeat) VALUES (?, ?, NULL, 'grip', NULL, ?, ?)`);
  const registered = new Date(Date.now() - 120 * MINUTE).toISOString();
  for (const [id, beatAgoMs] of rows) {
    insert.run(id, id, registered, new Date(Date.now() - beatAgoMs).toISOString());
  }
  db.close();
}

function inboxRecipients(): string[] {
  const db = openDb(dbPath);
  const rows = db.prepare(`SELECT recipient_id FROM inbox ORDER BY recipient_id`).all();
  db.close();
  return rows.map((r) => (r as { recipient_id: string }).recipient_id);
}

function buildFixture(): void {
  work = mkdtempSync(join(tmpdir(), "presence-broadcast-"));
  const configDir = join(work, "claude");
  const sessionsDir = join(configDir, "sessions");
  mkdirSync(sessionsDir, { recursive: true });
  dbPath = join(work, "presence.db");
  env = { ...process.env, GRIP_PRESENCE_DB: dbPath, CLAUDE_CONFIG_DIR: configDir };
  writeRecord(sessionsDir, "idle", process.pid);   // running, idle at its prompt
  writeRecord(sessionsDir, "busy", process.ppid);  // running and working
  writeRecord(sessionsDir, "ended", deadPid());    // record left behind by a crash
  seed([
    ["cc-sender", 0],
    ["cc-idle", 60 * MINUTE],        // stale heartbeat, yet the process is alive
    ["cc-busy", 0],
    ["cc-ended", 0],                 // fresh heartbeat, yet the process is gone
    ["cc-cleared", 60 * MINUTE],     // id superseded by /clear: no record names it
    ["codex-recent", 0.5 * MINUTE],  // another harness, beat 30 s ago
    ["codex-silent", 10 * MINUTE],   // another harness, silent for 10 minutes
  ]);
}

// A JSON-RPC sender over the server's stdio; resolves each request with its reply.
function connect(child: ChildProcessWithoutNullStreams) {
  const waiting = new Map<number, (msg: any) => void>();
  createInterface({ input: child.stdout }).on("line", (line) => {
    const msg = JSON.parse(line);
    waiting.get(msg.id)?.(msg);
  });
  let nextId = 1;
  const request = (method: string, params: unknown) => new Promise<any>((resolve, reject) => {
    const id = nextId++;
    const timer = setTimeout(() => reject(new Error(`no reply to ${method}`)), 10_000);
    waiting.set(id, (msg) => { clearTimeout(timer); resolve(msg.result); });
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
  });
  const notify = (method: string) =>
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method, params: {} }) + "\n");
  return { request, notify };
}

// One MCP conversation: initialize, then each request in order.
async function mcp(requests: Array<[string, unknown]>): Promise<any[]> {
  const child = spawn(process.execPath, ["--experimental-sqlite", SERVER], { env });
  const { request, notify } = connect(child);
  try {
    await request("initialize", {
      protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "test", version: "0" },
    });
    notify("notifications/initialized");
    const results = [];
    for (const [method, params] of requests) results.push(await request(method, params));
    return results;
  } finally {
    child.kill();
  }
}

async function callTool(name: string, args: Record<string, unknown>): Promise<any> {
  const [result] = await mcp([["tools/call", { name, arguments: args }]]);
  return JSON.parse(result.content[0].text);
}

before(buildFixture);
after(() => rmSync(work, { recursive: true, force: true }));

test("broadcast queues for live sessions, never the sender, and counts the skipped", async () => {
  const result = await callTool("session_broadcast", {
    from_name: "Sender", from_id: "cc-sender", body: "hello", kind: "info",
  });
  assert.equal(result.sent_to, 3, "idle, busy and the recently-beating harness are live");
  assert.equal(result.skipped_not_live, 3, "ended, cleared and the silent harness are not");
  assert.equal(result.sender_excluded, true);
  assert.deepEqual(inboxRecipients(), ["cc-busy", "cc-idle", "codex-recent"]);
});

test("broadcast without from_id keeps the sender, and liveness still applies", async () => {
  const result = await callTool("session_broadcast", {
    from_name: "Anonymous", body: "again", kind: "info",
  });
  assert.equal(result.sent_to, 4, "the sender's own row beat just now, so it is live");
  assert.equal(result.skipped_not_live, 3);
  assert.equal(result.sender_excluded, false);
});

test("session_list says what it returns: every row, each marked live or not", async () => {
  const [tools, listed] = await mcp([
    ["tools/list", {}],
    ["tools/call", { name: "session_list", arguments: {} }],
  ]);
  const description = tools.tools.find((t: any) => t.name === "session_list").description;
  assert.doesNotMatch(description, /\bactive\b/i, "it lists ended sessions too");
  const rows = JSON.parse(listed.content[0].text);
  assert.equal(rows.length, 7);
  const live = rows.filter((r: any) => r.live === true).map((r: any) => r.id).sort();
  assert.deepEqual(live, ["cc-busy", "cc-idle", "cc-sender", "codex-recent"]);
});
