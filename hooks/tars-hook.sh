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
#
# Sent only to the Tars that spawned the CLI (the Audit's table, #11). While
# Tars is down any process of any account may hold its port, and got every
# token posted to it. So the port is asked first to prove it knows this
# CLI's TARS_INSTANCE_ID: a fresh random challenge goes to /api/health, and
# the answer must be sha256("<id>:<challenge>"). The id itself never leaves.
# No id, no answer within 2 s, or a wrong one: no token, and the post is
# refused as if it had none. Asked once, here, as the hook starts: tars_auth
# runs in a subshell of its own for each post, where nothing it learnt would
# be kept.
TARS_TOKEN_OK=no
if [ -n "${CLAUDE_MGR_API_TOKEN:-}" ] && [ -n "${TARS_INSTANCE_ID:-}" ]; then
  tars_challenge=$(od -An -tx1 -N16 /dev/urandom 2>/dev/null | tr -d ' \n')
  if [ ${#tars_challenge} -eq 32 ]; then
    tars_proof=$(curl -s --max-time 2 "${CLAUDE_MGR_API_URL:-http://127.0.0.1:31415}/api/health?challenge=$tars_challenge" 2>/dev/null \
      | jq -r '.proof // empty' 2>/dev/null)
    if command -v sha256sum >/dev/null 2>&1; then
      tars_expected=$(printf '%s' "$TARS_INSTANCE_ID:$tars_challenge" | sha256sum | cut -d' ' -f1)
    else
      tars_expected=$(printf '%s' "$TARS_INSTANCE_ID:$tars_challenge" | shasum -a 256 | cut -d' ' -f1)
    fi
    if [ -n "$tars_proof" ] && [ "$tars_proof" = "$tars_expected" ]; then TARS_TOKEN_OK=yes; fi
  fi
  unset tars_challenge tars_proof tars_expected
fi
tars_auth() {
  if [ "$TARS_TOKEN_OK" = yes ]; then printf "Authorization: Bearer %s" "$CLAUDE_MGR_API_TOKEN"; fi
}
