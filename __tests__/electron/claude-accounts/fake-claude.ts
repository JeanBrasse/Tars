import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

/**
 * A stand-in for the claude binary's `auth` commands, so no test ever reaches a
 * real login. Signed in = a marker file holding the e-mail, in the directory
 * CLAUDE_CONFIG_DIR names (or ~/.claude without it), which is where the real
 * one keeps its state. Every call is logged with the CLAUDE_CONFIG_DIR it saw
 * ('<unset>' when absent) and CLAUDE_SECURESTORAGE_CONFIG_DIR, so a test can
 * tell which directory each command was aimed at.
 * Shapes copied from claude 2.1.283's `auth status` (exit 0 signed in, 1 not).
 */
export interface FakeClaude { bin: string; log: string; calls: () => string[] }

export function makeFakeClaude(): FakeClaude {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fake-claude-'));
  const bin = path.join(dir, 'claude');
  const log = path.join(dir, 'calls.log');
  fs.writeFileSync(bin, `#!/bin/bash
printf '%s|%s|%s\\n' "\${CLAUDE_CONFIG_DIR-<unset>}" "\${CLAUDE_SECURESTORAGE_CONFIG_DIR-<unset>}" "$*" >> '${log}'
d="\${CLAUDE_CONFIG_DIR:-$HOME/.claude}"
case "$1 $2" in
  "auth status")
    if [ -f "$d/.fake-signed-in" ]; then
      printf '{\\n  "loggedIn": true,\\n  "authMethod": "claude.ai",\\n  "configDirectory": "%s",\\n  "email": "%s",\\n  "orgId": "org-1",\\n  "orgName": "Someone Org",\\n  "subscriptionType": "max"\\n}\\n' "$d" "$(cat "$d/.fake-signed-in")"
      exit 0
    fi
    [ -f "$d/.fake-broken" ] && { echo "not json"; exit 1; }
    printf '{\\n  "loggedIn": false,\\n  "authMethod": "none",\\n  "configDirectory": "%s"\\n}\\n' "$d"
    exit 1;;
  "auth logout")
    [ -f "$d/.fake-logout-fails" ] && { echo "Failed to log out" >&2; exit 1; }
    # Measured on 2.1.285: a logout in a folder that is gone makes it again,
    # 0755, with a .claude.json of its own.
    [ -d "$d" ] || { mkdir -p "$d"; chmod 755 "$d"; echo '{}' > "$d/.claude.json"; }
    rm -f "$d/.fake-signed-in"; echo "Successfully logged out from your Anthropic account."; exit 0;;
  "auth login")
    echo "Opening browser to sign in"; exit 0;;
esac
exit 2
`, { mode: 0o755 });
  return { bin, log, calls: () => (fs.existsSync(log) ? fs.readFileSync(log, 'utf-8').trim().split('\n').filter(Boolean) : []) };
}

/** What the real `claude auth login` leaves behind, for the fake. */
export function signIn(configDir: string, email: string): void {
  fs.mkdirSync(configDir, { recursive: true });
  fs.writeFileSync(path.join(configDir, '.fake-signed-in'), email);
}
