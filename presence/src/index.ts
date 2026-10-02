import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { getDb, openDb } from "./db.js";
import { registerSession, heartbeat, deregister, listSessionsMarked } from "./registry.js";
import { acquireLock, releaseLock, lockStatus } from "./locking.js";
import { broadcastToLive, readInbox } from "./inbox.js";
import { currentLivenessContext } from "./liveness.js";

const db = process.env.GRIP_PRESENCE_DB ? openDb(process.env.GRIP_PRESENCE_DB) : getDb();

const TOOLS = [
  {
    name: "session_register",
    description: "Register a session",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string" }, name: { type: "string" },
        machine: { type: "string" }, role: { type: "string" }
      },
      required: ["id", "name"]
    }
  },
  {
    name: "session_heartbeat",
    description: "Update last_heartbeat for a session",
    inputSchema: { type: "object", properties: { id: { type: "string" } }, required: ["id"] }
  },
  {
    name: "session_deregister",
    description: "Remove a session",
    inputSchema: { type: "object", properties: { id: { type: "string" } }, required: ["id"] }
  },
  {
    name: "session_list",
    description: "List every registered session, including ones that have stopped. Each row carries " +
      "`live`: true while its Claude Code process is running, or, for a session with no Claude Code " +
      "record, while it has beaten within the last 180 seconds",
    inputSchema: { type: "object", properties: {} }
  },
  {
    name: "session_broadcast",
    description: "Queue a message in the inbox of every live session except the sender. Returns " +
      "`sent_to` (sessions queued) and `skipped_not_live` (rows whose session is not running) separately",
    inputSchema: {
      type: "object",
      properties: {
        from_name: { type: "string" }, body: { type: "string" }, kind: { type: "string" },
        from_id: { type: "string", description: "The sender's own session id, so it is left out" }
      },
      required: ["from_name", "body", "kind"]
    }
  },
  {
    name: "lock_acquire",
    description: "Claim an advisory lock",
    inputSchema: {
      type: "object",
      properties: {
        resource: { type: "string" }, holder_id: { type: "string" },
        holder_name: { type: "string" }, ttl_minutes: { type: "number" }
      },
      required: ["resource", "holder_id", "holder_name"]
    }
  },
  {
    name: "lock_release",
    description: "Release an advisory lock",
    inputSchema: {
      type: "object",
      properties: { resource: { type: "string" }, holder_id: { type: "string" } },
      required: ["resource", "holder_id"]
    }
  },
  {
    name: "lock_status",
    description: "List all active (non-expired) locks",
    inputSchema: { type: "object", properties: {} }
  },
  {
    name: "inbox_read",
    description: "Read pending inbox messages for a session",
    inputSchema: {
      type: "object",
      properties: {
        recipient_id: { type: "string" }, mark_delivered: { type: "boolean" }
      },
      required: ["recipient_id"]
    }
  }
];

const server = new Server(
  { name: "grip-session-mesh-presence", version: "1.0.0" },
  { capabilities: { tools: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args = {} } = request.params;
  const a = args as Record<string, unknown>;

  const result = (() => {
    switch (name) {
      case "session_register":
        registerSession(db, { id: a.id as string, name: a.name as string, machine: a.machine as string | undefined, role: a.role as string | undefined });
        return { ok: true };
      case "session_heartbeat":
        heartbeat(db, a.id as string);
        return { ok: true };
      case "session_deregister":
        deregister(db, a.id as string);
        return { ok: true };
      case "session_list":
        return listSessionsMarked(db, currentLivenessContext());
      case "session_broadcast":
        return broadcastToLive(db, {
          fromName: a.from_name as string, body: a.body as string, kind: a.kind as string,
          senderId: typeof a.from_id === "string" ? a.from_id : undefined,
        }, currentLivenessContext());
      case "lock_acquire":
        return acquireLock(db, a.resource as string, a.holder_id as string, a.holder_name as string, a.ttl_minutes as number | undefined);
      case "lock_release":
        return releaseLock(db, a.resource as string, a.holder_id as string);
      case "lock_status":
        return lockStatus(db);
      case "inbox_read":
        return readInbox(db, a.recipient_id as string, a.mark_delivered as boolean | undefined);
      default:
        throw new Error(`Unknown tool: ${name}`);
    }
  })();

  return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
});

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch(console.error);
