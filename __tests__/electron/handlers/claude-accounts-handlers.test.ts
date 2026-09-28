/**
 * The Settings contract for Claude accounts (electron/handlers/claude-accounts-handlers.ts),
 * DESIGN-COMPTES-CLAUDE.md B6, driven through the channels the renderer calls.
 *
 * What goes wrong if it is wrong, first:
 * - a channel of the contract missing: the Settings page calls into nothing;
 * - adding an account that cannot be used: no directory, no link to the shared
 *   transcripts, not saved;
 * - the login terminal aimed at the wrong directory (or at account 1 with
 *   CLAUDE_CONFIG_DIR=~/.claude, which is another login), run through a shell,
 *   or not refreshing the account once it closes;
 * - the same Claude account added twice (Noah: refused). The second directory is
 *   signed out again, by Claude Code, and the page says which account has it;
 * - removing an account leaving a signed-in keychain item behind: the logout
 *   runs first, and a failed logout keeps the account and its directory;
 * - account 1 removed;
 * - an agent pinned to an account that no longer exists;
 * - bad input (labels, thresholds, orders, ids) saved, or thrown at the renderer
 *   instead of answered with a sentence;
 * - a change the page does not hear about (claude-accounts:changed).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { makeFakeClaude, signIn, type FakeClaude } from '../claude-accounts/fake-claude';

const { handlers, broadcasts, spawned, trashed } = vi.hoisted(() => ({
  handlers: new Map<string, (...args: unknown[]) => Promise<unknown>>(),
  broadcasts: [] as { channel: string; payload: unknown }[],
  spawned: [] as {
    file: string; args: string[]; opts: { env: Record<string, string | undefined>; cwd?: string };
    data: ((d: string) => void)[]; exit: ((e: { exitCode: number }) => void)[]; killed: boolean; written: string[];
  }[],
  trashed: [] as string[],
}));

vi.mock('electron', () => ({
  ipcMain: { handle: vi.fn((channel: string, fn: (...args: unknown[]) => Promise<unknown>) => { handlers.set(channel, fn); }) },
  shell: { trashItem: vi.fn(async (p: string) => { trashed.push(p); }) },
}));

vi.mock('node-pty', () => ({
  spawn: vi.fn((file: string, args: string[], opts: { env: Record<string, string | undefined> }) => {
    const p = { file, args, opts, data: [] as ((d: string) => void)[], exit: [] as ((e: { exitCode: number }) => void)[], killed: false, written: [] as string[] };
    spawned.push(p);
    return {
      onData: (cb: (d: string) => void) => { p.data.push(cb); return { dispose() {} }; },
      onExit: (cb: (e: { exitCode: number }) => void) => { p.exit.push(cb); return { dispose() {} }; },
      write: (d: string) => { p.written.push(d); },
      resize: () => {},
      kill: () => { p.killed = true; },
      pid: 1,
    };
  }),
}));

vi.mock('../../../electron/utils/broadcast', () => ({
  broadcastToAllWindows: (channel: string, payload: unknown) => { broadcasts.push({ channel, payload }); },
}));

import { registerClaudeAccountsHandlers, CLAUDE_ACCOUNTS_CHANNELS } from '../../../electron/handlers/claude-accounts-handlers';
import { accountsFile } from '../../../electron/services/claude-accounts/registry';
import type { ClaudeAccountsView, ClaudeAccountState } from '../../../electron/types';

let fake: FakeClaude;
let agents: Map<string, Record<string, unknown>>;
let saves: number;
let loginPtys: Map<string, unknown>;

function call<T = Record<string, unknown>>(channel: string, arg?: unknown): Promise<T> {
  const h = handlers.get(channel);
  if (!h) throw new Error(`${channel} is not registered`);
  return h({}, arg) as Promise<T>;
}

async function view(): Promise<ClaudeAccountsView> {
  const r = await call<{ success: boolean } & ClaudeAccountsView>('claude-accounts:list');
  expect(r.success).toBe(true);
  return r;
}

function lastChanged(): ClaudeAccountsView {
  const c = broadcasts.filter(b => b.channel === 'claude-accounts:changed').at(-1);
  if (!c) throw new Error('no claude-accounts:changed broadcast');
  return c.payload as ClaudeAccountsView;
}

async function add(label: string): Promise<ClaudeAccountState> {
  const r = await call<{ success: boolean; account: ClaudeAccountState; error?: string }>('claude-accounts:add', { label });
  expect(r.error).toBeUndefined();
  return r.account;
}

/** Waits for an asynchronous refresh the handler started to reach the page. */
async function settle(): Promise<void> {
  for (let i = 0; i < 50; i++) await new Promise(r => setTimeout(r, 10));
}

