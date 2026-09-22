'use strict';
/*
 * The client must SURVIVE a bus that is not listening yet.
 *
 * This is a behavioural anchor, not a source scan, and that is deliberate: a
 * grep for `setTimeout` passes against the broken client. Only running it and
 * watching whether the process is still there distinguishes the two.
 *
 * The defect it pins, measured on DESKTOP-6KG0VQ4 on 2026-09-22: at logon all
 * three mesh tasks start at once. The bus took ~9s to bind; the client gave up
 * 2.2s BEFORE that and exited 0. `connect()` re-armed the reconnect only from
 * the 'close' handler, and a REFUSED connection fires 'error' with no 'close'
 * behind it -- so nothing was queued, the event loop emptied, and node exited
 * cleanly. Task Scheduler read 0 as success, so -RestartCount never fired and
 * the mesh ran all day with sessions:0.
 *
 * Run: node --test client/tests/*.test.js
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const net = require('node:net');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const CLIENT = path.join(__dirname, '..', 'mesh-client.js');

// Long enough to cross several 2000ms reconnect intervals, so "still alive"
// means "kept retrying" rather than "has not got round to dying yet".
const OBSERVE_MS = 7000;

/** A port with nothing on it: bind to 0, read the assigned port, release it. */
function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

/**
 * Spawn the client against a dead endpoint, with HOME redirected at a throwaway
 * directory so the test never touches the operator's real ~/.grip-session-mesh.
 */
function spawnClient(url) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'mesh-client-test-'));
  const env = { ...process.env, HOME: home, USERPROFILE: home };
  const child = spawn(process.execPath, [CLIENT, 'cold-start-probe', url], {
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (d) => { stdout += d; });
  child.stderr.on('data', (d) => { stderr += d; });
  const exited = new Promise((resolve) => child.on('exit', (code) => resolve(code)));
  return {
    child,
    home,
    exited,
    get stdout() { return stdout; },
    get stderr() { return stderr; },
  };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test('client survives a bus that is not listening yet', async (t) => {
  const port = await freePort();
  const c = spawnClient(`ws://127.0.0.1:${port}`);
  t.after(() => { try { c.child.kill(); } catch {} fs.rmSync(c.home, { recursive: true, force: true }); });

  const outcome = await Promise.race([c.exited, sleep(OBSERVE_MS).then(() => 'alive')]);

  assert.equal(
    outcome,
    'alive',
    `client exited (code=${outcome}) instead of retrying. A refused connection fires ` +
    `'error' with no 'close'; if only 'close' re-arms the reconnect, the event loop ` +
    `empties and node exits 0 -- which Task Scheduler reads as success, so the ` +
    `keep-alive never fires. stderr: ${c.stderr.trim()}`,
  );

  // Alive is necessary but not sufficient: it must actually be RETRYING, not
  // parked on a handle doing nothing.
  const attempts = c.stderr.split('\n').filter((l) => l.includes('ws error')).length;
  assert.ok(attempts >= 2, `expected repeated connect attempts, saw ${attempts}`);
});

test('retrying does not fan out into parallel connect chains', async (t) => {
  const port = await freePort();
  const c = spawnClient(`ws://127.0.0.1:${port}`);
  t.after(() => { try { c.child.kill(); } catch {} fs.rmSync(c.home, { recursive: true, force: true }); });

  await Promise.race([c.exited, sleep(OBSERVE_MS)]);

  // 'connecting' is logged once per PROCESS, at module scope. Every retry after
  // that goes through scheduleReconnect(), which holds a single pending timer
  // and ignores events from a superseded socket. If 'error' and 'close' both
  // scheduled, one client would multiply into several chains hammering the bus.
  const started = c.stdout.split('\n').filter((l) => l.includes('connecting')).length;
  assert.equal(started, 1, `expected a single connect chain, saw ${started} (stdout: ${c.stdout.trim()})`);
});

test('a synchronous throw in connect() does not kill the daemon', async (t) => {
  // `new WebSocket(url)` raises on a malformed URL. Unguarded, that exception
  // escapes the reconnect timer and node exits 1.
  //
  // Exit 1 is NOT the silent-success failure the first test pins -- Task
  // Scheduler sees a failure and -RestartCount does fire. A review concern
  // calling this a deadlock was tested and refuted; it is a crash. It is still
  // guarded, because a crash-restart loop gives up after -RestartCount attempts
  // and an in-process retry does not.
  const c = spawnClient('not-a-url');
  t.after(() => { try { c.child.kill(); } catch {} fs.rmSync(c.home, { recursive: true, force: true }); });

  const outcome = await Promise.race([c.exited, sleep(5000).then(() => 'alive')]);

  assert.equal(
    outcome,
    'alive',
    `client exited (code=${outcome}) on a malformed URL instead of logging and ` +
    `retrying. connect() must be called through connectGuarded(). stderr: ${c.stderr.trim()}`,
  );

  const thrown = c.stderr.split('\n').filter((l) => l.includes('connect threw')).length;
  assert.ok(thrown >= 2, `expected repeated guarded retries, saw ${thrown}`);
});
