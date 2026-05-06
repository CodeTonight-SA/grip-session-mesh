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