beforeEach(() => {
  handlers.clear();
  broadcasts.length = 0;
  spawned.length = 0;
  trashed.length = 0;
  if (fs.existsSync(accountsFile())) fs.unlinkSync(accountsFile());
  fake = makeFakeClaude();
  agents = new Map();
  saves = 0;
  loginPtys = new Map();
  registerClaudeAccountsHandlers({
    getAppSettings: () => ({ cliPaths: { claude: fake.bin } }) as never,
    agents: agents as never,
    saveAgents: () => { saves++; },
    loginPtys: loginPtys as never,
  });
});

afterEach(() => {
  for (const p of loginPtys.keys()) loginPtys.delete(p);
});

describe('the contract', () => {
  it('registers every channel of DESIGN-COMPTES-CLAUDE.md B6', () => {
    const expected = [
      'claude-accounts:list', 'claude-accounts:set-enabled', 'claude-accounts:set-thresholds', 'claude-accounts:add',
      'claude-accounts:rename', 'claude-accounts:set-account-enabled', 'claude-accounts:reorder', 'claude-accounts:remove',
      'claude-accounts:refresh', 'claude-accounts:login-start', 'claude-accounts:login-write', 'claude-accounts:login-resize',
      'claude-accounts:login-kill', 'claude-accounts:set-agent-account',
    ];
    expect([...CLAUDE_ACCOUNTS_CHANNELS].sort()).toEqual([...expected].sort());
    for (const c of expected) expect(handlers.has(c)).toBe(true);
  });

  it('lists the option off and account 1 alone when nothing was ever set, with every field of the state', async () => {
    const v = await view();
    expect(v.settings.enabled).toBe(false);
    expect(v.accounts).toHaveLength(1);
    const a = v.accounts[0];
    expect(a).toMatchObject({ id: 'default', configDir: null, enabled: true, fiveHour: null, sevenDay: null, updatedAt: null, blockedUntil: null, agentIds: [], error: null });
    expect(Object.keys(a).sort()).toEqual(['agentIds', 'blockedUntil', 'configDir', 'email', 'enabled', 'error', 'fiveHour', 'id', 'label', 'sevenDay', 'signedIn', 'subscriptionType', 'updatedAt'].sort());
  });

  it('asks Claude Code about accounts it has not asked yet, and tells the page', async () => {
    signIn(path.join(os.homedir(), '.claude'), 'one@example.com');
    const first = await view();
    expect(first.accounts[0].signedIn).toBeNull();
    await settle();
    expect(lastChanged().accounts[0]).toMatchObject({ signedIn: true, email: 'one@example.com', subscriptionType: 'max' });
    expect((await view()).accounts[0].email).toBe('one@example.com');
    expect(fake.calls()).toEqual(['<unset>|<unset>|auth status']);
  });
});

