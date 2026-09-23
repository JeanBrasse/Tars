#!/bin/bash
source "$(dirname "${BASH_SOURCE[0]}")/../tars-hook.sh"
# UserPromptSubmit hook for tars (Gemini CLI)
# Sets agent status back to "running" when user submits a new prompt mid-session

INPUT=$(cat)

SESSION_ID=$(echo "$INPUT" | jq -r '.session_id // empty')

# The Tars that spawned this agent, not whoever happens to own 31415:
# CLAUDE_MGR_API_URL is in the pty environment and follows DOROTHY_API_PORT.
API_URL="${CLAUDE_MGR_API_URL:-http://127.0.0.1:31415}"

AGENT_ID="${DOROTHY_AGENT_ID:-$SESSION_ID}"

echo "[$(date)] GEMINI USER_PROMPT_SUBMIT hook. AGENT_ID=${DOROTHY_AGENT_ID:-unset} SESSION_ID=$SESSION_ID" >> "$HOOK_LOG"

curl -s --max-time 3 -X POST "$API_URL/api/hooks/status" -H @<(tars_auth) \
  -H "Content-Type: application/json" \
  -d "{\"agent_id\": \"$AGENT_ID\", \"session_id\": \"$SESSION_ID\", \"status\": \"running\"}" \
  > /dev/null 2>&1

echo '{"continue":true,"suppressOutput":true}'
exit 0
