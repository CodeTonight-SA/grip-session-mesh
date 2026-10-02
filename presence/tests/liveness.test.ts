import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { classify, pidAlive, readClaudeSessionPids, LivenessContext } from "../src/liveness.js";
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

test("a running Claude Code session is running however long it has been idle", () => {
  assert.equal(classify(row("cc-a", 6 * 3600), ctx({ a: [100] })), "running");
});

test("a session whose every process has exited is gone", () => {
  assert.equal(classify(row("cc-a", 3600), ctx({ a: [200] })), "gone");
});

test("a dead pid with a fresh heartbeat is running: when unsure, queue", () => {
  assert.equal(classify(row("cc-a", 0), ctx({ a: [200] })), "running");
});

test("a stale record beside a running one is running", () => {
  assert.equal(classify(row("cc-a", 3600), ctx({ a: [200, 300] })), "running");
});

test("with no record, a beat inside 180 seconds is running and older is unconfirmed", () => {
  assert.equal(classify(row("codex-1", 179), ctx({})), "running");
  assert.equal(classify(row("codex-1", 181), ctx({})), "unconfirmed");
});

test("an unreadable heartbeat with no record is unconfirmed, never gone", () => {
  assert.equal(classify({ ...row("codex-1", 0), last_heartbeat: "not a time" }, ctx({})), "unconfirmed");
});

test("a cc-pid fallback id is never read as a session id", () => {
  assert.equal(classify(row("cc-pid-100", 3600), ctx({ a: [100] })), "unconfirmed");
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
