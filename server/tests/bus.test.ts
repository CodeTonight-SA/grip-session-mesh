import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { SessionRegistry } from '../src/session.js';
import { RateLimiter } from '../src/ratelimit.js';
import { deliver, _resetDedup } from '../src/bus.js';
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
  _resetDedup();
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

  test('a duplicate message id is dropped on the second delivery (relay double-push)', () => {
    const reg = new SessionRegistry();
    const lim = new RateLimiter();
    reg.register(namedSession('sess-1', 'lauries'));
    const m = msg('lauries', { id: 'dup-1' });

    const first = deliver(m, reg, lim, 'relay-id', true);
    const second = deliver(m, reg, lim, 'relay-id', true); // same id, second relay link

    assert.equal(first, 'ok');
    assert.equal(second, 'duplicate');
    const inbound = fs.readFileSync(path.join(tmpDir, 'inbound', 'sess-1.jsonl'), 'utf8')
      .trim().split('\n').filter(Boolean);
    assert.equal(inbound.length, 1); // written exactly once despite two deliveries
  });

  test('distinct ids are both delivered (dedup does not over-match)', () => {
    const reg = new SessionRegistry();
    const lim = new RateLimiter();
    reg.register(namedSession('sess-1', 'lauries'));

    assert.equal(deliver(msg('lauries', { id: 'a' }), reg, lim, 'relay-id', true), 'ok');
    assert.equal(deliver(msg('lauries', { id: 'b' }), reg, lim, 'relay-id', true), 'ok');
    const inbound = fs.readFileSync(path.join(tmpDir, 'inbound', 'sess-1.jsonl'), 'utf8')
      .trim().split('\n').filter(Boolean);
    assert.equal(inbound.length, 2);
  });
});
