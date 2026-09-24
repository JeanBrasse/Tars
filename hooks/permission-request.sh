#!/bin/bash
source "$(dirname "${BASH_SOURCE[0]}")/tars-hook.sh"
# PermissionRequest hook for tars
# Fires when Claude Code's permission dialog appears: sets agent to "waiting"

# Read JSON input from stdin
INPUT=$(cat)

# Extract info
SESSION_ID=$(echo "$INPUT" | jq -r '.session_id // empty')
TOOL_NAME=$(echo "$INPUT" | jq -r '.tool_name // empty')

echo "[$(date)] PERMISSION_REQUEST hook. AGENT_ID=${CLAUDE_AGENT_ID:-unset} SESSION_ID=$SESSION_ID TOOL=$TOOL_NAME" >> "$HOOK_LOG"

# API endpoint
# The Tars that spawned this agent, not whoever happens to own 31415:
# CLAUDE_MGR_API_URL is in the pty environment and follows DOROTHY_API_PORT.
API_URL="${CLAUDE_MGR_API_URL:-http://127.0.0.1:31415}"

# Get agent ID from environment or use session ID
AGENT_ID="${CLAUDE_AGENT_ID:-$SESSION_ID}"

# When the dialog opened, in milliseconds, taken here and not when the post
# reaches Tars: a refusal made before a late post arrived read as older than the
# dialog, and the agent stayed deaf (the Audit's re-check of #174). jq's `now`,
# because `date` has no portable way to print milliseconds on both macOS and Linux.
#
# The tool and its input go with it, so Tars can say what the dialog asks
# (AgentStatus.waitingOn): the command, the file, or, for AskUserQuestion, the
# question. Built by jq from the CLI's own JSON, never by pasting shell strings
# into a body.
BODY=$(printf '%s' "$INPUT" | jq -c --arg agent "$AGENT_ID" \
  '{agent_id: $agent, session_id: (.session_id // ""), status: "waiting", waiting_reason: "permission",
    opened_at: (now * 1000 | floor), tool_name: (.tool_name // ""), tool_input: (.tool_input // {})}' 2>/dev/null)
if [ -z "$BODY" ]; then
  BODY="{\"agent_id\": \"$AGENT_ID\", \"session_id\": \"$SESSION_ID\", \"status\": \"waiting\", \"waiting_reason\": \"permission\"}"
fi
curl -s --max-time 3 -X POST "$API_URL/api/hooks/status" -H @<(tars_auth) \
  -H "Content-Type: application/json" \
  -d "$BODY" \
  > /dev/null 2>&1

echo '{"continue":true,"suppressOutput":true}'
exit 0
