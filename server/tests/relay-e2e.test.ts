import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { WebSocket } from 'ws';

// End-to-end against the REAL compiled bus (dist/index.js), spawned as a
// subprocess on an isolated port + GRIP_MESH_DIR. This is the regression anchor
// for the relay arc: the unit suite tests the pieces, this proves the live
// handshake the previous code got wrong (relay → 4401, no WS push).
const PORT = 19474;
const TOKEN = 'e2e-token-0000000000000000000000000000000000000000';

function distIndex(): string {
  // dist-test/tests/relay-e2e.test.js → ../../dist/index.js
  return path.resolve(__dirname, '..', '..', 'dist', 'index.js');
}

function waitHealth(port: number): Promise<void> {
  return new Promise((resolve, reject) => {
    let tries = 0;
    const tick = (): void => {
      const req = http.get(`http://127.0.0.1:${port}/health`, (res) => {
        res.resume();
        resolve();
      });
      req.on('error', () => {
        if (++tries > 80) return reject(new Error('server did not come up'));
        setTimeout(tick, 100);
      });
    };
    tick();
  });
}

function connect(url: string): Promise<WebSocket> {
  const ws = new WebSocket(url);
  return new Promise((resolve, reject) => {
    ws.once('open', () => resolve(ws));
    ws.once('error', reject);
  });
}

function recv(ws: WebSocket): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('recv timeout')), 5000);
    ws.once('message', (data: Buffer) => {
      clearTimeout(t);
      resolve(JSON.parse(data.toString()));
    });
  });
}

test('relay e2e: relay authenticates (no 4401) and the bus pushes unroutable + broadcast to it', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mesh-e2e-'));
  fs.writeFileSync(path.join(tmp, 'token'), TOKEN);
  const server = spawn('node', [distIndex()], {
    env: { ...process.env, PORT: String(PORT), GRIP_MESH_DIR: tmp },
    stdio: 'ignore',
  });
  try {
    await waitHealth(PORT);
    const url = `ws://127.0.0.1:${PORT}`;

    // 1. relay handshake — the exact envelope mesh_relay.py sends. Pre-fix this
    //    was closed with 4401 (header auth, no name).
    const relay = await connect(url);
    relay.send(JSON.stringify({ authorization: `Bearer ${TOKEN}`, relay: true }));
    const ack = await recv(relay);
    assert.equal(ack.ok, true);
    assert.equal(ack.relay, true);

    // 2. a normal named session still registers
    const alice = await connect(url);
    alice.send(JSON.stringify({ authorization: `Bearer ${TOKEN}`, name: 'alice' }));
    const aack = await recv(alice);
    assert.equal(aack.ok, true);

    // 3. alice → 'bob' (not on this bus) is pushed to the relay over its WS.
    //    Pre-fix the bus never pushed over the WS, so the relay saw nothing.
    alice.send(JSON.stringify({ id: 'e1', from: 'alice', to: 'bob', kind: 'message', body: 'hi', ts: 'now' }));
    const pushed = await recv(relay);
    assert.equal(pushed.to, 'bob');
    assert.equal(pushed.body, 'hi');

    // 4. a broadcast is pushed to the relay too
    alice.send(JSON.stringify({ id: 'e2', from: 'alice', to: 'broadcast', kind: 'broadcast', body: 'all', ts: 'now' }));
    const bpush = await recv(relay);
    assert.equal(bpush.to, 'broadcast');

    relay.close();
    alice.close();
  } finally {
    server.kill('SIGTERM');
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
