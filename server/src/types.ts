import type { WebSocket } from 'ws';

export interface MeshMessage {
  id: string;
  from: string;
  to: string;
  kind: 'message' | 'broadcast' | 'pair_steer' | 'pair_intercept' | 'pair_intercept_urgent';
  body: string;
  ts: string;
}

export interface Session {
  id: string;
  name: string;
  socket: WebSocket;
  connectedAt: string;
}

export interface AuthedSession extends Session {
  authenticated: boolean;
}

/**
 * First-message auth envelope a connecting client sends. A normal session
 * supplies a `name`; a relay (Layer 2) supplies `relay: true` and no name.
 */
export interface AuthEnvelope {
  authorization?: string;
  name?: string;
  relay?: boolean;
}

/** Result of classifying an AuthEnvelope against the expected bearer token. */
export type AuthDecision =
  | { kind: 'session'; name: string }
  | { kind: 'relay' }
  | { kind: 'reject' };
