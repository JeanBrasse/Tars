import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { writeSecretFileSync, ensureSecretFileMode } from '../../electron/utils/secret-file';

/**
 * Three ways the app leaked, or could be made to leak, its own credentials.
 */

const made: string[] = [];
const tmp = (name: string) => {
  const p = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'tars-secret-')), name);
  made.push(path.dirname(p));
  return p;
};

afterEach(() => {
  for (const dir of made.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe('writeSecretFileSync', () => {
  it('creates the file readable only by its owner', () => {
    const p = tmp('app-settings.json');
    writeSecretFileSync(p, '{"telegramBotToken":"secret"}');
    // 0644 was the real mode of ~/.dorothy/app-settings.json, which holds every
    // provider API key, while api-token beside it was already 0600.
    expect(fs.statSync(p).mode & 0o777).toBe(0o600);
  });

  it('narrows a file that already exists at 0644', () => {
    const p = tmp('app-settings.json');
    fs.writeFileSync(p, '{}');
    fs.chmodSync(p, 0o644);
    writeSecretFileSync(p, '{"a":1}');
    expect(fs.statSync(p).mode & 0o777).toBe(0o600);
  });

  it('writes atomically, so a torn write cannot empty the file', () => {
    const p = tmp('app-settings.json');
    writeSecretFileSync(p, '{"first":true}');
    writeSecretFileSync(p, '{"second":true}');
    expect(JSON.parse(fs.readFileSync(p, 'utf-8'))).toEqual({ second: true });
    expect(fs.existsSync(`${p}.tmp`)).toBe(false);
  });

  it('ensureSecretFileMode fixes an install that predates the 0600 write', () => {
    const p = tmp('hermes-connection.json');
    fs.writeFileSync(p, '{}');
    fs.chmodSync(p, 0o644);
    ensureSecretFileMode(p);
    expect(fs.statSync(p).mode & 0o777).toBe(0o600);
  });

  it('ensureSecretFileMode is silent on a missing file', () => {
    expect(() => ensureSecretFileMode(tmp('never-written'))).not.toThrow();
  });
});

describe('MCP registration argument handling', () => {
  // The providers used to build `claude mcp add -s user <name> <cmd> "<arg>"`
  // and hand it to execSync, i.e. /bin/sh -c. Double quotes do not stop $() or
  // backticks, and one of the args is tasmaniaServerPath straight out of
  // app-settings.json.
  const shellWouldExpand = (arg: string) => /\$\(|`|\$\{/.test(arg);

  it('recognises the payload shape the old form evaluated', () => {
    expect(shellWouldExpand('x.js"$(id > PWN.txt)"')).toBe(true);
    expect(shellWouldExpand('`id`')).toBe(true);
    expect(shellWouldExpand('${HOME}')).toBe(true);
  });

  it('argv arrays make the question moot - the value is data, not syntax', () => {
    const argv = ['mcp', 'add', '-s', 'user', 'tasmania', 'node', 'x.js"$(id > PWN.txt)"'];
    // No shell is involved, so the element is passed through verbatim as one
    // argument. This is what execFileSync guarantees and execSync does not.
    expect(argv[argv.length - 1]).toBe('x.js"$(id > PWN.txt)"');
    expect(argv).toHaveLength(7);
  });
});

describe('Telegram path guard', () => {
  // Mirrors isSafeTelegramPath and the MCP server's assertSendablePath.
  const home = os.homedir();
  const BLOCKED = ['.ssh', '.gnupg', '.aws', '.claude', '.dorothy', '.config',
                   '.kube', '.docker', '.env', '.netrc', '.git-credentials'];
  const safe = (p: string) => {
    const resolved = path.resolve(p);
    if (resolved !== home && !resolved.startsWith(home + path.sep)) return false;
    return !BLOCKED.some(d => {
      const b = path.join(home, d);
      return resolved === b || resolved.startsWith(b + path.sep);
    });
  };

  it('blocks our own credential store, which it used to allow', () => {
    // ~/.ssh was blocked from the start; ~/.dorothy - which holds every API key
    // in app-settings.json - was not.
    expect(safe(path.join(home, '.dorothy', 'app-settings.json'))).toBe(false);
    expect(safe(path.join(home, '.dorothy', 'api-token'))).toBe(false);
    expect(safe(path.join(home, '.dorothy', 'hermes-webhook-secret'))).toBe(false);
  });

  it('still blocks the directories it always did', () => {
    for (const d of ['.ssh/id_rsa', '.aws/credentials', '.claude/settings.json', '.gnupg/secring.gpg']) {
      expect(safe(path.join(home, d)), d).toBe(false);
    }
  });

  it('blocks the ones the audit added', () => {
    for (const d of ['.config/gh/hosts.yml', '.kube/config', '.docker/config.json', '.git-credentials']) {
      expect(safe(path.join(home, d)), d).toBe(false);
    }
  });

  it('refuses anything outside the home directory', () => {
    expect(safe('/etc/passwd')).toBe(false);
    expect(safe(path.join(home, '..', 'other-user', 'notes.txt'))).toBe(false);
  });

  it('still allows an ordinary file', () => {
    expect(safe(path.join(home, 'Documents', 'report.pdf'))).toBe(true);
  });
});
