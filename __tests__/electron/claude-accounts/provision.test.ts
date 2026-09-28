/**
 * Setting an account's directory up (electron/services/claude-accounts/provision.ts).
 *
 * Measured on claude 2.1.283 (DESIGN-COMPTES-CLAUDE.md, A): with CLAUDE_CONFIG_DIR
 * set, transcripts, the agents' memory, CLAUDE.md, skills and agents are read
 * from that directory, symbolic links followed; settings.json (hooks, status
 * line) and .claude.json (MCP servers, trust, onboarding) too.
 *
 * What goes wrong if it is wrong, first:
 * - transcripts split per account: Usage, the Chat, resume and every agent's
 *   memory read ~/.claude/projects, and `--resume` from another account says
 *   "No conversation found" unless projects/ is shared. So projects/ is a link to
 *   ~/.claude/projects, created even when that folder does not exist yet;
 * - an account without Tars's hooks or status line: its agents never report a
 *   status. settings.json is a copy of ~/.claude/settings.json, the source;
 * - an account without the MCP servers the user and Tars registered in
 *   ~/.claude.json, or stopped on first-run screens;
 * - Tars reading a credential: nothing here opens .credentials.json, lists the
 *   directory, or touches any key of the account's .claude.json but the ones it
 *   mirrors (oauthAccount is the account's own);
 * - user data destroyed: something real where a link should be is left alone
 *   and reported, never removed;
 * - a directory other users can read (Linux keeps the credential in it).
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { provisionAccountDir, SHARED_ENTRIES } from '../../../electron/services/claude-accounts/provision';

let home: string;
let claudeDir: string;
let dir: string;
let n = 0;

beforeEach(() => {
  home = fs.realpathSync(os.homedir());
  claudeDir = path.join(home, '.claude');
  dir = path.join(home, '.claude-accounts', `acct-00000${n++}`);
});

function readJson(file: string): Record<string, unknown> {
  return JSON.parse(fs.readFileSync(file, 'utf-8'));
}

describe('the directory', () => {
  it('is created owner-only, and narrowed if it already existed wider', () => {
    provisionAccountDir(dir, home);
    expect(fs.statSync(dir).mode & 0o777).toBe(0o700);
    fs.chmodSync(dir, 0o755);
    provisionAccountDir(dir, home);
    expect(fs.statSync(dir).mode & 0o777).toBe(0o700);
  });

  it('refuses a relative directory', () => {
    expect(() => provisionAccountDir('relative/acct', home)).toThrow();
  });
});

describe('what is shared through links', () => {
  it('links projects/ to ~/.claude/projects, creating it when it is missing', () => {
    if (fs.existsSync(path.join(claudeDir, 'projects'))) fs.rmSync(path.join(claudeDir, 'projects'), { recursive: true });
    provisionAccountDir(dir, home);
    const link = path.join(dir, 'projects');
    expect(fs.lstatSync(link).isSymbolicLink()).toBe(true);
    expect(fs.readlinkSync(link)).toBe(path.join(claudeDir, 'projects'));
    expect(fs.statSync(path.join(claudeDir, 'projects')).isDirectory()).toBe(true);
  });

  it('a transcript written through the account lands in ~/.claude/projects', () => {
    provisionAccountDir(dir, home);
    const rel = path.join('projects', '-Users-someone-app', 'abc.jsonl');
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), '{}\n');
    expect(fs.readFileSync(path.join(claudeDir, rel), 'utf-8')).toBe('{}\n');
  });

  it('links CLAUDE.md, skills, agents, commands, plugins and output-styles when ~/.claude has them', () => {
    fs.mkdirSync(claudeDir, { recursive: true });
    fs.writeFileSync(path.join(claudeDir, 'CLAUDE.md'), 'mine');
    for (const d of ['skills', 'agents', 'commands', 'plugins', 'output-styles']) fs.mkdirSync(path.join(claudeDir, d), { recursive: true });
    provisionAccountDir(dir, home);
    for (const name of SHARED_ENTRIES) {
      expect(fs.readlinkSync(path.join(dir, name))).toBe(path.join(claudeDir, name));
    }
    expect(fs.readFileSync(path.join(dir, 'CLAUDE.md'), 'utf-8')).toBe('mine');
  });

  it('adds a link later, once ~/.claude has the thing', () => {
    const skills = path.join(claudeDir, 'skills');
    if (fs.existsSync(skills)) fs.rmSync(skills, { recursive: true });
    provisionAccountDir(dir, home);
    expect(fs.existsSync(path.join(dir, 'skills'))).toBe(false);
    fs.mkdirSync(skills, { recursive: true });
    provisionAccountDir(dir, home);
    expect(fs.readlinkSync(path.join(dir, 'skills'))).toBe(skills);
  });

  it('leaves something real where a link should be, and reports it', () => {
    fs.mkdirSync(path.join(claudeDir, 'agents'), { recursive: true });
    fs.mkdirSync(path.join(dir, 'agents'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'agents', 'keep.md'), 'keep');
    const report = provisionAccountDir(dir, home);
    expect(fs.readFileSync(path.join(dir, 'agents', 'keep.md'), 'utf-8')).toBe('keep');
    expect(report.conflicts).toContain('agents');
  });

  it('repoints a link of its own that points elsewhere', () => {
    fs.mkdirSync(dir, { recursive: true });
    fs.symlinkSync('/nowhere', path.join(dir, 'projects'));
    provisionAccountDir(dir, home);
    expect(fs.readlinkSync(path.join(dir, 'projects'))).toBe(path.join(claudeDir, 'projects'));
  });
});

describe('settings.json, a copy of ~/.claude/settings.json', () => {
  it('copies it byte for byte, hooks and status line included, and again when it changes', () => {
    fs.mkdirSync(claudeDir, { recursive: true });
    const first = JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: 'command', command: '/x/on-stop.sh' }] }] }, statusLine: { type: 'command', command: '/x/statusline.sh' } }, null, 2);
    fs.writeFileSync(path.join(claudeDir, 'settings.json'), first);
    provisionAccountDir(dir, home);
    expect(fs.readFileSync(path.join(dir, 'settings.json'), 'utf-8')).toBe(first);
    expect(fs.lstatSync(path.join(dir, 'settings.json')).isSymbolicLink()).toBe(false);

    const second = first.replace('on-stop', 'on-stop-2');
    fs.writeFileSync(path.join(claudeDir, 'settings.json'), second);
    provisionAccountDir(dir, home);
    expect(fs.readFileSync(path.join(dir, 'settings.json'), 'utf-8')).toBe(second);
  });

  it('writes none when ~/.claude/settings.json does not exist', () => {
    const src = path.join(claudeDir, 'settings.json');
    if (fs.existsSync(src)) fs.unlinkSync(src);
    provisionAccountDir(dir, home);
    expect(fs.existsSync(path.join(dir, 'settings.json'))).toBe(false);
  });
});

describe(".claude.json, the account's own", () => {
  it('gets onboarding done, and mcpServers and theme mirrored from ~/.claude.json', () => {
    fs.writeFileSync(path.join(home, '.claude.json'), JSON.stringify({
      mcpServers: { mem: { type: 'http', url: 'http://127.0.0.1:1/mcp' } },
      theme: 'dark',
      oauthAccount: { emailAddress: 'someone@example.com' },
      projects: { '/p': { hasTrustDialogAccepted: true } },
    }));
    provisionAccountDir(dir, home);
    const own = readJson(path.join(dir, '.claude.json'));
    expect(own.hasCompletedOnboarding).toBe(true);
    expect(own.mcpServers).toEqual({ mem: { type: 'http', url: 'http://127.0.0.1:1/mcp' } });
    expect(own.theme).toBe('dark');
    // Account 1's identity and trust are not the account's: never carried over.
    expect(own.oauthAccount).toBeUndefined();
    expect(own.projects).toBeUndefined();
    expect(fs.statSync(path.join(dir, '.claude.json')).mode & 0o777).toBe(0o600);
  });

  it("keeps every key of the account's own it does not mirror, and follows a removed server", () => {
    fs.writeFileSync(path.join(home, '.claude.json'), JSON.stringify({ mcpServers: { a: { command: 'a' }, b: { command: 'b' } } }));
    provisionAccountDir(dir, home);
    const file = path.join(dir, '.claude.json');
    fs.writeFileSync(file, JSON.stringify({ ...readJson(file), oauthAccount: { emailAddress: 'two@example.com' }, userID: 'u2' }));
    fs.writeFileSync(path.join(home, '.claude.json'), JSON.stringify({ mcpServers: { a: { command: 'a' } } }));
    provisionAccountDir(dir, home);
    const own = readJson(file);
    expect(own.oauthAccount).toEqual({ emailAddress: 'two@example.com' });
    expect(own.userID).toBe('u2');
    expect(own.mcpServers).toEqual({ a: { command: 'a' } });
  });

  it("leaves the account's file alone when ~/.claude.json does not parse", () => {
    provisionAccountDir(dir, home);
    const file = path.join(dir, '.claude.json');
    fs.writeFileSync(file, JSON.stringify({ mcpServers: { keep: { command: 'k' } }, hasCompletedOnboarding: true }));
    fs.writeFileSync(path.join(home, '.claude.json'), '{ broken');
    provisionAccountDir(dir, home);
    expect(readJson(file).mcpServers).toEqual({ keep: { command: 'k' } });
  });
});

describe('credentials', () => {
  it('never opens, stats or lists anything in the directory but the files it owns', () => {
    provisionAccountDir(dir, home);
    fs.writeFileSync(path.join(dir, '.credentials.json'), '{"claudeAiOauth":{"accessToken":"trap"}}', { mode: 0o600 });
    const names = ['readFileSync', 'openSync', 'readdirSync', 'statSync', 'lstatSync', 'existsSync', 'copyFileSync', 'createReadStream', 'readlinkSync', 'realpathSync'] as const;
    const touched: { fn: string; p: string }[] = [];
    const spies = names.map((fn) => {
      const original = (fs as unknown as Record<string, (...a: unknown[]) => unknown>)[fn].bind(fs);
      return vi.spyOn(fs as never, fn as never).mockImplementation(((...args: unknown[]) => {
        if (typeof args[0] === 'string') touched.push({ fn, p: args[0] });
        return original(...args);
      }) as never);
    });
    try {
      provisionAccountDir(dir, home);
    } finally {
      spies.forEach(s => s.mockRestore());
    }
    expect(touched.length).toBeGreaterThan(0);
    expect(touched.filter(t => t.p.includes('.credentials'))).toEqual([]);
    expect(touched.filter(t => t.fn === 'readdirSync' && t.p.startsWith(dir))).toEqual([]);
  });
});
