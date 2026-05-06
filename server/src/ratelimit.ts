const WINDOW_MS = 60_000;
const MAX_PER_WINDOW = 60;

interface Window {
  count: number;
  windowStart: number;
}

export class RateLimiter {
  private windows = new Map<string, Window>();

  allow(sessionId: string): boolean {
    const now = Date.now();
    const w = this.windows.get(sessionId);

    if (!w || now - w.windowStart >= WINDOW_MS) {
      this.windows.set(sessionId, { count: 1, windowStart: now });
      return true;
    }

    if (w.count >= MAX_PER_WINDOW) return false;
    w.count++;
    return true;
  }

  remove(sessionId: string): void {
    this.windows.delete(sessionId);
  }
}