describe('adding and signing in', () => {
  it('creates, provisions and saves the account, signed out', async () => {
    const a = await add('Max two');
    expect(a.signedIn).toBe(false);
    expect(a.configDir).toBe(path.join(fs.realpathSync(os.homedir()), '.claude-accounts', a.id));
    expect(fs.lstatSync(path.join(a.configDir!, 'projects')).isSymbolicLink()).toBe(true);
    expect(JSON.parse(fs.readFileSync(accountsFile(), 'utf-8')).accounts.map((x: { id: string }) => x.id)).toEqual(['default', a.id]);
    expect(lastChanged().accounts.map(x => x.id)).toEqual(['default', a.id]);
  });

  it('answers a bad label, or a sixth account, with a sentence', async () => {
    expect(await call('claude-accounts:add', { label: '' })).toMatchObject({ success: false, error: expect.stringMatching(/label/i) });
    for (let i = 2; i <= 5; i++) await add(`Max ${i}`);
    expect(await call('claude-accounts:add', { label: 'Six' })).toMatchObject({ success: false, error: expect.stringMatching(/5/) });
    expect(await call('claude-accounts:add', undefined)).toMatchObject({ success: false });
  });

  it("runs the binary's own login in a terminal aimed at the account's directory, then reads the result", async () => {
    const a = await add('Max two');
    const r = await call<{ success: boolean; ptyId: string }>('claude-accounts:login-start', { id: a.id, cols: 100, rows: 30 });
    expect(r.success).toBe(true);
    const p = spawned.at(-1)!;
    expect(p.file).toBe(fake.bin);
    expect(p.args).toEqual(['auth', 'login', '--claudeai']);
    expect(p.opts.env.CLAUDE_CONFIG_DIR).toBe(a.configDir);
    expect(p.opts.env.DISABLE_AUTOUPDATER).toBe('1');

    p.data.forEach(cb => cb('Opening browser'));
    expect(broadcasts).toContainEqual({ channel: 'claude-accounts:login-data', payload: { ptyId: r.ptyId, data: 'Opening browser' } });
    await call('claude-accounts:login-write', { ptyId: r.ptyId, data: 'x' });
    expect(p.written).toEqual(['x']);

    signIn(a.configDir!, 'two@example.com');
    p.exit.forEach(cb => cb({ exitCode: 0 }));
    await settle();
    expect(broadcasts).toContainEqual({ channel: 'claude-accounts:login-exit', payload: { ptyId: r.ptyId, exitCode: 0 } });
    expect(lastChanged().accounts.find(x => x.id === a.id)).toMatchObject({ signedIn: true, email: 'two@example.com', error: null });
    expect(loginPtys.has(r.ptyId)).toBe(false);
  });

  it('signs account 1 in again without CLAUDE_CONFIG_DIR', async () => {
    await call('claude-accounts:login-start', { id: 'default' });
    expect('CLAUDE_CONFIG_DIR' in spawned.at(-1)!.opts.env).toBe(false);
  });

  it('refuses the same Claude account twice: signs the new directory out and says who has it', async () => {
    signIn(path.join(os.homedir(), '.claude'), 'one@example.com');
    await call('claude-accounts:refresh');
    const a = await add('Max two');
    const r = await call<{ ptyId: string }>('claude-accounts:login-start', { id: a.id });
    signIn(a.configDir!, 'ONE@example.com');
    spawned.at(-1)!.exit.forEach(cb => cb({ exitCode: 0 }));
    await settle();
    const state = lastChanged().accounts.find(x => x.id === a.id)!;
    expect(state.signedIn).toBe(false);
    expect(state.error).toMatch(/Account 1/);
    expect(fake.calls()).toContain(`${a.configDir}|<unset>|auth logout`);
    expect(r.ptyId).toBeTruthy();
  });

  it('kills a login terminal on request, and refuses an unknown one', async () => {
    const a = await add('Max two');
    const r = await call<{ ptyId: string }>('claude-accounts:login-start', { id: a.id });
    expect(await call('claude-accounts:login-kill', { ptyId: r.ptyId })).toMatchObject({ success: true });
    expect(spawned.at(-1)!.killed).toBe(true);
    expect(await call('claude-accounts:login-kill', { ptyId: 'nope' })).toMatchObject({ success: false });
    expect(await call('claude-accounts:login-start', { id: 'acct-ffffff' })).toMatchObject({ success: false });
  });
});

