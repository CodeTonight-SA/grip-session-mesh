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
const crypto = require('node:crypto');
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
 * A WebSocket server in ~30 lines of node:net, so these tests stay zero-dependency
 * exactly like the client. It completes the RFC 6455 handshake and counts every
 * TCP connection it accepts.
 *
 * Counting SERVER-SIDE is the point. Counting log lines can only ever infer how
 * many connect chains are running; the accept count measures it. A review
 * council raised precisely this -- that a log-line count cannot tell one timer
 * firing repeatedly from two timers firing once each.
 *
 * mode 'accept' completes the handshake and holds the connection open.
 * mode 'destroy' accepts and immediately drops, to drive the retry path.
 */
function wsServer(mode) {
  const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
  let accepted = 0;
  const srv = net.createServer((sock) => {
    accepted += 1;
    if (mode === 'destroy') { sock.destroy(); return; }
    sock.once('data', (buf) => {
      const req = buf.toString('utf8');
      // No backslash escapes anywhere in here on purpose: CRLF is built from
      // char codes so the handshake cannot be broken by a tooling layer that
      // rewrites escape sequences.
      const m = /Sec-WebSocket-Key:[ ]*(.+)/i.exec(req);
      if (!m) { sock.destroy(); return; }
      const key = m[1].trim();
      const accept = crypto.createHash('sha1').update(key + GUID).digest('base64');
      const CRLF = String.fromCharCode(13, 10);
      sock.write([
        'HTTP/1.1 101 Switching Protocols',
        'Upgrade: websocket',
        'Connection: Upgrade',
        'Sec-WebSocket-Accept: ' + accept,
        '',
        '',
      ].join(CRLF));
      // Deliberately silent after this. The client sends its auth frame and
      // waits; that is enough to prove the connection came up and stays up.
    });
    sock.on('error', () => {});
  });
  return {
    listen: (port) => new Promise((res) => srv.listen(port, '127.0.0.1', res)),
    close: () => new Promise((res) => srv.close(() => res())),
    get accepted() { return accepted; },
  };
}

/**
 * Spawn the client against a dead endpoint, with HOME redirected at a throwaway
 * directory so the test never touches the operator's real ~/.grip-session-mesh.
 */
function spawnClient(url, opts = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'mesh-client-test-'));
  // The client reads ~/.grip-session-mesh/token on every open. Without one the
  // tests would exercise the missing-token path instead of the path they claim
  // to test -- which is how the "stays connected" test first passed for the
  // wrong reason: the client was not staying connected, it was dying.
  if (opts.token !== false) {
    fs.mkdirSync(path.join(home, '.grip-session-mesh'), { recursive: true });
    fs.writeFileSync(path.join(home, '.grip-session-mesh', 'token'), 'test-token');
  }
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
  // Measured at the server, not in the log. With RECONNECT_MS at 2000 a single
  // chain makes about one attempt every 2s; two concurrent chains would roughly
  // double that. The band is deliberately generous at both ends -- this is here
  // to catch a doubling, not to police timer jitter.
  const port = await freePort();
  const srv = wsServer('destroy');
  await srv.listen(port);
  const c = spawnClient(`ws://127.0.0.1:${port}`);
  t.after(async () => {
    try { c.child.kill(); } catch {}
    fs.rmSync(c.home, { recursive: true, force: true });
    await srv.close();
  });

  await Promise.race([c.exited, sleep(OBSERVE_MS)]);

  const expected = Math.floor(OBSERVE_MS / 2000) + 1;   // 7000ms -> 4
  assert.ok(
    srv.accepted >= 2,
    `expected the client to keep retrying, server accepted only ${srv.accepted}`,
  );
  assert.ok(
    srv.accepted <= expected + 1,
    `server accepted ${srv.accepted} connections in ${OBSERVE_MS}ms but a single ` +
    `chain at ${2000}ms should make about ${expected}. More than one reconnect ` +
    `timer is pending, so one client has fanned out into parallel connect chains.`,
  );
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

test('recovers when the bus appears, then stays connected', async (t) => {
  // The production scenario end to end: the client loses the startup race,
  // keeps retrying, and must both RECOVER when the bus finally binds and then
  // STOP reconnecting. The second half is the part worth pinning -- a healthy
  // connection that keeps being torn down and rebuilt is its own outage, and it
  // is what a stale reconnect timer, or a superseded socket's close being acted
  // on, would each produce.
  const port = await freePort();
  const c = spawnClient(`ws://127.0.0.1:${port}`);
  const srv = wsServer('accept');
  t.after(async () => {
    try { c.child.kill(); } catch {}
    fs.rmSync(c.home, { recursive: true, force: true });
    await srv.close();
  });

  await sleep(3000);                       // client is retrying against nothing
  assert.equal(c.child.exitCode, null, 'client died before the bus appeared');

  await srv.listen(port);                  // the bus finally binds
  await sleep(2500);
  const afterConnect = srv.accepted;
  assert.ok(afterConnect >= 1, 'client never reconnected once the server appeared');

  await sleep(4000);                       // two further reconnect intervals
  assert.equal(
    srv.accepted,
    afterConnect,
    `client reconnected ${srv.accepted - afterConnect} more time(s) while already ` +
    `connected. Once a socket is open the pending retry must be cancelled and no ` +
    `superseded socket's close may queue another.`,
  );
});

test('a missing token is a failed attempt, not a fatal one', async (t) => {
  // token() reads the file on EVERY open, inside an event handler. A throw
  // there is an unhandled exception, so an absent or mid-rotation token killed
  // the daemon outright rather than costing it one attempt.
  const port = await freePort();
  const srv = wsServer('accept');
  await srv.listen(port);
  const c = spawnClient(`ws://127.0.0.1:${port}`, { token: false });
  t.after(async () => {
    try { c.child.kill(); } catch {}
    fs.rmSync(c.home, { recursive: true, force: true });
    await srv.close();
  });

  const outcome = await Promise.race([c.exited, sleep(6000).then(() => 'alive')]);
  assert.equal(
    outcome,
    'alive',
    `client exited (code=${outcome}) because the token file was missing. The read ` +
    `must be caught and retried. stderr: ${c.stderr.trim()}`,
  );
  const tried = c.stderr.split(String.fromCharCode(10)).filter((l) => l.includes('cannot read token')).length;
  assert.ok(tried >= 2, `expected repeated attempts while the token is absent, saw ${tried}`);
});
