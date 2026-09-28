/**
 * The environment an agent's CLI starts with, per account
 * (electron/services/claude-accounts/launch.ts), DESIGN-COMPTES-CLAUDE.md B3.
 *
 * What goes wrong if it is wrong, first:
 * - anything at all changes while the option is off: no account, no variable;
 * - an agent of another provider (the thirteen that point the claude binary at
 *   another vendor, local, codex…) given an account;
 * - account 1 launched with a CLAUDE_CONFIG_DIR, a CLAUDE_SECURESTORAGE_CONFIG_DIR
 *   or a TARS_CLAUDE_ACCOUNT Tars inherited: measured, CLAUDE_CONFIG_DIR=~/.claude
 *   is another login. Account 1 is launched with them removed and names itself
 *   `default` to its status line;
 * - an account launched in a folder not provisioned for this project: no hooks,
 *   or the trust and approvals dialogs (B1). Provisioned at each launch, with
 *   the working directory's projects[] entry;
 * - a folder that fails its checks (B2), or a credential that makes every
 *   folder one account (B3): the agent starts on account 1, it is not stopped;
 * - the choice not remembered: agent.claudeAccountId is what the card shows and
 *   what the next relaunch keeps;
 * - several agents launched at once all counted as nowhere (N5): a choice is
 *   counted for 60 s, until the agent's terminal is there to be counted.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { claudeAccountEnvFor, ACCOUNT_ENV_UNSET } from '../../../electron/services/claude-accounts/launch';
import { setAuth, resetAccountState } from '../../../electron/services/claude-accounts/state';
import { accountsRoot, normalizeAccountsSettings } from '../../../electron/services/claude-accounts/registry';
import type { AgentStatus, ClaudeAccountsSettings } from '../../../electron/types';

const home = () => fs.realpathSync(os.homedir());
const A = 'acct-aaaaaa';
const B = 'acct-bbbbbb';

function settings(over: Partial<ClaudeAccountsSettings> = {}): ClaudeAccountsSettings {
  return {
    ...normalizeAccountsSettings({
      enabled: true,
      accounts: [{ id: 'default', label: 'Account 1', enabled: true }, { id: A, label: 'Max two', enabled: true }, { id: B, label: 'Max three', enabled: true }],
    }),
    ...over,
  };
}

function agent(over: Partial<AgentStatus> = {}): AgentStatus {
  return { id: `ag-${Math.random().toString(16).slice(2, 8)}`, status: 'idle', projectPath: project, skills: [], output: [], lastActivity: '', provider: 'claude', ...over } as AgentStatus;
}

let project: string;
const NOW = Date.UTC(2026, 8, 28, 20, 0, 0);
const S = (ms: number) => Math.floor(ms / 1000);
const full = { fiveHour: { usedPercentage: 99, resetsAt: S(NOW) + 3600 }, sevenDay: { usedPercentage: 10, resetsAt: S(NOW) + 86400 }, updatedAt: NOW };
const light = (p: number) => ({ fiveHour: { usedPercentage: p, resetsAt: S(NOW) + 3600 }, sevenDay: { usedPercentage: p, resetsAt: S(NOW) + 86400 }, updatedAt: NOW });

beforeEach(() => {
  resetAccountState();
  project = fs.mkdtempSync(path.join(home(), 'project-'));
  fs.writeFileSync(path.join(home(), '.claude.json'), JSON.stringify({
    bypassPermissionsModeAccepted: true,
    projects: { [project]: { hasTrustDialogAccepted: true, enabledMcpjsonServers: ['s'] } },
  }));
  fs.mkdirSync(path.join(home(), '.claude'), { recursive: true });
  fs.writeFileSync(path.join(home(), '.claude', 'settings.json'), '{}');
  for (const id of ['default', A, B]) setAuth(id, { signedIn: true, email: `${id}@example.com`, subscriptionType: 'max', error: null });
});

const ctx = (over: Record<string, unknown> = {}) => ({ agents: [] as AgentStatus[], cwd: project, now: NOW, settings: settings(), usage: {}, overrides: [] as string[], ...over });

describe('with the option off', () => {
  it('gives nothing, so the launch is what it was', () => {
    expect(claudeAccountEnvFor(agent(), ctx({ settings: settings({ enabled: false }) }))).toBeNull();
  });
});

describe('other providers', () => {
  it.each(['openrouter', 'deepseek', 'local', 'codex', 'gemini'])('gives %s nothing', (provider) => {
    expect(claudeAccountEnvFor(agent({ provider: provider as never }), ctx())).toBeNull();
  });
});

describe('account 1', () => {
  it('is launched with the account variables removed, and names itself to its status line', () => {
    const a = agent();
    const env = claudeAccountEnvFor(a, ctx({ usage: { [A]: full, [B]: full } }))!;
    expect(env.accountId).toBe('default');
    expect(env.set).toEqual({ TARS_CLAUDE_ACCOUNT: 'default' });
    expect(env.unset).toEqual(expect.arrayContaining(['CLAUDE_CONFIG_DIR', 'CLAUDE_SECURESTORAGE_CONFIG_DIR']));
    expect(ACCOUNT_ENV_UNSET).toEqual(expect.arrayContaining(['CLAUDE_CONFIG_DIR', 'CLAUDE_SECURESTORAGE_CONFIG_DIR', 'TARS_CLAUDE_ACCOUNT']));
    expect(a.claudeAccountId).toBe('default');
  });
});

describe('another account', () => {
  it('is provisioned for the working directory, then named in the environment', () => {
    const a = agent();
    const env = claudeAccountEnvFor(a, ctx({ usage: { default: full, [B]: full } }))!;
    const dir = path.join(accountsRoot(), A);
    expect(env).toEqual({ accountId: A, set: { CLAUDE_CONFIG_DIR: dir, TARS_CLAUDE_ACCOUNT: A }, unset: ['CLAUDE_SECURESTORAGE_CONFIG_DIR'] });
    expect(a.claudeAccountId).toBe(A);
    const own = JSON.parse(fs.readFileSync(path.join(dir, '.claude.json'), 'utf-8'));
    expect(own.projects[project]).toEqual({ hasTrustDialogAccepted: true, enabledMcpjsonServers: ['s'] });
    expect(own.bypassPermissionsModeAccepted).toBe(true);
    expect(fs.readlinkSync(path.join(dir, 'projects'))).toBe(path.join(home(), '.claude', 'projects'));
  });

  it('follows the pin', () => {
    const env = claudeAccountEnvFor(agent({ claudeAccountPin: B }), ctx())!;
    expect(env.accountId).toBe(B);
  });

  it('falls back to account 1 when the folder fails its checks, and leaves the folder as it is', () => {
    const dir = path.join(accountsRoot(), A);
    fs.mkdirSync(path.dirname(dir), { recursive: true, mode: 0o700 });
    fs.mkdirSync(dir, { recursive: true });
    fs.chmodSync(dir, 0o755);
    const a = agent({ claudeAccountPin: A });
    const env = claudeAccountEnvFor(a, ctx())!;
    expect(env.accountId).toBe('default');
    expect(a.claudeAccountId).toBe('default');
    expect(fs.statSync(dir).mode & 0o777).toBe(0o755);
    expect(fs.existsSync(path.join(dir, 'settings.json'))).toBe(false);
    fs.chmodSync(dir, 0o700);
  });

  it('falls back to account 1 while a credential would sign every folder in as one', () => {
    const env = claudeAccountEnvFor(agent({ claudeAccountPin: A }), ctx({ overrides: ['ANTHROPIC_API_KEY in the environment Tars was started with'] }))!;
    expect(env.accountId).toBe('default');
  });
});

describe('counting agents that are moving', () => {
  it('counts a choice made a moment ago, so agents launched together spread out', () => {
    const usage = { default: light(10), [A]: light(11), [B]: light(60) };
    const first = agent();
    const second = agent();
    expect(claudeAccountEnvFor(first, ctx({ usage }))!.accountId).toBe('default');
    // `first` has no terminal yet, but its choice counts.
    expect(claudeAccountEnvFor(second, ctx({ usage, agents: [first] }))!.accountId).toBe(A);
  });

  it('forgets such a choice after 60 s', () => {
    const usage = { default: light(10), [A]: light(11), [B]: light(60) };
    const first = agent();
    claudeAccountEnvFor(first, ctx({ usage }));
    expect(claudeAccountEnvFor(agent(), ctx({ usage, now: NOW + 61_000 }))!.accountId).toBe('default');
  });
});
