import * as os from 'os';
import type { AgentStatus, ClaudeAccountsSettings } from '../../types';
import type { AccountEnv } from '../../core/account-env';
import { DEFAULT_ACCOUNT_ID, readAccountsSettings } from './registry';
import { claudeCredentialOverrides, provisionAccountDir } from './provision';
import { readAccountUsage } from './counters';
import { chooseAccount, type AccountUsage } from './choose';
import { blockedUntil, getAuth, noteMove, recentMoves } from './state';

/**
 * The environment an agent's CLI starts with, per account
 * (DESIGN-COMPTES-CLAUDE.md B3). Called at every spawn of an agent process,
 * through the resolver main.ts registers (core/account-env.ts).
 *
 * - The option off, or an agent of another provider: null, and the launch is
 *   exactly what it was.
 * - Account 1: the variables that would aim Claude Code elsewhere are removed
 *   from what the process inherits (measured, CLAUDE_CONFIG_DIR=~/.claude is
 *   another login), and the status line is told it reports for `default`.
 * - Another account: its folder is provisioned for the folder the CLI starts
 *   in (hooks, MCP servers, the bypass acceptance, that project's trust and
 *   approvals, the Audit's B1), then named. A folder that fails its checks
 *   (B2), or a credential that would sign every folder in as one (B3), and
 *   the agent starts on account 1 rather than not at all.
 *
 * The choice is recorded on the agent (what its card shows, and what the next
 * relaunch keeps while it has room) and counted for a minute, so that agents
 * launched together spread out before their terminals exist (N5).
 */

export const ACCOUNT_ENV_UNSET = ['CLAUDE_CONFIG_DIR', 'CLAUDE_SECURESTORAGE_CONFIG_DIR', 'TARS_CLAUDE_ACCOUNT'] as const;

export interface LaunchContext {
  /** The fleet, to count who runs where. */
  agents: Iterable<AgentStatus>;
  /** The folder the CLI starts in. */
  cwd?: string;
  now?: number;
  home?: string;
  settings?: ClaudeAccountsSettings;
  usage?: Record<string, AccountUsage>;
  overrides?: string[];
}

function isClaudeSubscription(agent: AgentStatus): boolean {
  return !agent.provider || agent.provider === 'claude';
}

function defaultEnv(): AccountEnv {
  return { accountId: DEFAULT_ACCOUNT_ID, set: { TARS_CLAUDE_ACCOUNT: DEFAULT_ACCOUNT_ID }, unset: ['CLAUDE_CONFIG_DIR', 'CLAUDE_SECURESTORAGE_CONFIG_DIR'] };
}

function record(agent: AgentStatus, env: AccountEnv, now: number): AccountEnv {
  agent.claudeAccountId = env.accountId;
  noteMove(agent.id, env.accountId, now);
  return env;
}

export function claudeAccountEnvFor(agent: AgentStatus, ctx: LaunchContext): AccountEnv | null {
  const settings = ctx.settings ?? readAccountsSettings();
  if (!settings.enabled || !isClaudeSubscription(agent)) return null;
  const now = ctx.now ?? Date.now();
  const name = agent.name || agent.id;

  const overrides = ctx.overrides ?? claudeCredentialOverrides();
  if (overrides.length) {
    console.warn(`[claude-accounts] ${name}: on account 1, since Claude Code would sign every account in with ${overrides.join(', ')}`);
    return record(agent, defaultEnv(), now);
  }

  // Who runs where: agents with a terminal, and choices made a moment ago for
  // agents whose terminal is not there yet. Not this agent.
  const load: Record<string, number> = {};
  const counted = new Set<string>();
  for (const other of ctx.agents) {
    if (other.id === agent.id || !other.ptyId || !other.claudeAccountId) continue;
    load[other.claudeAccountId] = (load[other.claudeAccountId] ?? 0) + 1;
    counted.add(other.id);
  }
  for (const [agentId, accountId] of recentMoves(now)) {
    if (agentId === agent.id || counted.has(agentId)) continue;
    load[accountId] = (load[accountId] ?? 0) + 1;
  }

  const choice = chooseAccount({
    accounts: settings.accounts.map(a => ({ id: a.id, enabled: a.enabled, signedIn: getAuth(a.id)?.signedIn ?? null })),
    fiveHourThreshold: settings.fiveHourThreshold,
    weeklyThreshold: settings.weeklyThreshold,
    usage: ctx.usage ?? readAccountUsage(),
    blockedUntil: blockedUntil(),
    load,
    pin: agent.claudeAccountPin,
    last: agent.claudeAccountId,
    now,
  });

  const account = settings.accounts.find(a => a.id === choice.accountId);
  if (!account || !account.configDir) return record(agent, defaultEnv(), now);

  try {
    const home = ctx.home ?? os.homedir();
    provisionAccountDir(account.configDir, home, { projectPath: ctx.cwd });
    if (ctx.cwd !== agent.projectPath && agent.projectPath) provisionAccountDir(account.configDir, home, { projectPath: agent.projectPath });
  } catch (err) {
    console.warn(`[claude-accounts] ${name}: on account 1, since ${account.label} cannot be used: ${err instanceof Error ? err.message : String(err)}`);
    return record(agent, defaultEnv(), now);
  }
  console.log(`[claude-accounts] ${name}: on ${account.label} (${choice.reason})`);
  return record(agent, {
    accountId: account.id,
    set: { CLAUDE_CONFIG_DIR: account.configDir, TARS_CLAUDE_ACCOUNT: account.id },
    unset: ['CLAUDE_SECURESTORAGE_CONFIG_DIR'],
  }, now);
}
