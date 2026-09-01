#!/bin/bash
# Session end hook for tars
# Sets agent status to "completed" when session terminates and captures final output

# Read JSON input from stdin
INPUT=$(cat)

# Extract info
SESSION_ID=$(echo "$INPUT" | jq -r '.session_id // empty')
TRANSCRIPT_PATH=$(echo "$INPUT" | jq -r '.transcript_path // empty')
CWD=$(echo "$INPUT" | jq -r '.cwd // empty')
REASON=$(echo "$INPUT" | jq -r '.reason // "other"')

echo "[$(date)] SESSION_END hook. AGENT_ID=${CLAUDE_AGENT_ID:-unset} SESSION_ID=$SESSION_ID" >> /tmp/dorothy-hooks.log

# API endpoint
API_URL="http://127.0.0.1:31415"

# Get agent ID from environment or use session ID
AGENT_ID="${CLAUDE_AGENT_ID:-$SESSION_ID}"

# Check if API is available
if ! curl -s --connect-timeout 1 --max-time 2 "$API_URL/api/health" > /dev/null 2>&1; then
  echo '{"continue":true,"suppressOutput":true}'
  exit 0
fi

# Capture final clean output from transcript before marking completed.
# Same line-tolerant extraction as on-stop.sh: the old tail|grep|jq chain
# missed the last text block whenever the session ended right after a tool
# call (final assistant record contains only tool_use blocks).
if [ -n "$TRANSCRIPT_PATH" ] && [ -f "$TRANSCRIPT_PATH" ]; then
  LAST_ASSISTANT_MSG=$(jq -rRn '
    [ inputs | fromjson? | select(.type=="assistant")
          | (.message.content // [])
          | if type=="array" then map(select(type=="object" and .type=="text") | .text) | join("\n") else tostring end
          | select(length>0) ]
    | last // empty' "$TRANSCRIPT_PATH" 2>/dev/null | head -c 4000)

  if [ -n "$LAST_ASSISTANT_MSG" ]; then
    curl -s --max-time 3 -X POST "$API_URL/api/hooks/output" \
      -H "Content-Type: application/json" \
      -d "{\"agent_id\": \"$AGENT_ID\", \"session_id\": \"$SESSION_ID\", \"output\": $(printf '%s' "$LAST_ASSISTANT_MSG" | jq -Rs .)}" \
      > /dev/null 2>&1
  fi
fi

# Update agent status to "completed" (session ended)
curl -s --max-time 3 -X POST "$API_URL/api/hooks/status" \
  -H "Content-Type: application/json" \
  -d "{\"agent_id\": \"$AGENT_ID\", \"session_id\": \"$SESSION_ID\", \"status\": \"completed\", \"reason\": \"$REASON\"}" \
  > /dev/null 2>&1

# Output hook response
echo '{"continue":true,"suppressOutput":true}'
exit 0
