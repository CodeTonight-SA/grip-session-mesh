#!/usr/bin/env bash
# mesh-send.sh — queue a message for the mesh-client to send.
# Usage: mesh-send.sh <my-name> <to|broadcast> <body...> [--kind <kind>]
# The running mesh-client.js for <my-name> drains the queue within ~1s and
# sends it over the bus (routed locally + across the Tailscale relay by name).
set -euo pipefail

MESH="${HOME}/.grip-session-mesh"
NAME="${1:?usage: mesh-send.sh <my-name> <to|broadcast> <body...>}"
TO="${2:?usage: mesh-send.sh <my-name> <to|broadcast> <body...>}"
shift 2
KIND="message"
BODY=""
while [ $# -gt 0 ]; do
  case "$1" in
    --kind) KIND="${2:?--kind needs a value}"; shift 2 ;;
    *) BODY="${BODY:+$BODY }$1"; shift ;;
  esac
done
[ -n "$BODY" ] || { echo "mesh-send: empty body" >&2; exit 2; }

mkdir -p "${MESH}/outbound"
OUTBOX="${MESH}/outbound/${NAME}.jsonl"
# Build the queue line with python for correct JSON escaping (no jq dependency).
python3 - "$TO" "$KIND" "$BODY" >> "$OUTBOX" <<'PY'
import json, sys
to, kind, body = sys.argv[1], sys.argv[2], sys.argv[3]
print(json.dumps({"to": to, "kind": kind, "body": body}))
PY
echo "queued -> ${TO} (${KIND})"
