import { ipcMain, shell } from 'electron';
import * as os from 'os';
import * as pty from 'node-pty';
import { v4 as uuidv4 } from 'uuid';
import { broadcastToAllWindows } from '../utils/broadcast';
import { buildFullPath } from '../utils/path-builder';
import {
  DEFAULT_ACCOUNT_ID,
  accountsRoot,
  addAccount,
  readAccountsSettings,
  removeAccount,
  renameAccount,
  reorderAccounts,
  setAccountEnabled,
  setEnabled,
  setThresholds,
  writeAccountsSettings,
} from '../services/claude-accounts/registry';
import { accountDirProblem, claudeCredentialOverrides, provisionAccountDir } from '../services/claude-accounts/provision';
import { claudeAuthLogout, claudeAuthStatus, loginCommand } from '../services/claude-accounts/auth';
import type { AgentStatus, AppSettings, ClaudeAccount, ClaudeAccountState, ClaudeAccountsSettings, ClaudeAccountsView } from '../types';

/**
 * The Settings contract for several Claude accounts (DESIGN-COMPTES-CLAUDE.md, B6).
 *
 * This file manages the list and the sign-ins. Choosing an account when an
 * agent starts, and the usage counters, come with the launch path; until
 * then the option changes nothing for any agent, on or off.
 */

export const CLAUDE_ACCOUNTS_CHANNELS = [
  'claude-accounts:list',
  'claude-accounts:set-enabled',
  'claude-accounts:set-thresholds',
  'claude-accounts:add',
  'claude-accounts:rename',
  'claude-accounts:set-account-enabled',
  'claude-accounts:reorder',
  'claude-accounts:remove',
  'claude-accounts:refresh',
  'claude-accounts:login-start',
  'claude-accounts:login-write',
  'claude-accounts:login-resize',
  'claude-accounts:login-kill',
  'claude-accounts:set-agent-account',
] as const;

export interface ClaudeAccountsHandlerDeps {
  getAppSettings: () => AppSettings;
  agents: Map<string, AgentStatus>;
  saveAgents: () => void;
  /** Where the login terminals are kept, so that quitting kills them with the rest. */
  loginPtys: Map<string, pty.IPty>;
}

interface AuthState {
  signedIn: boolean | null;
  email: string | null;
  subscriptionType: string | null;
  error: string | null;
}

type Result<T extends object = object> = ({ success: true } & T) | { success: false; error: string };

function failure(err: unknown): { success: false; error: string } {
  return { success: false, error: err instanceof Error ? err.message : String(err) };
}

/**
 * Registers the channels. Resolves `idle()` once the checks and post-login
 * work it started in the background have finished: what a caller waits on
 * before reading the result, instead of a delay.
 */
