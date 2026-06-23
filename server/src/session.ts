import type { WebSocket } from 'ws';
import type { AuthedSession } from './types.js';

export class SessionRegistry {
  private byId = new Map<string, AuthedSession>();
  private byName = new Map<string, AuthedSession>();
  // Relays (Layer 2 bridges) are tracked separately from named sessions so
  // they never appear in name routing, broadcast recipients, or count().
  private relays = new Set<WebSocket>();

  register(session: AuthedSession): void {
    this.byId.set(session.id, session);
    this.byName.set(session.name, session);
  }

  deregister(id: string): void {
    const session = this.byId.get(id);
    if (!session) return;
    this.byId.delete(id);
    this.byName.delete(session.name);
  }

  findById(id: string): AuthedSession | undefined {
    return this.byId.get(id);
  }

  findByName(name: string): AuthedSession | undefined {
    return this.byName.get(name);
  }

  list(): AuthedSession[] {
    return Array.from(this.byId.values());
  }

  count(): number {
    return this.byId.size;
  }

  registerRelay(socket: WebSocket): void {
    this.relays.add(socket);
  }

  deregisterRelay(socket: WebSocket): void {
    this.relays.delete(socket);
  }

  listRelays(): WebSocket[] {
    return Array.from(this.relays);
  }
}
