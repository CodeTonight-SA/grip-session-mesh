# Architecture

## Three Layers

### Layer 1: Local WebSocket Bus

**File:** `server/src/`  
**Port:** 9474 (configurable)  
**Protocol:** WebSocket + JSON frames  

Each CC session connects to a local WebSocket server. The `Monitor` tool watches
`~/.grip-session-mesh/inbound/<session-id>.jsonl` for messages and delivers them
as prompts with zero token overhead when idle.

```
CC Session A ──WS──► mesh-server :9474 ◄──WS── CC Session B
                          │
                     writes to:
                ~/.grip-session-mesh/inbound/<id>.jsonl
                          │
                    Monitor sees new line
                          │
                    delivers as prompt
```

**Message envelope:**
```json
{
  "id": "uuid-v4",
  "from": "session-name",
  "to": "session-name | broadcast",
  "kind": "message | broadcast | pair_steer | pair_intercept | pair_intercept_urgent",
  "body": "string",
  "ts": "ISO-8601"
}
```

**Constraints (matching yilunzhang's reference implementation):**
- Direct message: 10 MB max
- Broadcast: 256 KB max
- Broadcast rate: 60/minute per session
- Auth: bearer token at `~/.grip-session-mesh/token` (0600)
- Bind: `127.0.0.1` only

### Layer 2: Tailscale Relay

**File:** `relay/mesh_relay.py`  
**Transport:** TCP over Tailscale (port 9475)  

Bridges two Layer 1 buses across machines. The relay on Machine A connects to
Machine B's relay (`:9475`), tunnels WebSocket traffic between the two buses.
Sessions on both machines appear in `/mesh list`.

```
Machine A :9474 ──► relay-A :9475 ──Tailscale──► relay-B :9475 ──► Machine B :9474
```

**Peer discovery:** peers are configured via `/mesh remote add <tailscale_ip>`.
Known IPs stored in `~/.grip-session-mesh/peers.json`.

**Failover:** if Tailscale relay drops, the relay auto-reconnects with exponential
backoff (1s, 2s, 4s, 8s, max 60s).

### Layer 3: Presence MCP Server

**File:** `presence/src/`  
**Protocol:** MCP (Model Context Protocol) over stdio  
**Storage:** SQLite at `~/.grip-session-mesh/presence.db`  

Exposes 9 MCP tools for coordination:

| Tool | Description |
|------|-------------|
| `session_register` | Register this session (called on `/mesh connect`) |
| `session_heartbeat` | Update liveness timestamp (called every 30s) |
| `session_deregister` | Leave the mesh (called on `/mesh disconnect`) |
| `session_list` | List all sessions with last-seen timestamps |
| `session_broadcast` | Write a message to all sessions' inboxes |
| `lock_acquire` | Claim an advisory lock on a resource |
| `lock_release` | Release a held lock |
| `lock_status` | Check all active locks |
| `inbox_read` | Read pending broadcast messages |

**Schema:**
```sql
CREATE TABLE sessions (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    machine TEXT,
    role TEXT,  -- 'grip' | 'guard' | NULL
    pair_partner TEXT,
    registered_at TEXT,
    last_heartbeat TEXT
);

CREATE TABLE locks (
    resource TEXT PRIMARY KEY,
    holder_id TEXT NOT NULL,
    holder_name TEXT NOT NULL,
    acquired_at TEXT NOT NULL,
    expires_at TEXT NOT NULL
);

CREATE TABLE inbox (
    id TEXT PRIMARY KEY,
    recipient_id TEXT NOT NULL,
    from_name TEXT NOT NULL,
    body TEXT NOT NULL,
    kind TEXT NOT NULL,
    created_at TEXT NOT NULL,
    delivered INTEGER DEFAULT 0
);
```

## Data Directory

All runtime state lives in `~/.grip-session-mesh/`:

```
~/.grip-session-mesh/
├── token              # Bearer token (0600)
├── peers.json         # Configured Tailscale peer IPs
├── presence.db        # SQLite — sessions, locks, inbox
├── log.jsonl          # Message delivery audit log
└── inbound/
    └── <session-id>.jsonl   # Per-session message queue
```

## Security Model

| Threat | Mitigation |
|--------|-----------|
| Unauthorized local connection | Bearer token (0600), bus on 127.0.0.1 |
| Cross-machine impersonation | Tailscale mutual device cert (no extra auth needed) |
| Destructive message injection | Regex safeguard in monitor script; `/mesh approve` required |
| Lock starvation | 10-minute TTL on all locks |
| Log tampering | JSONL append-only; process owns the file |

## Token Budget

- Layer 1 idle: **0 tokens** (Monitor watches a file; no CC call until message arrives)
- Layer 1 message delivery: ~50-200 tokens per message (the message itself)
- Layer 3 heartbeat: **0 tokens** (background process, not CC session)
- `/mesh list`: ~100 tokens (one MCP call)
- `/mesh lock`: ~50 tokens (one MCP call)

Compare to grip-pair (removed 2026-05-06): **~42 tool definitions loaded always**, regardless
of whether pair mode was active. grip-session-mesh loads **0 tools at idle**.
