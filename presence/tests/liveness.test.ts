import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isLive, pidAlive, readClaudeSessionPids, LivenessContext } from "../src/liveness.js";
import type { Session } from "../src/registry.js";

const NOW = Date.parse("2026-10-02T12:00:00.000Z");
const LIVE_PIDS = new Set([100, 300]);

function row(id: string, secondsAgo: number): Session {
  const beat = new Date(NOW - secondsAgo * 1000).toISOString();
  return { id, name: id, machine: null, role: "grip", pair_partner: null, registered_at: beat, last_heartbeat: beat };
}

function ctx(records: Record<string, number[]>): LivenessContext {
  return {
    pidsBySession: new Map(Object.entries(records)),
    nowMs: NOW,
    windowMs: 180_000,
    alive: (pid) => LIVE_PIDS.has(pid),
  };
}

test("a running Claude Code session is live however long it has been idle", () => {
  assert.equal(isLive(row("cc-a", 6 * 3600), ctx({ a: [100] })), true);
});

test("a session whose process is gone is not live, even with a fresh heartbeat", () => {
  assert.equal(isLive(row("cc-a", 0), ctx({ a: [200] })), false);
});

test("a session with a stale record and a running one is live", () => {
  assert.equal(isLive(row("cc-a", 3600), ctx({ a: [200, 300] })), true);
});

test("a row with no record falls back to the 180-second heartbeat window", () => {
  assert.equal(isLive(row("codex-1", 179), ctx({})), true);
  assert.equal(isLive(row("codex-1", 181), ctx({})), false);
});

test("an unreadable heartbeat is not live", () => {
  assert.equal(isLive({ ...row("codex-1", 0), last_heartbeat: "not a time" }, ctx({})), false);
});

test("a cc-pid fallback id is judged by heartbeat, never mistaken for a session id", () => {
  assert.equal(isLive(row("cc-pid-100", 3600), ctx({ a: [100] })), false);
});

test("records are grouped by sessionId and malformed files are ignored", () => {
  const dir = mkdtempSync(join(tmpdir(), "claude-sessions-"));
  try {
    writeFileSync(join(dir, "100.json"), JSON.stringify({ pid: 100, sessionId: "a" }));
    writeFileSync(join(dir, "101.json"), JSON.stringify({ pid: 101, sessionId: "a" }));
    writeFileSync(join(dir, "102.json"), "{ half-written");
    writeFileSync(join(dir, "103.json"), JSON.stringify({ sessionId: "b" }));
    writeFileSync(join(dir, "100.key"), "not a record");
    const index = readClaudeSessionPids(dir);
    assert.deepEqual([...index.keys()], ["a"]);
    assert.deepEqual([...(index.get("a") ?? [])].sort(), [100, 101]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a missing sessions directory means no records, not an error", () => {
  assert.equal(readClaudeSessionPids(join(tmpdir(), "no-such-dir-for-presence-tests")).size, 0);
});

test("pidAlive tells this process from one that has exited", () => {
  assert.equal(pidAlive(process.pid), true);
  assert.equal(pidAlive(spawnSync(process.execPath, ["-e", ""]).pid as number), false);
});
