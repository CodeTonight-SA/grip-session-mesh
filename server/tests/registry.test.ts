import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { SessionRegistry } from '../src/session.js';
import type { WebSocket } from 'ws';
import type { AuthedSession } from '../src/types.js';

function mockSocket(): WebSocket {
  return {} as unknown as WebSocket;
}

function mockSession(id: string, name: string): AuthedSession {
  return { id, name, socket: mockSocket(), connectedAt: 'now', authenticated: true };
}

describe('SessionRegistry relays', () => {
  test('registerRelay adds; listRelays returns it', () => {
    const r = new SessionRegistry();
    const s = mockSocket();
    r.registerRelay(s);
    assert.equal(r.listRelays().length, 1);
    assert.equal(r.listRelays()[0], s);
  });

  test('deregisterRelay removes the socket', () => {
    const r = new SessionRegistry();
    const s = mockSocket();
    r.registerRelay(s);
    r.deregisterRelay(s);
    assert.equal(r.listRelays().length, 0);
  });

  test('relays never count as named sessions', () => {
    const r = new SessionRegistry();
    r.registerRelay(mockSocket());
    assert.equal(r.count(), 0);
    assert.equal(r.list().length, 0);
  });

  test('a named session and a relay coexist independently', () => {
    const r = new SessionRegistry();
    r.register(mockSession('id1', 'lauries'));
    r.registerRelay(mockSocket());
    assert.equal(r.count(), 1);             // named sessions only
    assert.equal(r.listRelays().length, 1); // relays tracked separately
    assert.ok(r.findByName('lauries'));
  });

  test('the same relay socket registered twice is deduped', () => {
    const r = new SessionRegistry();
    const s = mockSocket();
    r.registerRelay(s);
    r.registerRelay(s);
    assert.equal(r.listRelays().length, 1);
  });
});
