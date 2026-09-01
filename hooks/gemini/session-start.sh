#!/bin/bash
# Session start hook for tars (Gemini CLI)

INPUT=$(cat)

SESSION_ID=$(echo "$INPUT" | jq -r '.session_id // empty')
CWD=$(echo "$INPUT" | jq -r '.cwd // empty')

API_URL="http://127.0.0.1:31415"

AGENT_ID="${DOROTHY_AGENT_ID:-$SESSION_ID}"

# `source` marks this as a SessionStart registration: the server records the
# session id WITHOUT touching status. Without it, the stale-session guard
# would reject every later post from this session once a previous Gemini
# session had registered.
curl -s --max-time 3 -X POST "$API_URL/api/hooks/status" \
  -H "Content-Type: application/json" \
  -d "{\"agent_id\": \"$AGENT_ID\", \"session_id\": \"$SESSION_ID\", \"status\": \"running\", \"source\": \"startup\"}" \
  > /dev/null 2>&1 &

echo '{"continue":true,"suppressOutput":true}'
exit 0