describe('removing', () => {
  it('signs out through Claude Code, moves the directory to the trash, forgets the account and its pins', async () => {
    const a = await add('Max two');
    signIn(a.configDir!, 'two@example.com');
    await call('claude-accounts:refresh', a.id);
    agents.set('ag1', { id: 'ag1', claudeAccountPin: a.id });
    const r = await call<{ success: boolean } & ClaudeAccountsView>('claude-accounts:remove', a.id);
    expect(r.success).toBe(true);
    expect(fake.calls()).toContain(`${a.configDir}|<unset>|auth logout`);
    expect(trashed).toEqual([a.configDir]);
    expect(r.accounts.map(x => x.id)).toEqual(['default']);
    expect(agents.get('ag1')!.claudeAccountPin).toBeUndefined();
    expect(saves).toBeGreaterThan(0);
  });

  it('keeps the account and its directory when the logout fails', async () => {
    const a = await add('Max two');
    signIn(a.configDir!, 'two@example.com');
    fs.writeFileSync(path.join(a.configDir!, '.fake-logout-fails'), '');
    await call('claude-accounts:refresh', a.id);
    const r = await call('claude-accounts:remove', a.id);
    expect(r).toMatchObject({ success: false, error: expect.stringMatching(/log out/i) });
    expect(trashed).toEqual([]);
    expect((await view()).accounts.map(x => x.id)).toContain(a.id);
  });

  it('does not ask for a logout when the account is not signed in', async () => {
    const a = await add('Max two');
    await call('claude-accounts:remove', a.id);
    expect(fake.calls().filter(c => c.endsWith('auth logout'))).toEqual([]);
    expect(trashed).toEqual([a.configDir]);
  });

  it('refuses account 1', async () => {
    expect(await call('claude-accounts:remove', 'default')).toMatchObject({ success: false });
  });
});

describe('settings', () => {
  it('turns the option on and off, saved', async () => {
    expect(await call('claude-accounts:set-enabled', true)).toMatchObject({ success: true, settings: { enabled: true } });
    expect(JSON.parse(fs.readFileSync(accountsFile(), 'utf-8')).enabled).toBe(true);
    expect(await call('claude-accounts:set-enabled', 'yes')).toMatchObject({ success: false });
  });

  it('sets thresholds, renames, disables and reorders, answering bad input with a sentence', async () => {
    const a = await add('Max two');
    expect(await call('claude-accounts:set-thresholds', { fiveHour: 80, weekly: 97 })).toMatchObject({ success: true, settings: { fiveHourThreshold: 80, weeklyThreshold: 97 } });
    expect(await call('claude-accounts:set-thresholds', { fiveHour: 10, weekly: 97 })).toMatchObject({ success: false });
    expect(await call('claude-accounts:rename', { id: a.id, label: 'Work' })).toMatchObject({ success: true });
    expect(await call('claude-accounts:set-account-enabled', { id: a.id, enabled: false })).toMatchObject({ success: true });
    const r = await call<ClaudeAccountsView & { success: boolean }>('claude-accounts:reorder', [a.id, 'default']);
    expect(r.accounts.map(x => [x.id, x.label, x.enabled])).toEqual([[a.id, 'Work', false], ['default', 'Account 1', true]]);
    expect(await call('claude-accounts:reorder', [a.id])).toMatchObject({ success: false });
    expect(lastChanged().accounts.map(x => x.id)).toEqual([a.id, 'default']);
  });
});

describe("an agent's account", () => {
  it('pins and unpins an agent, and refuses an unknown agent or account', async () => {
    const a = await add('Max two');
    agents.set('ag1', { id: 'ag1' });
    expect(await call('claude-accounts:set-agent-account', { agentId: 'ag1', accountId: a.id })).toMatchObject({ success: true });
    expect(agents.get('ag1')!.claudeAccountPin).toBe(a.id);
    expect(saves).toBe(1);
    expect(await call('claude-accounts:set-agent-account', { agentId: 'ag1', accountId: null })).toMatchObject({ success: true });
    expect(agents.get('ag1')!.claudeAccountPin).toBeUndefined();
    expect(await call('claude-accounts:set-agent-account', { agentId: 'nope', accountId: null })).toMatchObject({ success: false });
    expect(await call('claude-accounts:set-agent-account', { agentId: 'ag1', accountId: 'acct-ffffff' })).toMatchObject({ success: false });
  });
});
