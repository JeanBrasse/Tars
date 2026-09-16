#!/bin/bash
# Notification hook for tars (Gemini CLI)

INPUT=$(cat)

SESSION_ID=$(echo "$INPUT" | jq -r '.session_id // empty')
MESSAGE=$(echo "$INPUT" | jq -r '.message // empty')
CWD=$(echo "$INPUT" | jq -r '.cwd // empty')

# The Tars that spawned this agent, not whoever happens to own 31415:
# CLAUDE_MGR_API_URL is in the pty environment and follows DOROTHY_API_PORT.
API_URL="${CLAUDE_MGR_API_URL:-http://127.0.0.1:31415}"

AGENT_ID="${DOROTHY_AGENT_ID:-$SESSION_ID}"
PROJECT_PATH="${DOROTHY_PROJECT_PATH:-$CWD}"

# Forward notification to tars
if [ -n "$MESSAGE" ]; then
  SAFE_MSG=$(echo "$MESSAGE" | jq -Rs .)
  curl -s --max-time 3 -X POST "$API_URL/api/hooks/notification" \
    -H "Content-Type: application/json" \
    -d "{\"agent_id\": \"$AGENT_ID\", \"session_id\": \"$SESSION_ID\", \"message\": $SAFE_MSG, \"project_path\": \"$PROJECT_PATH\"}" \
    > /dev/null 2>&1 &
fi

echo '{"continue":true,"suppressOutput":true}'
exit 0
