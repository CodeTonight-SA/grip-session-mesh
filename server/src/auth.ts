import type { AuthEnvelope, AuthDecision } from './types.js';

/**
 * Decide what a first-message auth envelope authorises.
 *
 * The bus authenticates on the first WebSocket message (not an HTTP header).
 * A relay (Layer 2 bridge) supplies `relay: true` and needs no name; a normal
 * session must supply a `name`. Either way the bearer must match exactly.
 *
 * Pure function — exported so the exact 4401 boundary is unit-testable without
 * starting the server.
 */
export function classifyAuth(envelope: AuthEnvelope, expectedBearer: string): AuthDecision {
  if (envelope.authorization !== expectedBearer) return { kind: 'reject' };
  if (envelope.relay === true) return { kind: 'relay' };
  if (!envelope.name) return { kind: 'reject' };
  return { kind: 'session', name: envelope.name };
}
