#!/usr/bin/env bash
# mesh-inbound.sh — Monitor script for the Claude Code Monitor tool.
#
# Usage (in CC session after /mesh connect):
#   Monitor monitors/mesh-inbound.sh
#
# The Monitor tool calls this script repeatedly. Each run checks for new
# messages in the inbound queue and outputs them as structured prompts.
# Zero token cost when no messages are waiting.

set -euo pipefail

MESH_DIR="${HOME}/.grip-session-mesh"
INBOX_DIR="${MESH_DIR}/inbound"
SESSION_ID="${GRIP_MESH_SESSION_ID:-}"
LOG="${MESH_DIR}/log.jsonl"

mkdir -p "$INBOX_DIR"

# No session registered — nothing to watch
if [ -z "$SESSION_ID" ]; then
    exit 0
fi

QUEUE="${INBOX_DIR}/${SESSION_ID}.jsonl"

# No queue file yet — exit silently (Monitor polls again later)
if [ ! -f "$QUEUE" ]; then
    exit 0
fi

# Atomically drain the queue
TMPFILE="${QUEUE}.drain.$$"
mv "$QUEUE" "$TMPFILE" 2>/dev/null || exit 0

# Process each line (each is a JSON message object)
while IFS= read -r line; do
    [ -z "$line" ] && continue

    FROM=$(echo "$line" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('from','unknown'))" 2>/dev/null || echo "unknown")
    KIND=$(echo "$line" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('kind','message'))" 2>/dev/null || echo "message")
    BODY=$(echo "$line" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('body',''))" 2>/dev/null || echo "")

    # Log the delivery
    TIMESTAMP=$(date -u +"%Y-%m-%dT%H:%M:%SZ")
    echo "{\"ts\":\"$TIMESTAMP\",\"event\":\"delivered\",\"from\":\"$FROM\",\"kind\":\"$KIND\"}" >> "$LOG"

    # Destructive safeguard — output warning, do not act automatically
    if echo "$BODY" | grep -qiE 'rm -rf|drop table|git push --force|git reset --hard'; then
        echo "[mesh:${FROM}:SAFEGUARD] Destructive command received — run '/mesh approve' to confirm before executing:"
        echo "  $BODY"
        continue
    fi

    # Output the message as a prompt for CC to act on
    case "$KIND" in
        broadcast)
            echo "[mesh:broadcast:${FROM}] ${BODY}"
            ;;
        pair_intercept_urgent)
            echo "[mesh:pair:${FROM}:INTERCEPT!] URGENT role swap requested — pause current tool call immediately."
            echo "  Message: ${BODY}"
            ;;
        pair_intercept)
            echo "[mesh:pair:${FROM}:intercept] Role swap requested when convenient."
            echo "  Message: ${BODY}"
            ;;
        pair_steer)
            echo "[mesh:pair:${FROM}:steer] ${BODY}"
            ;;
        *)
            echo "[mesh:${FROM}] ${BODY}"
            ;;
    esac

done < "$TMPFILE"

rm -f "$TMPFILE"
exit 0
