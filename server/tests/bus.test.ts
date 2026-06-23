import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { SessionRegistry } from '../src/session.js';
import { RateLimiter } from '../src/ratelimit.js';
import { deliver } from '../src/bus.js';
import type { WebSocket } from 'ws';
import type { MeshMessage, AuthedSession } from '../src/types.js';

function msg(to: string, overrides: Partial<MeshMessage> = {}): MeshMessage {
  return { id: 'm1', from: 'sender', to, kind: 'message', body: 'hello', ts: 'now', ...overrides };
}

function recordingSocket() {
  const sent: string[] = [];
  const socket = { send: (s: string) => sent.push(s) } as unknown as WebSocket;
  return { socket, sent };
}

function namedSession(id: string, name: string): AuthedSession {
  return { id, name, socket: {} as unknown as WebSocket, connectedAt: 'now', authenticated: true };
}

let tmpDir: string;
const prevMeshDir = process.env.GRIP_MESH_DIR;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mesh-bus-'));
  process.env.GRIP_MESH_DIR = tmpDir;
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
  if (prevMeshDir === undefined) delete process.env.GRIP_MESH_DIR;
  else process.env.GRIP_MESH_DIR = prevMeshDir;
});

describe('deliver — relay bridging', () => {
  test('unroutable direct is pushed to relays when locally originated', () => {
    const reg = new SessionRegistry();
    const lim = new RateLimiter();
    const relay = recordingSocket();
    reg.registerRelay(relay.socket);

    const result = deliver(msg('remote-peer'), reg, lim, 'local-sender', false);

    assert.equal(result, 'relayed');
    assert.equal(relay.sent.length, 1);
    assert.equal(JSON.parse(relay.sent[0]).to, 'remote-peer');
  });

  test('unroutable direct that arrived via a relay is NOT re-relayed (loop prevention)', () => {
    const reg = new SessionRegistry();
    const lim = new RateLimiter();
    const relay = recordingSocket();
    reg.registerRelay(relay.socket);

    const result = deliver(msg('remote-peer'), reg, lim, 'relay-id', true);

    assert.equal(result, 'recipient_not_found');
    assert.equal(relay.sent.length, 0);
  });

  test('unroutable direct with no relays returns recipient_not_found', () => {
    const reg = new SessionRegistry();
    const lim = new RateLimiter();
    const result = deliver(msg('nobody'), reg, lim, 'local-sender', false);
    assert.equal(result, 'recipient_not_found');
  });

  test('local direct delivery writes inbound and does not touch relays', () => {
    const reg = new SessionRegistry();
    const lim = new RateLimiter();
    const relay = recordingSocket();
    reg.registerRelay(relay.socket);
    reg.register(namedSession('sess-1', 'lauries'));

    const result = deliver(msg('lauries'), reg, lim, 'local-sender', false);

    assert.equal(result, 'ok');
    assert.equal(relay.sent.length, 0);
    const inbound = fs.readFileSync(path.join(tmpDir, 'inbound', 'sess-1.jsonl'), 'utf8').trim();
    assert.equal(JSON.parse(inbound).to, 'lauries');
  });

  test('broadcast is pushed to relays when locally originated', () => {
    const reg = new SessionRegistry();
    const lim = new RateLimiter();
    const relay = recordingSocket();
    reg.registerRelay(relay.socket);

    const result = deliver(msg('broadcast', { kind: 'broadcast' }), reg, lim, 'local-sender', false);

    assert.equal(result, 'ok');
    assert.equal(relay.sent.length, 1);
  });

  test('a relayed broadcast reaches local sessions but is not echoed back to relays', () => {
    const reg = new SessionRegistry();
    const lim = new RateLimiter();
    const relay = recordingSocket();
    reg.registerRelay(relay.socket);
    reg.register(namedSession('sess-1', 'alice'));

    const result = deliver(msg('broadcast', { kind: 'broadcast' }), reg, lim, 'relay-id', true);

    assert.equal(result, 'ok');
    assert.equal(relay.sent.length, 0); // not echoed back to the relay it came from
    const inbound = fs.readFileSync(path.join(tmpDir, 'inbound', 'sess-1.jsonl'), 'utf8').trim();
    assert.equal(JSON.parse(inbound).kind, 'broadcast');
  });
});
