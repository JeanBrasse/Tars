import { describe, it, expect } from 'vitest';
import * as path from 'path';
import * as os from 'os';

/**
 * Which files the Telegram MCP server will send.
 *
 * The original hole was that this server bypasses the app's own HTTP routes, so
 * an agent could name any absolute path and any chat id, and one
 * `send_telegram_document` call moved every API key into a chat. That was
 * closed with a home-directory bound and a list of blocked directories.
 *
 * The list was checked only against `~/<name>`, so it covered `~/.env` and
 * nothing else. Tars runs agents inside cloned project directories, which is
 * exactly where a real `.env` lives, so `~/some-project/.env` walked straight
 * past the guard written to stop it. The check now looks at every segment.
 */

const BLOCKED_DIRS = [
  '.ssh', '.gnupg', '.aws', '.claude', '.dorothy', '.config',
  '.kube', '.docker',
];

const BLOCKED_NAMES = new Set([
  '.env', '.netrc', '.git-credentials', '.npmrc', '.pypirc',
  'credentials', 'credentials.json', 'id_rsa', 'id_ed25519', '.pgpass',
]);

function isBlockedName(name: string): boolean {
  const lower = name.toLowerCase();
  return BLOCKED_NAMES.has(lower) || lower.startsWith('.env.');
}

/** Mirrors assertSendablePath in mcp-telegram/src/index.ts. */
function assertSendablePath(filePath: string): string {
  const resolved = path.resolve(filePath);
  const home = os.homedir();

  if (resolved !== home && !resolved.startsWith(home + path.sep)) {
    throw new Error(`Refused: ${resolved} is outside the home directory`);
  }
  for (const dir of BLOCKED_DIRS) {
    const blocked = path.join(home, dir);
    if (resolved === blocked || resolved.startsWith(blocked + path.sep)) {
      throw new Error(`Refused: ${dir} holds credentials and cannot be sent`);
    }
  }
  for (const segment of resolved.slice(home.length).split(path.sep)) {
    if (!segment) continue;
    if (isBlockedName(segment) || BLOCKED_DIRS.includes(segment)) {
      throw new Error(`Refused: ${segment} holds credentials and cannot be sent`);
    }
  }
  return resolved;
}

const HOME = os.homedir();
const refuses = (p: string) => expect(() => assertSendablePath(p)).toThrow(/Refused/);

describe('what the Telegram server will send', () => {
  it('refuses anything outside the home directory', () => {
    refuses('/etc/passwd');
    refuses('/var/root/.ssh/id_rsa');
    refuses(path.join(HOME, '..', 'someone-else', 'notes.md'));
  });

  it('refuses the credential directories at the top level', () => {
    for (const dir of BLOCKED_DIRS) {
      refuses(path.join(HOME, dir, 'anything'));
    }
    refuses(path.join(HOME, '.dorothy', 'app-settings.json'));
  });

  it('refuses a project .env, which is the case the first fix missed', () => {
    refuses(path.join(HOME, 'Dorothy-fix', '.env'));
    refuses(path.join(HOME, 'work', 'client', 'api', '.env'));
  });

  it('refuses the suffixed variants of it', () => {
    refuses(path.join(HOME, 'proj', '.env.local'));
    refuses(path.join(HOME, 'proj', '.env.production'));
    refuses(path.join(HOME, 'proj', '.ENV'));
  });

  it('refuses a credential directory nested inside a project', () => {
    refuses(path.join(HOME, 'proj', 'infra', '.ssh', 'id_rsa'));
    refuses(path.join(HOME, 'proj', 'deploy', '.aws', 'credentials'));
  });

  it('refuses the usual key and credential filenames at any depth', () => {
    refuses(path.join(HOME, 'proj', 'keys', 'id_ed25519'));
    refuses(path.join(HOME, 'proj', 'gcp', 'credentials.json'));
    refuses(path.join(HOME, 'proj', '.npmrc'));
  });

  it('refuses a traversal that lands on a blocked path', () => {
    refuses(path.join(HOME, 'proj', '..', '.dorothy', 'api-token'));
  });

  it('still sends the ordinary files this tool exists for', () => {
    const ok = [
      path.join(HOME, 'proj', 'README.md'),
      path.join(HOME, 'proj', 'report.pdf'),
      path.join(HOME, 'Desktop', 'screenshot.png'),
      path.join(HOME, 'proj', 'src', 'environment.ts'),
      path.join(HOME, 'proj', 'docs', 'credentials-policy.md'),
    ];
    for (const p of ok) expect(assertSendablePath(p)).toBe(path.resolve(p));
  });
});
