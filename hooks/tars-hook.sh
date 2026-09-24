#!/bin/bash
# Sourced by every Tars hook: where it logs, and the credential it presents.
#
# The logs were /tmp/dorothy-hooks.log and /tmp/dorothy-hooks-debug.log,
# readable by every user of the machine and shared by every Tars on it, a
# sandbox's included. They carry session ids and task text. They live in the
# data folder of the Tars that owns the CLI now, readable by its user only.
TARS_LOG_DIR="$HOME/.dorothy/logs"
umask 077
mkdir -p "$TARS_LOG_DIR" 2>/dev/null
HOOK_LOG="$TARS_LOG_DIR/hooks.log"
HOOK_DEBUG_LOG="$TARS_LOG_DIR/hooks-debug.log"

# The token of this CLI's own terminal, minted by Tars when it spawned it and
# passed in its environment. The hook routes take it and nothing else: a post
# names the agent it is from, and the token proves it. Printed into a header
# through a process substitution, so it never appears in curl's argv.
tars_auth() { printf "Authorization: Bearer %s" "${CLAUDE_MGR_API_TOKEN:-}"; }
