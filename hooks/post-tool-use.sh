#!/bin/bash
source "$(dirname "${BASH_SOURCE[0]}")/tars-hook.sh"
# Post-tool-use hook for tars memory system
# Captures file edits, writes, and commands

# Read JSON input from stdin
INPUT=$(cat)

# Extract tool info
TOOL_NAME=$(echo "$INPUT" | jq -r '.tool_name // empty')
SESSION_ID=$(echo "$INPUT" | jq -r '.session_id // empty')
CWD=$(echo "$INPUT" | jq -r '.cwd // empty')

# Skip if no tool name
if [ -z "$TOOL_NAME" ]; then
  echo '{"continue":true,"suppressOutput":true}'
  exit 0
fi

# API endpoint
# The Tars that spawned this agent, not whoever happens to own 31415:
# CLAUDE_MGR_API_URL is in the pty environment and follows DOROTHY_API_PORT.
BASE_URL="${CLAUDE_MGR_API_URL:-http://127.0.0.1:31415}"
API_URL="$BASE_URL/api/memory/remember"

# Get agent ID from environment or use session ID
AGENT_ID="${CLAUDE_AGENT_ID:-$SESSION_ID}"
PROJECT_PATH="${CLAUDE_PROJECT_PATH:-$CWD}"

# Update agent status to "running" — this hook fires after each tool use,
# which signals Claude is actively working (e.g. after permission is granted)
curl -s --connect-timeout 1 --max-time 3 -X POST "$BASE_URL/api/hooks/status" -H @<(tars_auth) \
  -H "Content-Type: application/json" \
  -d "{\"agent_id\": \"$AGENT_ID\", \"session_id\": \"$SESSION_ID\", \"status\": \"running\"}" \
  > /dev/null 2>&1

# Function to store observation. The payload MUST be built with jq: tool
# input routinely contains quotes/newlines/backslashes, and naive string
# interpolation would produce invalid JSON (observation silently dropped)
# or let agent-controlled text inject extra JSON fields.
# The CLI's own token: it names this agent. The shared file only when Tars
# did not start this CLI and gave it none.
API_TOKEN="${CLAUDE_MGR_API_TOKEN:-}"
if [ -z "$API_TOKEN" ] && [ -f "$HOME/.dorothy/api-token" ]; then
  API_TOKEN=$(cat "$HOME/.dorothy/api-token" 2>/dev/null)
fi

store_observation() {
  local content="$1"
  local type="$2"

  local payload
  payload=$(jq -n \
    --arg agent_id "$AGENT_ID" \
    --arg project_path "$PROJECT_PATH" \
    --arg content "$content" \
    --arg type "$type" \
    '{agent_id: $agent_id, project_path: $project_path, content: $content, type: $type}')

  curl -s --max-time 3 -X POST "$API_URL" \
    -H "Content-Type: application/json" \
    -H @<(printf "Authorization: Bearer %s" "$API_TOKEN") \
    -d "$payload" \
    > /dev/null 2>&1
}

case "$TOOL_NAME" in
  "Write")
    FILE_PATH=$(echo "$INPUT" | jq -r '.tool_input.file_path // empty')
    [ -n "$FILE_PATH" ] && store_observation "Created/wrote file: $FILE_PATH" "file_edit"
    ;;
  "Edit")
    FILE_PATH=$(echo "$INPUT" | jq -r '.tool_input.file_path // empty')
    OLD_STR=$(echo "$INPUT" | jq -r '.tool_input.old_string // empty' | head -c 100)
    NEW_STR=$(echo "$INPUT" | jq -r '.tool_input.new_string // empty' | head -c 100)
    if [ -n "$FILE_PATH" ]; then
      if [ -n "$OLD_STR" ]; then
        store_observation "Edited $FILE_PATH: replaced '${OLD_STR}...' with '${NEW_STR}...'" "file_edit"
      else
        store_observation "Edited file: $FILE_PATH" "file_edit"
      fi
    fi
    ;;
  "Bash")
    COMMAND=$(echo "$INPUT" | jq -r '.tool_input.command // empty' | head -c 200)
    DESCRIPTION=$(echo "$INPUT" | jq -r '.tool_input.description // empty')
    if [ -n "$COMMAND" ]; then
      if [ -n "$DESCRIPTION" ]; then
        store_observation "Ran command: $DESCRIPTION ($COMMAND)" "command"
      else
        store_observation "Ran command: $COMMAND" "command"
      fi
    fi
    ;;
  "Read")
    # Don't store reads - too noisy
    ;;
  "Grep"|"Glob")
    # Don't store searches - too noisy
    ;;
  "Task")
    TASK_DESC=$(echo "$INPUT" | jq -r '.tool_input.description // empty')
    [ -n "$TASK_DESC" ] && store_observation "Spawned agent task: $TASK_DESC" "tool_use"
    ;;
  *)
    # Store other tool uses if they seem significant
    if [[ "$TOOL_NAME" == mcp__* ]]; then
      store_observation "Used MCP tool: $TOOL_NAME" "tool_use"
    fi
    ;;
esac

# Output hook response
echo '{"continue":true,"suppressOutput":true}'
exit 0
