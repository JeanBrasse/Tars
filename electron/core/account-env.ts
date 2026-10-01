/**
 * Which Claude account an agent process starts on, as its environment says it
 * (DESIGN-COMPTES-CLAUDE.md B3).
 *
 * The resolver is registered by main.ts, which has the fleet; spawnAgentPty
 * (every agent terminal) and delegateOverAcp (every delegated run) ask it.
 * Nothing registered, or the resolver answering null, and the environment is
 * left exactly as the caller built it: that is the option being off.
 *
 * Its own module with no imports but types, so that both can reach it without pulling
 * node-pty or the fleet into the other.
 */

import type { ClaudeAccountMove } from '../types';

export interface AccountEnv {
  accountId: string;
  /** Set when this launch makes a move Tars asked for (services/claude-accounts/switching.ts). */
  move?: ClaudeAccountMove;
  /** Put in, over anything inherited. */
  set: Record<string, string>;
  /** Taken out of whatever was inherited. */
  unset: string[];
}

/** A terminal, which a move is made by, or a delegated run, which leaves the move to the terminal. */
export type AccountEnvPurpose = 'terminal' | 'delegation';

export type AccountEnvResolver = (agentId: string, cwd: string, purpose: AccountEnvPurpose) => AccountEnv | null;

let resolver: AccountEnvResolver | undefined;

export function setAccountEnvResolver(fn: AccountEnvResolver | undefined): void {
  resolver = fn;
}

export function accountEnvFor(agentId: string | undefined, cwd: string, purpose: AccountEnvPurpose = 'terminal'): AccountEnv | null {
  if (!agentId || !resolver) return null;
  try {
    return resolver(agentId, cwd, purpose);
  } catch (err) {
    // A launch never fails over an account, and it starts on account 1 rather
    // than on whatever Tars inherited: an inherited CLAUDE_CONFIG_DIR is
    // another login (the Audit's LOW, QA's E1, gate of #267).
    console.warn(`[claude-accounts] no account chosen for ${agentId}, launching on account 1:`, err);
    return { accountId: 'default', set: { TARS_CLAUDE_ACCOUNT: 'default' }, unset: ['CLAUDE_CONFIG_DIR', 'CLAUDE_SECURESTORAGE_CONFIG_DIR'] };
  }
}

/** The environment with the account applied: its removals, then its values. */
export function withAccountEnv<T extends Record<string, string | undefined>>(env: T, account: AccountEnv | null): T {
  if (!account) return env;
  const out: Record<string, string | undefined> = { ...env };
  for (const name of account.unset) delete out[name];
  return { ...out, ...account.set } as T;
}
