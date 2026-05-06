import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { openDb } from "../src/db.js";
import { registerSession, heartbeat, deregister, listSessions } from "../src/registry.js";
import { acquireLock, releaseLock, lockStatus } from "../src/locking.js";
import { broadcast, readInbox } from "../src/inbox.js";

function testDb() {
  return openDb(":memory:");
}

describe("session registry", () => {
  test("session register and list", () => {
    const db = testDb();
    registerSession(db, { id: "s1", name: "Alpha", machine: "mac" });
    const sessions = listSessions(db);
    assert.equal(sessions.length, 1);
    assert.equal(sessions[0].name, "Alpha");
    assert.equal(sessions[0].machine, "mac");
  });

  test("heartbeat updates timestamp", async () => {
    const db = testDb();
    registerSession(db, { id: "s1", name: "Alpha" });
    const before = listSessions(db)[0].last_heartbeat;
    await new Promise((r) => setTimeout(r, 10));
    heartbeat(db, "s1");
    const after = listSessions(db)[0].last_heartbeat;
    assert.ok(after > before, "heartbeat should advance last_heartbeat");
  });

  test("deregister removes session", () => {
    const db = testDb();
    registerSession(db, { id: "s1", name: "Alpha" });
    deregister(db, "s1");
    assert.equal(listSessions(db).length, 0);
  });
});

describe("locking", () => {
  test("lock acquire succeeds", () => {
    const db = testDb();
    const result = acquireLock(db, "git/main", "s1", "Alpha");
    assert.equal(result.ok, true);
    assert.equal(lockStatus(db).length, 1);
  });

  test("lock acquire fails if held", () => {
    const db = testDb();
    acquireLock(db, "git/main", "s1", "Alpha");
    const result = acquireLock(db, "git/main", "s2", "Beta");
    assert.equal(result.ok, false);
    assert.ok(result.error?.includes("Alpha"));
  });

  test("lock release by holder succeeds", () => {
    const db = testDb();
    acquireLock(db, "git/main", "s1", "Alpha");
    const result = releaseLock(db, "git/main", "s1");
    assert.equal(result.ok, true);
    assert.equal(lockStatus(db).length, 0);
  });

  test("lock release by non-holder fails", () => {
    const db = testDb();
    acquireLock(db, "git/main", "s1", "Alpha");
    const result = releaseLock(db, "git/main", "s2");
    assert.equal(result.ok, false);
    assert.ok(result.error);
  });
});

describe("inbox", () => {
  test("broadcast and read marks delivered", () => {
    const db = testDb();
    registerSession(db, { id: "s1", name: "Alpha" });
    registerSession(db, { id: "s2", name: "Beta" });
    broadcast(db, "Sender", "hello", "info", ["s1", "s2"]);

    const s1msgs = readInbox(db, "s1", true);
    assert.equal(s1msgs.length, 1);
    assert.equal(s1msgs[0].body, "hello");

    // after mark_delivered=true, second read returns empty
    const s1again = readInbox(db, "s1", false);
    assert.equal(s1again.length, 0);

    // s2 unread still has message
    const s2msgs = readInbox(db, "s2", false);
    assert.equal(s2msgs.length, 1);
  });
});
