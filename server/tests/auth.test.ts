import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { classifyAuth } from '../src/auth.js';

const BEARER = 'Bearer test-token-123';

describe('classifyAuth', () => {
  test('valid named session is accepted', () => {
    const d = classifyAuth({ authorization: BEARER, name: 'lauries' }, BEARER);
    assert.deepEqual(d, { kind: 'session', name: 'lauries' });
  });

  test('relay envelope is accepted without a name', () => {
    const d = classifyAuth({ authorization: BEARER, relay: true }, BEARER);
    assert.deepEqual(d, { kind: 'relay' });
  });

  test('wrong token is rejected even with relay flag (relay does not bypass auth)', () => {
    const d = classifyAuth({ authorization: 'Bearer wrong', relay: true }, BEARER);
    assert.deepEqual(d, { kind: 'reject' });
  });

  test('named session with wrong token is rejected', () => {
    const d = classifyAuth({ authorization: 'Bearer wrong', name: 'x' }, BEARER);
    assert.deepEqual(d, { kind: 'reject' });
  });

  test('correct token but no name and no relay flag is rejected', () => {
    // This is exactly the legacy header-only relay shape that produced 4401.
    const d = classifyAuth({ authorization: BEARER }, BEARER);
    assert.deepEqual(d, { kind: 'reject' });
  });

  test('relay:false with no name is rejected', () => {
    const d = classifyAuth({ authorization: BEARER, relay: false }, BEARER);
    assert.deepEqual(d, { kind: 'reject' });
  });
});
