#!/bin/bash
source "$(dirname "${BASH_SOURCE[0]}")/tars-hook.sh"
LOG="$HOOK_DEBUG_LOG"
INPUT=$(cat)
SESSION_ID=$(echo "$INPUT" | jq -r '.session_id // empty')
STOP_HOOK_ACTIVE=$(echo "$INPUT" | jq -r '.stop_hook_active // false')
if [ "$STOP_HOOK_ACTIVE" = "true" ]; then
  echo '{"continue":true,"suppressOutput":true}'
  exit 0
fi
# The Tars that spawned this agent, not whoever happens to own 31415:
# CLAUDE_MGR_API_URL is in the pty environment and follows DOROTHY_API_PORT.
API_URL="${CLAUDE_MGR_API_URL:-http://127.0.0.1:31415}"
AGENT_ID="${CLAUDE_AGENT_ID:-$SESSION_ID}"
echo "========================================" >> "$LOG"
echo "[$(date)] STOP hook — AGENT=$AGENT_ID" >> "$LOG"
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
  curl -s --max-time 3 -X POST "$API_URL/api/hooks/output" -H @<(tars_auth) -H "Content-Type: application/json" -d "{\"agent_id\": \"$AGENT_ID\", \"session_id\": \"$SESSION_ID\", \"output\": $(printf '%s' "$TRIMMED" | jq -Rs .)}" >> "$LOG" 2>&1
  echo "  Output sent (${#TRIMMED} chars)" >> "$LOG"
fi
# What the agent leaves waiting inside its CLI at this rest: its timers (a
# ScheduleWakeup of /loop, a CronCreate) and the background tasks still running.
# No process shows either, and an agent put to sleep loses them with its CLI
# (services/agent-sleep.ts). Claude Code 2.1.289 sends both lists to the Stop
# hook; a claude that sends neither, as lists, sends no count: nothing is known.
PENDING=$(echo "$INPUT" | jq -c 'if (.session_crons | type) == "array" and (.background_tasks | type) == "array" then
  { crons: (.session_crons | length),
    background: ([.background_tasks[] | (if type == "object" then (.status // "running") else "running" end | tostring)
      | select(. as $s | ["completed", "failed", "killed", "stopped", "error"] | index($s) | not)] | length) }
  else empty end' 2>/dev/null)
curl -s --max-time 3 -X POST "$API_URL/api/hooks/status" -H @<(tars_auth) -H "Content-Type: application/json" -d "{\"agent_id\": \"$AGENT_ID\", \"session_id\": \"$SESSION_ID\", \"status\": \"idle\"${PENDING:+, \"pending\": $PENDING}}" > /dev/null 2>&1
curl -s --max-time 3 -X POST "$API_URL/api/hooks/agent-stopped" -H @<(tars_auth) -H "Content-Type: application/json" -d "{\"agent_id\": \"$AGENT_ID\", \"session_id\": \"$SESSION_ID\"}" > /dev/null 2>&1
echo '{"continue":true,"suppressOutput":true}'
