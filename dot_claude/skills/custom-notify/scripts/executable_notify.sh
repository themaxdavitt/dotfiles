#!/usr/bin/env bash

EVENT="${1:-stop}"
INPUT=$(cat)

CWD=$(printf '%s' "$INPUT" | jq -r '.cwd // empty' 2>/dev/null)
PROJECT=""
[ -n "$CWD" ] && PROJECT=$(basename "$CWD")

case "$EVENT" in
    notification)
        TITLE="Claude Code"
        BODY="⌛ Waiting for your input"
        ;;
    stop)
        # Avoid a double notification when a stop hook is already active.
        ACTIVE=$(printf '%s' "$INPUT" | jq -r '.stop_hook_active // false' 2>/dev/null)
        [ "$ACTIVE" = "true" ] && exit 0
        TITLE="Claude Code"
        BODY="✅ Turn finished"
        ;;
    permission)
        TOOL=$(printf '%s' "$INPUT" | jq -r '.tool_name // "a tool"' 2>/dev/null)
        PREVIEW=$(printf '%s' "$INPUT" | jq -r '(.tool_input | if .command then .command elif .file_path then .file_path else "" end) // ""' 2>/dev/null)
        TITLE="Claude Code"
        BODY="🔐 Permission for $TOOL"
        if [ -n "$PREVIEW" ]; then
            [ ${#PREVIEW} -gt 80 ] && PREVIEW="${PREVIEW:0:77}..."
            BODY="$BODY: $PREVIEW"
        fi
        ;;
    *)
        exit 0
        ;;
esac

[ -n "$PROJECT" ] && BODY="$BODY · $PROJECT"

# Sanitize ';' (the OSC 777 field delimiter) and newlines.
BODY=$(printf '%s' "$BODY" | tr '\n' ' ' | tr ';' ',')
TITLE=$(printf '%s' "$TITLE" | tr ';' ',')

jq -nc \
  --arg seq "$(printf '\033]777;notify;%s;%s\007' "$TITLE" "$BODY")" \
  '{terminalSequence: $seq}'
