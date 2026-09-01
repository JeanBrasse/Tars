#!/bin/bash
# Session start hook for tars
# Registers session ID and injects memory context (does NOT set running — that's UserPromptSubmit's job)

# Read JSON input from stdin
INPUT=$(cat)

# Extract info
SESSION_ID=$(echo "$INPUT" | jq -r '.session_id // empty')
CWD=$(echo "$INPUT" | jq -r '.cwd // empty')
SOURCE=$(echo "$INPUT" | jq -r '.source // "startup"')

echo "[$(date)] SESSION_START hook. AGENT_ID=${CLAUDE_AGENT_ID:-unset} SESSION_ID=$SESSION_ID" >> /tmp/dorothy-hooks.log

# API endpoint
API_URL="http://127.0.0.1:31415"

# Get agent ID from environment or use session ID
AGENT_ID="${CLAUDE_AGENT_ID:-$SESSION_ID}"
PROJECT_PATH="${CLAUDE_PROJECT_PATH:-$CWD}"

# Check if API is available.
#
# --max-time as well as --connect-timeout, because the two bound different
# things and only one of them was set. --connect-timeout bounds the TCP
# handshake; a socket that accepts and then never answers passes it and leaves
# curl blocked on the read with no deadline at all. Something half-open on
# 31415 is not hypothetical: it is a port collision, an app being killed
# mid-request, a sandbox on the same port.
#
# That is the whole of the "lost dispatch". This is the first statement in the
# hook, so the registration POST below never runs, the hook is killed at the 30s
# timeout Tars configures for it, and the session starts UNREGISTERED. The agent
# then does the work, and every status, output and task-completed post it makes
# is dropped as stale because no session ever claimed the agent. The order was
# never lost; its result was.
if ! curl -s --connect-timeout 1 --max-time 2 "$API_URL/api/health" > /dev/null 2>&1; then
  # API not running, just continue
  echo '{"continue":true,"suppressOutput":true}'
  exit 0
fi

# Register this session as the agent's owner. The server recognizes the
# `source` field (only SessionStart sends it) and records session_id WITHOUT
# touching status — the status lifecycle belongs to UserPromptSubmit/Stop.
# Retry once: if registration is lost, the stale-session guard would ignore
# every later status post from this session.
RESULT=$(curl -s --max-time 3 -X POST "$API_URL/api/hooks/status" \
  -H "Content-Type: application/json" \
  -d "{\"agent_id\": \"$AGENT_ID\", \"session_id\": \"$SESSION_ID\", \"status\": \"idle\", \"source\": \"$SOURCE\"}" 2>&1)
if [ -z "$RESULT" ]; then
  sleep 1
  RESULT=$(curl -s --max-time 3 -X POST "$API_URL/api/hooks/status" \
    -H "Content-Type: application/json" \
    -d "{\"agent_id\": \"$AGENT_ID\", \"session_id\": \"$SESSION_ID\", \"status\": \"idle\", \"source\": \"$SOURCE\"}" 2>&1)
fi
echo "[$(date)] SESSION_START curl result: $RESULT" >> /tmp/dorothy-hooks.log

# The /api/agents and /api/memory endpoints require the API token (only
# /api/hooks/* and /api/health are auth-exempt).
API_TOKEN=""
if [ -f "$HOME/.dorothy/api-token" ]; then
  API_TOKEN=$(cat "$HOME/.dorothy/api-token" 2>/dev/null)
fi

# Identity + team roster bootstrap: injected into EVERY fresh session so the
# agent knows who it is, which project it belongs to, and (for orchestrators)
# which agents it may delegate to — no manual "say hello to the team" ritual.
BOOTSTRAP=""
if [ -n "$CLAUDE_AGENT_ID" ] && [ -n "$API_TOKEN" ]; then
  BOOTSTRAP=$(curl -s --connect-timeout 2 --max-time 3 -H @<(printf "Authorization: Bearer %s" "$API_TOKEN") \
    "$API_URL/api/agents/$CLAUDE_AGENT_ID/bootstrap" 2>/dev/null | jq -r '.context // empty' 2>/dev/null)
fi

# Get memory context for this agent/project
CONTEXT=$(curl -s --connect-timeout 2 --max-time 3 -H @<(printf "Authorization: Bearer %s" "$API_TOKEN") \
  "$API_URL/api/memory/context?agent_id=$AGENT_ID&project_path=$PROJECT_PATH" 2>/dev/null)
MEMORY_CONTENT=""
if [ -n "$CONTEXT" ] && [ "$CONTEXT" != "null" ] && [ "$CONTEXT" != "{}" ]; then
  MEMORY_CONTENT=$(echo "$CONTEXT" | jq -r '.context // empty' 2>/dev/null)
  if [ "$MEMORY_CONTENT" = "No previous context found for this agent/project." ]; then
    MEMORY_CONTENT=""
  fi
fi

# Combine bootstrap + memory into one injection
COMBINED="$BOOTSTRAP"
if [ -n "$MEMORY_CONTENT" ]; then
  if [ -n "$COMBINED" ]; then
    COMBINED="$COMBINED

$MEMORY_CONTENT"
  else
    COMBINED="$MEMORY_CONTENT"
  fi
fi

if [ -n "$COMBINED" ]; then
  ESCAPED_CONTENT=$(printf '%s' "$COMBINED" | jq -Rs .)
  echo "{\"continue\":true,\"suppressOutput\":false,\"hookSpecificOutput\":{\"hookEventName\":\"SessionStart\",\"additionalContext\":$ESCAPED_CONTENT}}"
  exit 0
fi

# No context to inject
echo '{"continue":true,"suppressOutput":true}'
exit 0
