/**
 * What Tars knows about its Claude accounts that is not in the registry file,
 * in memory only: what Claude Code last said about each sign-in (the e-mail
 * and plan never reach a file, the Audit's N2), when a limit blocks an
 * account, and which agents were just sent to which account, so that agents
 * launched together spread out (N5). Shared by the Settings handlers and the
 * launch path.
 */

export interface AuthState {
  signedIn: boolean | null;
  email: string | null;
  subscriptionType: string | null;
  error: string | null;
}

const auth = new Map<string, AuthState>();
const blocked = new Map<string, number>();
const moves = new Map<string, { accountId: string; at: number }>();

/** How long a choice counts for an agent that has no terminal yet. */
export const MOVE_COUNTS_FOR_MS = 60_000;

export function getAuth(id: string): AuthState | undefined {
  return auth.get(id);
}

export function hasAuth(id: string): boolean {
  return auth.has(id);
}

export function setAuth(id: string, state: AuthState): void {
  auth.set(id, state);
}

export function deleteAuth(id: string): void {
  auth.delete(id);
  blocked.delete(id);
}

/** Epoch seconds. */
export function blockedUntil(): Record<string, number> {
  return Object.fromEntries(blocked);
}

export function noteMove(agentId: string, accountId: string, now: number = Date.now()): void {
  moves.set(agentId, { accountId, at: now });
}

/** Agents sent to an account in the last minute, by agent. */
export function recentMoves(now: number = Date.now()): Map<string, string> {
  const out = new Map<string, string>();
  for (const [agentId, m] of moves) {
    if (now - m.at > MOVE_COUNTS_FOR_MS) moves.delete(agentId);
    else out.set(agentId, m.accountId);
  }
  return out;
}

/** For tests: forget everything. */
export function resetAccountState(): void {
  auth.clear();
  blocked.clear();
  moves.clear();
}
