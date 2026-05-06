#!/usr/bin/env bash
: <<'MARKDOWN'
---
name: mesh
description: Three-layer Claude Code session mesh — local WebSocket bus, Tailscale cross-machine relay, and presence/locking. Enables real-time inter-session messaging and pair programming across collaborator machines.
status: Active
version: 1.0.0
effort: low
triggers:
  - "/mesh"
  - "mesh connect"
  - "mesh send"
  - "mesh broadcast"
  - "mesh pair"
  - "start pair programming"
  - "connect sessions"
see_also:
  - pair-mode
  - grip-anywhere
  - grip-channel
---

# /mesh — Session Mesh

Connect Claude Code sessions across machines. Real-time. Zero token cost at idle.

## Commands

| Command | Description |
|---------|-------------|
| `/mesh connect [name]` | Join the session bus. Name defaults to `git rev-parse --show-toplevel` basename. |
| `/mesh list` | List all sessions — local + Tailscale remotes. |
| `/mesh send <name> <message>` | Direct message a session by name. |
| `/mesh broadcast <message>` | Send to every connected session. |
| `/mesh status` | Show own connection, name, peer count, roles. |
| `/mesh disconnect` | Leave gracefully. Notifies peers. |
| `/mesh remote add <tailscale_ip>` | Bridge to a remote machine's bus (Layer 2). |
| `/mesh remote list` | List configured Tailscale peer IPs. |
| `/mesh remote remove <ip>` | Remove a peer bridge. |
| `/mesh lock <resource>` | Acquire advisory lock for a file/resource (Layer 3). |
| `/mesh unlock <resource>` | Release advisory lock. |
| `/mesh locks` | Show all active locks and their holders. |
| `/mesh inbox` | Read broadcast inbox (messages sent while offline). |
| `/mesh pair <name>` | Invite a session into pair mode. |
| `/mesh grip` | Take the Grip role (active builder). |
| `/mesh guard` | Take the Guard role (navigator/reviewer). |
| `/mesh intercept` | Request a role swap. |
| `/mesh intercept!` | Urgent role swap — safety concern. Blocks the Grip. |

## Protocol

### Step 1: Start the bus (once per machine)

```bash
# From the grip-session-mesh directory
npm run start --prefix server      # Layer 1: local WebSocket bus on :9474
```

Or if auto_start is configured:
```
/plugin config grip-session-mesh auto_start true
```

### Step 2: Connect this session

```
/mesh connect [optional-name]
```

This registers the current session and starts a `Monitor` tool watching
`~/.grip-session-mesh/inbound/<session-id>.jsonl` for incoming messages.
Incoming messages arrive as prompts and are acted on as instructions.

### Step 3: Discover peers

```
/mesh list
```

Shows: session name, machine, role (if in pair mode), last seen.

### Step 4: Send messages

```
/mesh send hal "what's your status on the auth refactor?"
/mesh broadcast "pushing to main in 5 — anyone blocking?"
```

Direct messages go to one session. Broadcasts go to all.

### Step 5: Cross-machine (Layer 2)

Add a Tailscale peer to bridge the local buses:

```
/mesh remote add 100.83.206.33   # Andre's machine
/mesh remote add 100.104.253.41  # Toopie's machine
```

The relay (`relay/mesh_relay.py`) opens a TCP bridge between the two WebSocket
buses over the Tailscale network. Sessions on both machines appear in `/mesh list`.

Known GRIP collaborator IPs (from operational context):
- Andre: `100.83.206.33`
- Toopie: `100.104.253.41`
- VPS: `100.80.130.33`

### Step 6: Locks (Layer 3, requires presence MCP)

```
/mesh lock src/auth/middleware.py
# ... make your edits ...
/mesh unlock src/auth/middleware.py
```

Advisory only — other sessions are warned, not blocked. Locks expire after 10 minutes.

## Pair Programming Protocol

Two developers, two sessions, one codebase.

```
# Developer A (Grip — active builder)
/mesh connect hal
/mesh pair andre
/mesh grip

# Developer B (Guard — navigator/reviewer)
/mesh connect andre
# ... accepts the pair invitation ...
/mesh guard
```

### Roles

| Role | Responsibilities |
|------|-----------------|
| **Grip** | Writes code, runs tools, makes commits |
| **Guard** | Reviews, steers, raises concerns via `/mesh steer` |

### Role swap

