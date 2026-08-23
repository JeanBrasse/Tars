import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { DATA_DIR_SHELL, dataPath } from '../constants';

const STATUSLINE_SCRIPT = `#!/usr/bin/env bash
# Dev Bar statusline for Claude Code
# Style: ◆ Model │ ctx: NN% ▰▰▰▱▱ (Nk/Nk) │ branch │ NNm │ +N -N │ ↑Nk ↓Nk
# Based on https://github.com/LLRHook/claude-statusline

set -euo pipefail

INPUT=$(cat)

# --- One jq pass for everything ---
# This script runs on every turn, for every agent. Each field used to cost its
# own echo-into-jq, eighteen processes per render; one pass emits them all.
FIELDS=$(echo "$INPUT" | jq -r '
  [ (.session_id // ""),
    (.context_window.total_input_tokens // 0),
    (.context_window.total_output_tokens // 0),
    (.cost.total_cost_usd // 0),
    (.model.model_id // .model.display_name // "unknown"),
    (.rate_limits.five_hour.used_percentage // 0),
    (.rate_limits.seven_day.used_percentage // 0),
    (.model.display_name // "..."),
    (.context_window.used_percentage // 0),
    (.context_window.context_window_size // 200000),
    (.cost.total_duration_ms // 0),
    (.cost.total_lines_added // 0),
    (.cost.total_lines_removed // 0),
    ((.rate_limits // empty) | tostring)
  ] | @tsv' 2>/dev/null || true)

IFS=$'\t' read -r SESSION_ID T_IN T_OUT T_COST T_MODEL PCT_5H PCT_7D \
  MODEL RAW_PCT_RAW CTX_MAX DURATION_MS LINES_ADDED LINES_REMOVED RATE_LIMITS \
  <<< "$FIELDS"

: "\${SESSION_ID:=}" "\${T_IN:=0}" "\${T_OUT:=0}" "\${T_COST:=0}" "\${T_MODEL:=unknown}"
: "\${PCT_5H:=0}" "\${PCT_7D:=0}" "\${MODEL:=...}" "\${RAW_PCT_RAW:=0}" "\${CTX_MAX:=200000}"
: "\${DURATION_MS:=0}" "\${LINES_ADDED:=0}" "\${LINES_REMOVED:=0}"
INPUT_TOKENS="$T_IN"
OUTPUT_TOKENS="$T_OUT"
RAW_PCT=$(awk -v p="$RAW_PCT_RAW" 'BEGIN {printf "%d", p}')

RATE_LIMITS_FILE="${DATA_DIR_SHELL}/rate-limits.json"
if [ -n "$RATE_LIMITS" ] && [ "$RATE_LIMITS" != "null" ]; then
  echo "$RATE_LIMITS" > "$RATE_LIMITS_FILE" 2>/dev/null || true
fi

# --- Accumulate token stats per session for the Usage page ---
TOKEN_STATS_FILE="${DATA_DIR_SHELL}/token-stats.json"
if [ -n "$SESSION_ID" ]; then
  IS_EXTRA=$(awk -v a="$PCT_5H" -v b="$PCT_7D" 'BEGIN { print (a > 100 || b > 100) ? "true" : "false" }')

  # Acquire lock to prevent concurrent read-modify-write races
  LOCK_DIR="${DATA_DIR_SHELL}/token-stats.lock"
  LOCK_ACQUIRED=false
  for _i in $(seq 1 20); do
    if mkdir "$LOCK_DIR" 2>/dev/null; then
      LOCK_ACQUIRED=true
      break
    fi
    sleep 0.05
  done
  # Stale lock cleanup: if lock dir is older than 5s, remove and retry once
  if [ "$LOCK_ACQUIRED" = "false" ] && [ -d "$LOCK_DIR" ]; then
    LOCK_AGE=$(( $(date +%s) - $(stat -f%m "$LOCK_DIR" 2>/dev/null || stat -c%Y "$LOCK_DIR" 2>/dev/null || echo 0) ))
    if [ "$LOCK_AGE" -gt 5 ]; then
      rmdir "$LOCK_DIR" 2>/dev/null || true
      mkdir "$LOCK_DIR" 2>/dev/null && LOCK_ACQUIRED=true
    fi
  fi

  if [ "$LOCK_ACQUIRED" = "true" ]; then
    # Ensure lock is released on exit
    trap 'rmdir "$LOCK_DIR" 2>/dev/null || true' EXIT

    # Read existing file or start fresh
    if [ -f "$TOKEN_STATS_FILE" ]; then
      EXISTING=$(cat "$TOKEN_STATS_FILE" 2>/dev/null || echo '{}')
    else
      EXISTING='{}'
    fi

    # Update session entry via temp file for atomic write
    T_DATE=$(date +%Y-%m-%d)
    T_PROVIDER="\${CLAUDE_PROVIDER:-claude}"
    TMP_FILE="\${TOKEN_STATS_FILE}.tmp.$$"
    echo "$EXISTING" | jq -c \
      --arg sid "$SESSION_ID" \
      --argjson tin "$T_IN" \
      --argjson tout "$T_OUT" \
      --argjson cost "$T_COST" \
      --arg model "$T_MODEL" \
      --argjson extra "$IS_EXTRA" \
      --arg date "$T_DATE" \
      --arg provider "$T_PROVIDER" \
      '.[$sid] = {"in": $tin, "out": $tout, "cost": $cost, "model": $model, "extra": $extra, "date": $date, "provider": $provider}' \
      > "$TMP_FILE" 2>/dev/null && mv "$TMP_FILE" "$TOKEN_STATS_FILE" 2>/dev/null || rm -f "$TMP_FILE"

    # Release lock
    rmdir "$LOCK_DIR" 2>/dev/null || true
  fi
fi

# Autocompact buffer size (tokens). Adjust if Claude Code changes this.
AUTOCOMPACT_BUFFER=33000

# Fields already read above in a single jq pass.
CTX_USED=$(awk -v pct="$RAW_PCT" -v max="$CTX_MAX" 'BEGIN {printf "%d", (pct * max) / 100}')

# Usable space = total - autocompact buffer
CTX_USABLE=$((CTX_MAX - AUTOCOMPACT_BUFFER))
# Percentage relative to usable space (can exceed 100%)
CTX_PCT=$(awk -v used="$CTX_USED" -v usable="$CTX_USABLE" 'BEGIN {printf "%d", (used * 100) / usable}')

# --- Git branch (cached for performance) ---
# This cache used to live at /tmp/claude-statusline-git<escaped-pwd>. /tmp is
# world-writable and the name is fully derived from the project path, so any
# other local user could pre-create it as a symlink to, say,
# ~/.dorothy/app-settings.json or ~/.zshrc; the redirect below follows symlinks
# and this script runs on every agent turn, so the victim's file was truncated
# and overwritten with a branch name within seconds (CWE-59 / CWE-377).
# The cache now lives in the app's own private 0700 directory next to
# rate-limits.json and token-stats.json, and we still refuse to read or write
# through a symlink as defence in depth.
GIT_CACHE_DIR="${DATA_DIR_SHELL}/statusline-cache"
mkdir -p "$GIT_CACHE_DIR" 2>/dev/null || true
chmod 700 "$GIT_CACHE_DIR" 2>/dev/null || true
GIT_CACHE="$GIT_CACHE_DIR/git\${PWD//\//_}"
GIT_CACHE_TTL=5  # seconds
BRANCH="?"
if [ -f "$GIT_CACHE" ] && [ ! -L "$GIT_CACHE" ]; then
  CACHE_AGE=$(( $(date +%s) - $(stat -f%m "$GIT_CACHE" 2>/dev/null || echo 0) ))
  if [ "$CACHE_AGE" -lt "$GIT_CACHE_TTL" ]; then
    BRANCH=$(cat "$GIT_CACHE")
  fi
fi
if [ "$BRANCH" = "?" ]; then
  BRANCH=$(git rev-parse --abbrev-ref HEAD 2>/dev/null || echo "?")
  if [ ! -L "$GIT_CACHE" ]; then
    echo "$BRANCH" > "$GIT_CACHE" 2>/dev/null || true
  fi
fi

# --- Session duration ---
format_duration() {
  local ms=$1
  local total_sec=$((ms / 1000))
  local hours=$((total_sec / 3600))
  local mins=$(( (total_sec % 3600) / 60 ))
  if [ "$hours" -gt 0 ]; then
    printf "%dh%dm" "$hours" "$mins"
  elif [ "$mins" -gt 0 ]; then
    printf "%dm" "$mins"
  else
    printf "%ds" "$total_sec"
  fi
}
DURATION_FMT=$(format_duration "$DURATION_MS")

# --- Format token counts as human-readable ---
format_tokens() {
  local tokens=$1
  if [ "$tokens" -ge 1000000 ]; then
    echo "$(awk -v t="$tokens" 'BEGIN {printf "%.1f", t/1000000}')M"
  elif [ "$tokens" -ge 1000 ]; then
    echo "$(awk -v t="$tokens" 'BEGIN {printf "%.0f", t/1000}')k"
  else
    echo "$tokens"
  fi
}

CTX_USED_FMT=$(format_tokens "$CTX_USED")
CTX_USABLE_FMT=$(format_tokens "$CTX_USABLE")
IN_FMT=$(format_tokens "$INPUT_TOKENS")
OUT_FMT=$(format_tokens "$OUTPUT_TOKENS")

# --- Colors ---
RESET='\\033[0m'
DIM='\\033[2m'
BOLD='\\033[1m'
GREEN='\\033[32m'
YELLOW='\\033[33m'
RED='\\033[31m'
CYAN='\\033[36m'
MAGENTA='\\033[35m'
WHITE='\\033[37m'
BLUE='\\033[34m'

# Context color based on usage of usable space
if [ "$CTX_PCT" -ge 80 ]; then
  CTX_COLOR="$RED"
elif [ "$CTX_PCT" -ge 50 ]; then
  CTX_COLOR="$YELLOW"
else
  CTX_COLOR="$GREEN"
fi

# Build progress bar (10 segments, capped at 10 filled)
FILLED=$((CTX_PCT / 10))
if [ "$FILLED" -gt 10 ]; then FILLED=10; fi
EMPTY=$((10 - FILLED))
BAR=""
for ((i = 0; i < FILLED; i++)); do BAR+="▰"; done
for ((i = 0; i < EMPTY; i++)); do BAR+="▱"; done

# --- Separator ---
SEP="\${DIM} │ \${RESET}"

# --- Build the line ---
# Model
printf "\${CYAN}\${BOLD}◆\${RESET} \${WHITE}\${BOLD}%s\${RESET}" "$MODEL"
printf "%b" "$SEP"
# Context usage (relative to usable space)
printf "\${CTX_COLOR}ctx: %d%% %s\${RESET} \${DIM}(%s/%s)\${RESET}" "$CTX_PCT" "$BAR" "$CTX_USED_FMT" "$CTX_USABLE_FMT"
printf "%b" "$SEP"
# Git branch
printf "\${MAGENTA}%s\${RESET}" "$BRANCH"
printf "%b" "$SEP"
# Session duration
printf "\${DIM}%s\${RESET}" "$DURATION_FMT"
printf "%b" "$SEP"
# Lines changed
printf "\${GREEN}+%s\${RESET} \${RED}-%s\${RESET}" "$LINES_ADDED" "$LINES_REMOVED"
printf "%b" "$SEP"
# Token throughput (input/output)
printf "\${DIM}↑%s ↓%s\${RESET}" "$IN_FMT" "$OUT_FMT"
printf "\\n"
`;

