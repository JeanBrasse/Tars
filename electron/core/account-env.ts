/**
 * Which Claude account an agent process starts on, as its environment says it
 * (DESIGN-COMPTES-CLAUDE.md B3).
 *
 * The resolver is registered by main.ts, which has the fleet; spawnAgentPty
 * (every agent terminal) and delegateOverAcp (every delegated run) ask it.
 * Nothing registered, or the resolver answering null, and the environment is
 * left exactly as the caller built it: that is the option being off.
 *
 * Its own module with no imports, so that both can reach it without pulling
 * node-pty or the fleet into the other.
 */

export interface AccountEnv {
  accountId: string;
  /** Put in, over anything inherited. */
  set: Record<string, string>;
  /** Taken out of whatever was inherited. */
  unset: string[];
}

export type AccountEnvResolver = (agentId: string, cwd: string) => AccountEnv | null;

let resolver: AccountEnvResolver | undefined;

export function setAccountEnvResolver(fn: AccountEnvResolver | undefined): void {
  resolver = fn;
}

export function accountEnvFor(agentId: string | undefined, cwd: string): AccountEnv | null {
  if (!agentId || !resolver) return null;
  try {
    return resolver(agentId, cwd);
  } catch (err) {
    // A launch never fails over an account: it starts as it would have.
    console.warn(`[claude-accounts] no account chosen for ${agentId}, launching as before:`, err);
    return null;
  }
}

/** The environment with the account applied: its removals, then its values. */
export function withAccountEnv<T extends Record<string, string | undefined>>(env: T, account: AccountEnv | null): T {
  if (!account) return env;
  const out: Record<string, string | undefined> = { ...env };
  for (const name of account.unset) delete out[name];
  return { ...out, ...account.set } as T;
}