```
/mesh intercept    # polite request — Grip decides when to hand over
/mesh intercept!   # urgent — immediately pauses Grip's current tool call
```

## Inbound Message Handling

When a message arrives from another session, the Monitor tool fires and delivers
it as a prompt. Messages from the mesh are prefixed:

```
[mesh:hal] what's your current branch?
[mesh:broadcast] stand-up in 5 minutes
[mesh:pair:andre] INTERCEPT — please pause before that delete
```

By default, mesh messages are acted on as instructions. To review first:
```
/plugin config grip-session-mesh require_confirmation true
```

Safeguard: messages containing destructive keywords (`rm -rf`, `DROP TABLE`,
`git push --force`) always require explicit `/mesh approve` before execution.

## Configuration

| Key | Default | Description |
|-----|---------|-------------|
| `port` | 9474 | WebSocket bus port |
| `auto_start` | false | Start bus on plugin load |
| `idle_shutdown_minutes` | 30 | Shutdown when no sessions connected |
| `presence_enabled` | true | Enable Layer 3 MCP |
| `require_confirmation` | false | Review all mesh messages before acting |
| `pair_role` | null | Current pair role (grip/guard) |

## Security

- Bus token stored at `~/.grip-session-mesh/token` (mode 0600)
- Bus binds `127.0.0.1` by default — not exposed to the network
- Layer 2 relay uses Tailscale auth (mutual device certs)
- Destructive commands require explicit `/mesh approve`
- All messages logged to `~/.grip-session-mesh/log.jsonl`

## Troubleshooting

```bash
# Is the bus running?
curl -s http://127.0.0.1:9474/health | jq .

# Check relay status
python relay/mesh_relay.py status

# Check presence DB
sqlite3 ~/.grip-session-mesh/presence.db "SELECT * FROM sessions;"

# Tail the message log
tail -f ~/.grip-session-mesh/log.jsonl | jq .
```
MARKDOWN

set -euo pipefail

MESH_DIR="${HOME}/.grip-session-mesh"
SKILL_FILE="${BASH_SOURCE[0]}"
PASS=0
FAIL=0
CHECKS=""

check() {
    local name="$1"
    local result="$2"
    if [ "$result" = "ok" ]; then
        PASS=$((PASS + 1))
        CHECKS="${CHECKS}  [PASS] ${name}\n"
    else
        FAIL=$((FAIL + 1))
        CHECKS="${CHECKS}  [FAIL] ${name}: ${result}\n"
    fi
}

# --- Check 1: Self-hash ---
SELF_HASH=$(shasum -a 256 "$SKILL_FILE" | cut -d' ' -f1)
if [ -n "$SELF_HASH" ] && [ ${#SELF_HASH} -eq 64 ]; then
    check "self-hash" "ok"
else
    check "self-hash" "could not compute"
fi

# --- Check 2: Polyglot ---
HAS_SHEBANG=$(head -1 "$SKILL_FILE")
if echo "$HAS_SHEBANG" | grep -q '#!/usr/bin/env bash'; then
    check "polyglot (bash+markdown)" "ok"
else
    check "polyglot" "missing shebang"
fi

# --- Check 3: YAML frontmatter ---
DELIMS=$(grep -c '^---$' "$SKILL_FILE" 2>/dev/null || echo 0)
if [ "$DELIMS" -ge 2 ]; then
    check "YAML frontmatter" "ok"
else
    check "YAML frontmatter" "missing (found ${DELIMS} delimiters)"
fi

# --- Check 4: Mesh data dir ---
if [ -d "$MESH_DIR" ] || mkdir -p "$MESH_DIR" 2>/dev/null; then
    check "mesh data dir (~/.grip-session-mesh)" "ok"
else
    check "mesh data dir" "cannot create"
fi

# --- Check 5: Bus health ---
if curl -sf http://127.0.0.1:9474/health > /dev/null 2>&1; then
    check "bus :9474 health" "ok"
else
    check "bus :9474 health" "not running (start with: npm start --prefix server)"
fi

# --- Report ---
echo "====================================================="
echo "  MESH SKILL.MD — Self-Verification Report"
echo "====================================================="
echo ""
printf "%s" "  SHA-256: ${SELF_HASH}"
echo ""
printf "$CHECKS"
echo ""
echo "  Result: ${PASS} passed, ${FAIL} failed"
echo "====================================================="

[ "$FAIL" -gt 0 ] && exit 1 || exit 0