export function registerClaudeAccountsHandlers(deps: ClaudeAccountsHandlerDeps): { idle: () => Promise<void> } {
  const { getAppSettings, agents, saveAgents, loginPtys } = deps;

  const background = new Set<Promise<unknown>>();
  function inBackground(p: Promise<unknown>): void {
    background.add(p);
    void p.finally(() => background.delete(p));
  }
  async function idle(): Promise<void> {
    while (background.size) await Promise.allSettled([...background]);
  }

  /** What Claude Code last said about each account, by id. */
  const auth = new Map<string, AuthState>();
  const checking = new Map<string, Promise<void>>();
  /** Login terminal → the account it signs in. */
  const loginFor = new Map<string, string>();

  const binary = (): string => getAppSettings().cliPaths?.claude || 'claude';

  function stateOf(account: ClaudeAccount): ClaudeAccountState {
    const a = auth.get(account.id);
    return {
      ...account,
      signedIn: a?.signedIn ?? null,
      email: a?.email ?? null,
      subscriptionType: a?.subscriptionType ?? null,
      fiveHour: null,
      sevenDay: null,
      updatedAt: null,
      blockedUntil: null,
      agentIds: [...agents.values()]
        .filter(agent => agent.ptyId && (agent.claudeAccountId ?? DEFAULT_ACCOUNT_ID) === account.id)
        .map(agent => agent.id),
      error: a?.error ?? null,
    };
  }

  function view(settings: ClaudeAccountsSettings = readAccountsSettings()): ClaudeAccountsView {
    return { settings, accounts: settings.accounts.map(stateOf) };
  }

  function announce(settings?: ClaudeAccountsSettings): ClaudeAccountsView {
    const v = view(settings);
    broadcastToAllWindows('claude-accounts:changed', v);
    return v;
  }

  function save(settings: ClaudeAccountsSettings): ClaudeAccountsView {
    writeAccountsSettings(settings);
    return announce(settings);
  }

  function check(account: ClaudeAccount): Promise<void> {
    const running = checking.get(account.id);
    if (running) return running;
    const p = claudeAuthStatus(binary(), account.configDir)
      .then(info => {
        auth.set(account.id, { signedIn: info.signedIn, email: info.email, subscriptionType: info.subscriptionType, error: null });
      })
      .catch(err => {
        auth.set(account.id, { signedIn: null, email: null, subscriptionType: null, error: err instanceof Error ? err.message : String(err) });
      })
      .finally(() => checking.delete(account.id));
    checking.set(account.id, p);
    return p;
  }

  async function checkAll(ids?: string[]): Promise<void> {
    const settings = readAccountsSettings();
    await Promise.all(settings.accounts.filter(a => !ids || ids.includes(a.id)).map(check));
  }

  /**
   * After a login: the same Claude account in two directories is refused
   * (Noah, 28/09). The directory just signed in is signed out again, by Claude
   * Code, and the page is told which account already has it.
   */
  async function afterLogin(accountId: string): Promise<void> {
    await checkAll();
    const settings = readAccountsSettings();
    const account = settings.accounts.find(a => a.id === accountId);
    const mine = auth.get(accountId);
    if (!account || !mine?.signedIn || !mine.email) return;
    const other = settings.accounts.find(a => a.id !== accountId
      && auth.get(a.id)?.signedIn
      && auth.get(a.id)?.email?.toLowerCase() === mine.email!.toLowerCase());
    if (!other) return;
    let why = `This Claude account is already added as "${other.label}", and was signed out here.`;
    try {
      await claudeAuthLogout(binary(), account.configDir);
    } catch (err) {
      why = `This Claude account is already added as "${other.label}". Signing it out here failed too: ${err instanceof Error ? err.message : String(err)}`;
    }
    await check(account);
    auth.set(accountId, { ...(auth.get(accountId) as AuthState), error: why });
  }

  ipcMain.handle('claude-accounts:list', async (): Promise<Result<ClaudeAccountsView>> => {
    try {
      const settings = readAccountsSettings();
      const unknown = settings.accounts.filter(a => !auth.has(a.id)).map(a => a.id);
      if (unknown.length) inBackground(checkAll(unknown).then(() => announce()));
      return { success: true, ...view(settings) };
    } catch (err) {
      return failure(err);
    }
  });

  ipcMain.handle('claude-accounts:refresh', async (_e, id?: unknown): Promise<Result<ClaudeAccountsView>> => {
    try {
      if (id !== undefined && id !== null && typeof id !== 'string') throw new Error('An account id is a string.');
      await checkAll(typeof id === 'string' ? [id] : undefined);
      return { success: true, ...announce() };
    } catch (err) {
      return failure(err);
    }
  });

  /**
   * On only when each folder's own login is what Claude Code would use: an API
   * key, a token or a key helper in ~/.claude/settings.json or in Tars's own
   * environment signs every folder in as that one credential, and switching
   * would change nothing the cards say it did (the Audit's B3). Named, never
   * quoted.
   */
  ipcMain.handle('claude-accounts:set-enabled', async (_e, enabled: unknown): Promise<Result<ClaudeAccountsView>> => {
    try {
      if (enabled === true) {
        const overrides = claudeCredentialOverrides();
        if (overrides.length) {
          throw new Error(`Claude Code is set to sign in with ${overrides.join(', ')}, so every account would run on that one credential. Remove it to use several accounts.`);
        }
      }
      return { success: true, ...save(setEnabled(readAccountsSettings(), enabled)) };
    } catch (err) {
      return failure(err);
    }
  });

  ipcMain.handle('claude-accounts:set-thresholds', async (_e, p: unknown): Promise<Result<ClaudeAccountsView>> => {
    try {
      const { fiveHour, weekly } = (p ?? {}) as { fiveHour?: unknown; weekly?: unknown };
      return { success: true, ...save(setThresholds(readAccountsSettings(), fiveHour, weekly)) };
    } catch (err) {
      return failure(err);
    }
  });

  ipcMain.handle('claude-accounts:add', async (_e, p: unknown): Promise<Result<{ account: ClaudeAccountState }>> => {
    try {
      const { label } = (p ?? {}) as { label?: unknown };
      const { settings, account } = addAccount(readAccountsSettings(), label, accountsRoot());
      provisionAccountDir(account.configDir as string);
      // A directory nobody has signed in yet: no need to ask Claude Code.
      auth.set(account.id, { signedIn: false, email: null, subscriptionType: null, error: null });
      const v = save(settings);
      return { success: true, account: v.accounts.find(a => a.id === account.id) as ClaudeAccountState };
    } catch (err) {
      return failure(err);
    }
  });

  ipcMain.handle('claude-accounts:rename', async (_e, p: unknown): Promise<Result<ClaudeAccountsView>> => {
    try {
      const { id, label } = (p ?? {}) as { id?: unknown; label?: unknown };
      return { success: true, ...save(renameAccount(readAccountsSettings(), id, label)) };
    } catch (err) {
      return failure(err);
    }
  });

  ipcMain.handle('claude-accounts:set-account-enabled', async (_e, p: unknown): Promise<Result<ClaudeAccountsView>> => {
    try {
      const { id, enabled } = (p ?? {}) as { id?: unknown; enabled?: unknown };
      return { success: true, ...save(setAccountEnabled(readAccountsSettings(), id, enabled)) };
    } catch (err) {
      return failure(err);
    }
  });

  ipcMain.handle('claude-accounts:reorder', async (_e, ids: unknown): Promise<Result<ClaudeAccountsView>> => {
    try {
      return { success: true, ...save(reorderAccounts(readAccountsSettings(), ids)) };
    } catch (err) {
      return failure(err);
    }
  });

  /**
   * The folder is checked first: one that is not Tars's own (a link, open to
   * others, not this user's) is refused, with nothing signed out or moved.
   * Then signed out by Claude Code, with the folder's exact string (another
   * spelling is another keychain item), so that no signed-in item is left
   * behind with nobody able to see it; a logout that fails keeps the account.
   * Then the folder goes to the Trash, never deleted: it holds the account's
   * own sessions and history, and a Trash that fails keeps it, and the
   * account, and says so.
   */
  ipcMain.handle('claude-accounts:remove', async (_e, id: unknown): Promise<Result<ClaudeAccountsView>> => {
    try {
      const current = readAccountsSettings();
      const next = removeAccount(current, id);
      const account = current.accounts.find(a => a.id === id) as ClaudeAccount;
      const problem = accountDirProblem(account.configDir as string);
      if (problem) throw new Error(`${problem} Nothing was signed out or moved.`);

      for (const [ptyId, forId] of loginFor) {
        if (forId !== account.id) continue;
        loginPtys.get(ptyId)?.kill();
        loginPtys.delete(ptyId);
        loginFor.delete(ptyId);
      }

      let signedIn: boolean | null;
      try {
        signedIn = (await claudeAuthStatus(binary(), account.configDir)).signedIn;
      } catch {
        signedIn = null;
      }
      if (signedIn !== false) await claudeAuthLogout(binary(), account.configDir);

      try {
        await shell.trashItem(account.configDir as string);
      } catch (err) {
        auth.delete(account.id);
        throw new Error(`Signed out, but its folder could not go to the Trash (${err instanceof Error ? err.message : String(err)}). Nothing was deleted, and the account stays until its folder can be moved.`);
      }

      let pinsCleared = false;
      for (const agent of agents.values()) {
        if (agent.claudeAccountPin !== account.id) continue;
        delete agent.claudeAccountPin;
        pinsCleared = true;
      }
      if (pinsCleared) saveAgents();
      auth.delete(account.id);
      return { success: true, ...save(next) };
    } catch (err) {
      return failure(err);
    }
  });

  ipcMain.handle('claude-accounts:login-start', async (_e, p: unknown): Promise<Result<{ ptyId: string }>> => {
    try {
      const { id, cols, rows } = (p ?? {}) as { id?: unknown; cols?: unknown; rows?: unknown };
      const account = readAccountsSettings().accounts.find(a => a.id === id);
      if (!account) throw new Error('There is no such account.');
      if (account.configDir) provisionAccountDir(account.configDir);

      const command = loginCommand(binary(), account.configDir);
      const ptyId = uuidv4();
      const term = pty.spawn(command.file, command.args, {
        name: 'xterm-256color',
        cols: typeof cols === 'number' && cols > 0 ? cols : 100,
        rows: typeof rows === 'number' && rows > 0 ? rows : 30,
        cwd: os.homedir(),
        env: { ...command.env, PATH: buildFullPath() } as Record<string, string>,
      });
      loginPtys.set(ptyId, term);
      loginFor.set(ptyId, account.id);
      term.onData(data => broadcastToAllWindows('claude-accounts:login-data', { ptyId, data }));
      term.onExit(({ exitCode }) => {
        loginPtys.delete(ptyId);
        loginFor.delete(ptyId);
        broadcastToAllWindows('claude-accounts:login-exit', { ptyId, exitCode });
        inBackground(afterLogin(account.id).then(() => announce()));
      });
      return { success: true, ptyId };
    } catch (err) {
      return failure(err);
    }
  });

  ipcMain.handle('claude-accounts:login-write', async (_e, p: unknown): Promise<Result> => {
    const { ptyId, data } = (p ?? {}) as { ptyId?: unknown; data?: unknown };
    const term = typeof ptyId === 'string' && loginFor.has(ptyId) ? loginPtys.get(ptyId) : undefined;
    if (!term || typeof data !== 'string') return { success: false, error: 'There is no such login terminal.' };
    term.write(data);
    return { success: true };
  });

  ipcMain.handle('claude-accounts:login-resize', async (_e, p: unknown): Promise<Result> => {
    const { ptyId, cols, rows } = (p ?? {}) as { ptyId?: unknown; cols?: unknown; rows?: unknown };
    const term = typeof ptyId === 'string' && loginFor.has(ptyId) ? loginPtys.get(ptyId) : undefined;
    if (!term || typeof cols !== 'number' || typeof rows !== 'number' || cols < 1 || rows < 1) {
      return { success: false, error: 'There is no such login terminal.' };
    }
    term.resize(cols, rows);
    return { success: true };
  });

  ipcMain.handle('claude-accounts:login-kill', async (_e, p: unknown): Promise<Result> => {
    const { ptyId } = (p ?? {}) as { ptyId?: unknown };
    const term = typeof ptyId === 'string' && loginFor.has(ptyId) ? loginPtys.get(ptyId) : undefined;
    if (!term) return { success: false, error: 'There is no such login terminal.' };
    term.kill();
    loginPtys.delete(ptyId as string);
    loginFor.delete(ptyId as string);
    return { success: true };
  });

  /**
   * Holds an agent to one account, or gives it back to the automatic choice
   * (null). Read by the launch path; saved here.
   */
  ipcMain.handle('claude-accounts:set-agent-account', async (_e, p: unknown): Promise<Result> => {
    try {
      const { agentId, accountId } = (p ?? {}) as { agentId?: unknown; accountId?: unknown };
      const agent = typeof agentId === 'string' ? agents.get(agentId) : undefined;
      if (!agent) throw new Error('There is no such agent.');
      if (accountId === null) {
        delete agent.claudeAccountPin;
      } else {
        const account = readAccountsSettings().accounts.find(a => a.id === accountId);
        if (!account) throw new Error('There is no such account.');
        agent.claudeAccountPin = account.id;
      }
      saveAgents();
      return { success: true };
    } catch (err) {
      return failure(err);
    }
  });

  return { idle };
}
