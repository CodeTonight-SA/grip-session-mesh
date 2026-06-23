#!/usr/bin/env bash
# install-macos.sh — persist grip-session-mesh across reboots via launchd.
#
# Installs three user LaunchAgents (bus, relay, per-session client), each with
# RunAtLoad + KeepAlive: they start at login and respawn on crash — so the mesh
# survives reboots and process death. Idempotent (re-run to update). The receive
# Monitor is intentionally NOT a daemon: it surfaces messages into a live Claude
# session, so each session starts its own (inbound queues as an inbox meanwhile).
#
# Usage:  deploy/launchd/install-macos.sh [session-name]
#         session-name defaults to a slug of this machine's ComputerName.
#
# Verify:  launchctl list | grep grip   &&   curl -s localhost:9474/health
# Remove:  deploy/launchd/uninstall-macos.sh
set -euo pipefail

NAME="${1:-$(scutil --get ComputerName 2>/dev/null | tr '[:upper:] ' '[:lower:]-' | tr -cd 'a-z0-9-')}"
NAME="${NAME:-$(hostname -s)}"
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
LA="$HOME/Library/LaunchAgents"
LOGS="$HOME/.grip-session-mesh/logs"

NODE="$(command -v node)" || { echo "node not found on PATH" >&2; exit 1; }

# A python that can import 'websockets' (the relay's only dependency).
PY=""
for c in "$HOME/.grip/venv/bin/python" "$HOME/.claude/venv/bin/python" "$(command -v python3 || true)"; do
  if [ -n "$c" ] && [ -x "$c" ] && "$c" -c "import websockets" 2>/dev/null; then PY="$c"; break; fi
done
[ -n "$PY" ] || { echo "no python with 'websockets' found (pip install websockets)" >&2; exit 1; }

[ -f "$REPO/server/dist/index.js" ] || { echo "build the server first: npm install --prefix server && npm run build --prefix server" >&2; exit 1; }

mkdir -p "$LA" "$LOGS"

render() { # render <short-name> <program> [args...]
  local short="$1"; shift
  local label="com.grip.mesh-$short" progargs=""
  for a in "$@"; do progargs="$progargs    <string>$a</string>
"; done
  cat > "$LA/$label.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$label</string>
  <key>ProgramArguments</key>
  <array>
$progargs  </array>
  <key>WorkingDirectory</key><string>$REPO</string>
  <key>EnvironmentVariables</key>
  <dict><key>HOME</key><string>$HOME</string><key>PATH</key><string>/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin</string></dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>5</integer>
  <key>StandardOutPath</key><string>$LOGS/$short.out.log</string>
  <key>StandardErrorPath</key><string>$LOGS/$short.err.log</string>
</dict>
</plist>
PLIST
  plutil -lint "$LA/$label.plist" >/dev/null
  echo "rendered $label"
}

render bus    "$NODE" "$REPO/server/dist/index.js"
render relay  "$PY"   "$REPO/relay/mesh_relay.py" connect
render client "$NODE" "$REPO/client/mesh-client.js" "$NAME"

U="$(id -u)"
for short in bus relay client; do
  label="com.grip.mesh-$short"
  # bootstrap if new; kickstart -k to reload if already present (idempotent update).
  launchctl bootstrap "gui/$U" "$LA/$label.plist" 2>/dev/null \
    || launchctl kickstart -k "gui/$U/$label" 2>/dev/null || true
done

echo
echo "grip-session-mesh persisted for session '$NAME' (repo: $REPO)."
launchctl list | grep -i grip || echo "(no agents listed — check $LOGS/*.err.log)"
