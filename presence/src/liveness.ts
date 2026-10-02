// Which session rows belong to a session that is actually running.
//
// A heartbeat alone cannot answer this. Nothing beats on a timer: GRIP's hook
// refreshes last_heartbeat only on a tool call, so a session idle at its prompt
// keeps a stale heartbeat for as long as its operator is away, and a heartbeat
// window would drop it from every broadcast. Claude Code itself keeps one record
// per running process, <config dir>/sessions/<pid>.json, naming the sessionId
// that process is serving now, and removes it when the process exits. So:
//
//   - a row whose session has a Claude Code record is live while any of those
//     processes is running, however old its heartbeat;
//   - a row with no record (another harness, another machine, an id that /clear
//     has replaced) is live only if it beat within HEARTBEAT_WINDOW_MS.
import { readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Session } from "./registry.js";

// Three missed beats of a session that is working; GRIP's fleet-quit measured
// live sessions beating every 30-60 s and chose the same window.
export const HEARTBEAT_WINDOW_MS = 180_000;

export interface LivenessContext {
  pidsBySession: Map<string, number[]>;
  nowMs: number;
  windowMs: number;
  alive: (pid: number) => boolean;
}

export function claudeSessionsDir(env: NodeJS.ProcessEnv = process.env): string {
  return join(env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude"), "sessions");
}

// sessionId -> pids of the Claude Code processes whose record names it.
export function readClaudeSessionPids(dir: string): Map<string, number[]> {
  const index = new Map<string, number[]>();
  let names: string[] = [];
  try {
    names = readdirSync(dir).filter((name) => name.endsWith(".json"));
  } catch {
    return index; // no Claude Code on this machine, or another config dir
  }
  for (const name of names) {
    const record = readRecord(join(dir, name));
    if (record) index.set(record.sessionId, [...(index.get(record.sessionId) ?? []), record.pid]);
  }
  return index;
}

function readRecord(path: string): { sessionId: string; pid: number } | null {
  try {
    const record = JSON.parse(readFileSync(path, "utf8"));
    const valid = typeof record?.sessionId === "string" && Number.isInteger(record?.pid);
    return valid ? { sessionId: record.sessionId, pid: record.pid } : null;
  } catch {
    return null; // a record caught mid-write says nothing either way
  }
}

// Signal 0 checks existence on every platform Node supports. EPERM means the
// process exists but belongs to someone else, which still makes it running.
export function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

export function currentLivenessContext(): LivenessContext {
  return {
    pidsBySession: readClaudeSessionPids(claudeSessionsDir()),
    nowMs: Date.now(),
    windowMs: HEARTBEAT_WINDOW_MS,
    alive: pidAlive,
  };
}

export function isLive(session: Session, ctx: LivenessContext): boolean {
  const pids = ctx.pidsBySession.get(session.id.replace(/^cc-/, ""));
  if (pids) return pids.some(ctx.alive);
  const beat = Date.parse(session.last_heartbeat);
  return Number.isFinite(beat) && ctx.nowMs - beat <= ctx.windowMs;
}
