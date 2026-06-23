#!/usr/bin/env bash
# uninstall-macos.sh — stop + remove the grip-session-mesh launchd agents.
set -euo pipefail
LA="$HOME/Library/LaunchAgents"
U="$(id -u)"
for short in bus relay client; do
  label="com.grip.mesh-$short"
  launchctl bootout "gui/$U/$label" 2>/dev/null || true
  rm -f "$LA/$label.plist" 2>/dev/null || true
  echo "removed $label"
done
echo "grip-session-mesh launchd agents removed."
