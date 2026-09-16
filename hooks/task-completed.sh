#!/bin/bash
LOG="/tmp/dorothy-hooks-debug.log"
INPUT=$(cat)
SESSION_ID=$(echo "$INPUT" | jq -r '.session_id // empty')
# The Tars that spawned this agent, not whoever happens to own 31415:
# CLAUDE_MGR_API_URL is in the pty environment and follows DOROTHY_API_PORT.
API_URL="${CLAUDE_MGR_API_URL:-http://127.0.0.1:31415}"
AGENT_ID="${CLAUDE_AGENT_ID:-$SESSION_ID}"
echo "========================================" >> "$LOG"
echo "[$(date)] TASK_COMPLETED — AGENT=$AGENT_ID" >> "$LOG"
LAST_MSG=$(echo "$INPUT" | jq -r '.last_assistant_message // empty')
echo "  last_assistant_message length: ${#LAST_MSG}" >> "$LOG"
if [ -z "$LAST_MSG" ]; then
  TRANSCRIPT_PATH=$(echo "$INPUT" | jq -r '.transcript_path // empty')
  if [ -n "$TRANSCRIPT_PATH" ] && [ -f "$TRANSCRIPT_PATH" ]; then
    # Portable last-assistant-message extraction (macOS has no GNU `tac`).
    # Line-by-line with fromjson? so a truncated/partial final line (Claude
    # Code may still be flushing records) doesn't void the whole extraction.
    LAST_MSG=$(jq -rRn '
      [ inputs | fromjson? | select(.type=="assistant")
            | (.message.content // [])
            | if type=="array" then map(select(type=="object" and .type=="text") | .text) | join("\n") else tostring end
            | select(length>0) ]
      | last // empty' "$TRANSCRIPT_PATH" 2>/dev/null | head -c 4000)
  fi
fi
if [ -n "$LAST_MSG" ]; then
  TRIMMED=$(printf '%s' "$LAST_MSG" | head -c 4000)
  curl -s --max-time 3 -X POST "$API_URL/api/hooks/output" -H "Content-Type: application/json" -d "{\"agent_id\": \"$AGENT_ID\", \"session_id\": \"$SESSION_ID\", \"output\": $(printf '%s' "$TRIMMED" | jq -Rs .)}" >> "$LOG" 2>&1
fi
curl -s --max-time 3 -X POST "$API_URL/api/hooks/task-completed" -H "Content-Type: application/json" -d "{\"agent_id\": \"$AGENT_ID\", \"session_id\": \"$SESSION_ID\"}" > /dev/null 2>&1
echo '{"continue":true,"suppressOutput":true}'
