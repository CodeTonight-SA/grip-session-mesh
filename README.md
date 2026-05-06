# grip-session-mesh

**The definitive Claude Code pair programming solution.**  
Three layers. Cross-machine. Real-time. Zero token cost at idle.

```
/mesh connect        — join the session mesh
/mesh list           — see every active session (local + remote)
/mesh send hal "ship it"  — message another session directly
/mesh broadcast "stand-up?"  — reach everyone at once
/mesh lock main.py   — advisory lock for collaborative editing
```

---

## What This Solves

Claude Code sessions are isolated by design. When you run multiple sessions
across projects, machines, or with collaborators, you become the message bus.
This repository removes you from that critical path.

**Three layers, one install:**

| Layer | Technology | Scope |
|-------|-----------|-------|
| 1. Local bus | WebSocket + Monitor tool | Same machine, ms latency |
| 2. Remote relay | Tailscale SSH + TCP bridge | Cross-machine, any OS |
| 3. Presence mesh | SQLite MCP server | Advisory locks + broadcast inbox |

## Installation

### As a Claude Code plugin (recommended)

```
/plugin marketplace add https://github.com/CodeTonight-SA/grip-session-mesh
/plugin install grip-session-mesh
```

Commands become `/mesh:connect`, `/mesh:list`, etc.

### As a GRIP skill (for GRIP users)

```bash
cp -r skills/mesh ~/.claude/skills/mesh
```

Commands become `/mesh connect`, `/mesh list`, etc.

### Layer 1: Local bus (required)

```bash
cd server && npm install && npm run build
npm start          # starts on port 9474 by default
```

Or via auto-start in plugin config:
```
/plugin config grip-session-mesh auto_start true
```

### Layer 2: Remote relay (optional, for cross-machine)

```bash
pip install -r relay/requirements.txt
python relay/mesh_relay.py --help
```

Add peers:
```
/mesh remote add 100.83.206.33   # Andre's machine (Tailscale IP)
/mesh remote add 100.104.253.41  # Toopie's machine
```

### Layer 3: Presence MCP server (optional, for locks + broadcast inbox)

```bash
cd presence && npm install && npm run build
```

Add to your `.mcp.json` or Claude Code MCP settings:
```json
{
  "mcpServers": {
    "grip-presence": {
      "command": "node",
      "args": ["presence/dist/index.js"]
    }
  }
}
```

---

## Architecture

```
Machine A (you)                    Machine B (collaborator)
┌──────────────────────────┐       ┌──────────────────────────┐
│ CC Session 1             │       │ CC Session 3             │
│   Monitor ←─ WS :9474   │       │   Monitor ←─ WS :9474   │
│                          │       │                          │
│ CC Session 2             │       │ CC Session 4             │
│   Monitor ←─ WS :9474   │       │   Monitor ←─ WS :9474   │
│                          │       │                          │
│  [Layer 1: local bus]    │       │  [Layer 1: local bus]    │
│  mesh-server :9474        │◄─────►│  mesh-server :9474        │
│                          │TCP/TS  │                          │
│  [Layer 2: relay]        │       │  [Layer 2: relay]        │
│  mesh_relay.py           │       │  mesh_relay.py           │
│                          │       │                          │
│  [Layer 3: presence]     │       │  [Layer 3: presence]     │
│  presence MCP + SQLite   │       │  presence MCP + SQLite   │
└──────────────────────────┘       └──────────────────────────┘
```

Layer 1 uses Claude Code's `Monitor` tool — **zero token cost when no messages arrive**.  
Layer 2 bridges Layer 1 buses across Tailscale (or any TCP-reachable network).  
Layer 3 adds coordination: who's online, advisory locks, shared inbox.

---

## Commands

| Command | Description |
|---------|-------------|
| `/mesh connect [name]` | Join the local bus. Name defaults to project directory. |
| `/mesh list` | List all active sessions (local + Tailscale remotes). |
| `/mesh send <name> <message>` | Direct message a session by name. |
| `/mesh broadcast <message>` | Send to all connected sessions. |
| `/mesh status` | Show own connection status and peer count. |
| `/mesh disconnect` | Leave gracefully. |
| `/mesh remote add <ip>` | Add a Tailscale peer (Layer 2). |
| `/mesh remote list` | List configured remote peers. |
| `/mesh remote remove <ip>` | Remove a peer. |
| `/mesh lock <resource>` | Acquire advisory lock (Layer 3). |
| `/mesh unlock <resource>` | Release advisory lock. |
| `/mesh locks` | Show all active locks. |
| `/mesh inbox` | Read broadcast inbox. |

---

## Pair Programming Mode

`grip-session-mesh` ships with a built-in pair programming protocol:

```
/mesh pair <name>     — invite a session into pair mode
/mesh grip            — take the Grip role (active builder)
/mesh guard           — take the Guard role (navigator/reviewer)
/mesh intercept       — request role swap
/mesh intercept!      — urgent swap (safety concern)
```

Roles and session state are tracked via Layer 3 presence.

---

## Security

- Layer 1 bus: bearer token at `~/.grip-session-mesh/token` (mode 0600), binds 127.0.0.1
- Layer 2 relay: Tailscale network authentication (no extra auth needed within Tailscale)
- Layer 3 presence: SQLite file at `~/.grip-session-mesh/presence.db`, local user only

---

## Inspired by

- [yilunzhang/claude-code-inter-session](https://github.com/yilunzhang/claude-code-inter-session) — Monitor + WebSocket primitive
- [garniergeorges/claude-presence](https://github.com/garniergeorges/claude-presence) — SQLite presence API design
- [GRIP](https://github.com/CodeTonight-SA/GRIP) — the harness this was built for

---

## Contributing

MIT License. PRs welcome.