const SCRIPT_PATH = dataPath('statusline.sh');
const CLAUDE_SETTINGS_PATH = path.join(os.homedir(), '.claude', 'settings.json');

/**
 * Install the statusline script to ~/.dorothy/statusline.sh
 */
function installScript(): void {
  const dir = path.dirname(SCRIPT_PATH);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  fs.writeFileSync(SCRIPT_PATH, STATUSLINE_SCRIPT, { mode: 0o755 });
}

/**
 * Remove the statusline script from ~/.dorothy/statusline.sh
 */
function removeScript(): void {
  if (fs.existsSync(SCRIPT_PATH)) {
    fs.unlinkSync(SCRIPT_PATH);
  }
}

/**
 * Read Claude Code's settings.json
 */
function readClaudeSettings(): Record<string, unknown> {
  try {
    if (fs.existsSync(CLAUDE_SETTINGS_PATH)) {
      return JSON.parse(fs.readFileSync(CLAUDE_SETTINGS_PATH, 'utf-8'));
    }
  } catch {
    // ignore parse errors
  }
  return {};
}

/**
 * Write Claude Code's settings.json (preserving existing keys)
 */
function writeClaudeSettings(settings: Record<string, unknown>): void {
  const dir = path.dirname(CLAUDE_SETTINGS_PATH);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  fs.writeFileSync(CLAUDE_SETTINGS_PATH, JSON.stringify(settings, null, 2) + '\n', 'utf-8');
}

/**
 * Enable the statusline: install script + add config to Claude settings.json
 */
export function enableStatusLine(): void {
  installScript();

  const settings = readClaudeSettings();
  settings.statusLine = {
    type: 'command',
    command: SCRIPT_PATH,
    padding: 1,
  };
  writeClaudeSettings(settings);
}

/**
 * Disable the statusline: remove config from Claude settings.json + remove script
 */
export function disableStatusLine(): void {
  const settings = readClaudeSettings();
  delete settings.statusLine;
  writeClaudeSettings(settings);

  removeScript();

  // Remove cached rate-limits data so Usage page no longer shows stale quota
  const rateLimitsFile = dataPath('rate-limits.json');
  if (fs.existsSync(rateLimitsFile)) {
    fs.unlinkSync(rateLimitsFile);
  }
}

/**
 * Check if statusline is currently configured in Claude settings.json
 */
export function isStatusLineConfigured(): boolean {
  const settings = readClaudeSettings();
  return settings.statusLine != null;
}
