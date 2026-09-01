#!/bin/bash
# UserPromptSubmit hook for tars
# Sets agent status back to "running" when user submits a new prompt mid-session

# Read JSON input from stdin
INPUT=$(cat)

# Extract info
SESSION_ID=$(echo "$INPUT" | jq -r '.session_id // empty')
PROMPT=$(echo "$INPUT" | jq -r '.prompt // empty')

echo "[$(date)] USER_PROMPT_SUBMIT hook. AGENT_ID=${CLAUDE_AGENT_ID:-unset} SESSION_ID=$SESSION_ID" >> /tmp/dorothy-hooks.log

# API endpoint
API_URL="http://127.0.0.1:31415"

# Get agent ID from environment or use session ID
AGENT_ID="${CLAUDE_AGENT_ID:-$SESSION_ID}"

# Update agent status to "running" and set current task to the user's prompt.
#
# Retried once, the same way SessionStart is, and for a heavier reason than
# a status update.
#
# When Tars reuses a live session (a task sent from Slack or Telegram into an
# already running claude), it clears the agent's session ownership as it arms
# the never-started-a-turn check, because that check reads "no session has
# registered yet". That live session will never send a second SessionStart, so
# the only thing that restores ownership is this post: the server adopts the
# first session that reports in without a `source`. Lost, and the agent is
# both unowned and, ten minutes later, accused of never having started while
# it is working. One attempt at best was too thin a thread for that.
#
# See armTaskStartWatch in electron/core/agent-manager.ts and the registration
# fallback in electron/services/api-routes/hooks-routes.ts: this hook is the
# third piece of that mechanism, and it is the only one written in shell.
PAYLOAD="{\"agent_id\": \"$AGENT_ID\", \"session_id\": \"$SESSION_ID\", \"status\": \"running\", \"current_task\": $(echo "$PROMPT" | head -c 200 | jq -Rs .)}"
RESULT=$(curl -s --max-time 3 -X POST "$API_URL/api/hooks/status" \
  -H "Content-Type: application/json" \
  -d "$PAYLOAD" 2>&1)
if [ -z "$RESULT" ]; then
  sleep 1
  RESULT=$(curl -s --max-time 3 -X POST "$API_URL/api/hooks/status" \
    -H "Content-Type: application/json" \
    -d "$PAYLOAD" 2>&1)
fi
echo "[$(date)] USER_PROMPT_SUBMIT curl result: $RESULT" >> /tmp/dorothy-hooks.log

echo '{"continue":true,"suppressOutput":true}'
exit 0
