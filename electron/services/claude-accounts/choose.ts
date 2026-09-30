import type { ClaudeAccountWindow } from '../../types';

/**
 * Which account an agent's CLI starts on (DESIGN-COMPTES-CLAUDE.md B4, with
 * the Audit's N5). A pure function of what it is given: the launch path reads
 * the registry, the counters and the sign-ins, and records the answer.
 *
 * In order:
 * 1. a pin to an account that can run (enabled, signed in) wins, even over a
 *    threshold;
 * 2. the account the agent last ran on, while it is under both thresholds and
 *    not blocked: a move costs the prompt cache, which is per account;
 * 3. the account with the most room under both thresholds, the margin being
 *    min(5 h threshold - 5 h used, weekly threshold - weekly used). Within 5
 *    points, a measured account before one nobody measured, then the one with
 *    fewer agents running or moving to it, then the order of the list;
 * 4. none has room: the one that comes back first, whose CLI then waits for
 *    that reset by itself;
 * 5. none can run at all: account 1.
 *
 * A counter older than STALE_AFTER_MS is unknown (claude.ai on the web or the
 * phone shares the plan's limits and no status line sees it), and read as
 * 0 %. A window whose reset time has passed is 0 %, however old.
 */

export const STALE_AFTER_MS = 30 * 60_000;
const TIE_POINTS = 5;

export interface AccountUsage {
  fiveHour: ClaudeAccountWindow | null;
  sevenDay: ClaudeAccountWindow | null;
  /** Epoch ms of the status line's report. */
  updatedAt: number | null;
}

export interface ChooseInput {
  /** In the order of the list. `signedIn` null: Claude Code has not answered yet. */
  accounts: { id: string; enabled: boolean; signedIn: boolean | null }[];
  fiveHourThreshold: number;
  weeklyThreshold: number;
  usage: Record<string, AccountUsage | undefined>;
  /** Epoch seconds, after a limit was hit. */
  blockedUntil: Record<string, number | undefined>;
  /** Other agents running on, or moving to, each account. */
  load: Record<string, number | undefined>;
  pin?: string;
  last?: string;
  /** Epoch ms. */
  now: number;
}

/** 'moved' is not the chooser's: the launch that makes a move switching.ts asked for. */
export type ChoiceReason = 'pinned' | 'kept' | 'most-headroom' | 'all-at-limit' | 'fallback' | 'moved';

export interface Choice {
  accountId: string;
  reason: ChoiceReason;
  /** Epoch seconds, for all-at-limit: when the chosen account has room again. */
  comesBackAt?: number;
}

interface Reading {
  id: string;
  index: number;
  fiveHour: number;
  sevenDay: number;
  /** Both windows read from a fresh counter (or a reset that has passed). */
  measured: boolean;
  margin: number;
  /** Epoch seconds when it has room again; 0 when it has room now. */
  comesBackAt: number;
}

function canRun(a: { id: string; enabled: boolean; signedIn: boolean | null }): boolean {
  // Account 1 is the Claude Code everybody already uses: usable until Claude
  // Code says it is signed out. Another account only once it said signed in.
  return a.enabled && (a.id === 'default' ? a.signedIn !== false : a.signedIn === true);
}

function windowUse(w: ClaudeAccountWindow | null | undefined, updatedAt: number | null, now: number): { used: number; known: boolean; resetsAt: number } {
  if (!w) return { used: 0, known: false, resetsAt: 0 };
  if (w.resetsAt * 1000 <= now) return { used: 0, known: true, resetsAt: 0 };
  if (updatedAt === null || now - updatedAt > STALE_AFTER_MS) return { used: 0, known: false, resetsAt: 0 };
  return { used: w.usedPercentage, known: true, resetsAt: w.resetsAt };
}

function read(input: ChooseInput, id: string, index: number): Reading {
  const u = input.usage[id];
  const five = windowUse(u?.fiveHour, u?.updatedAt ?? null, input.now);
  const seven = windowUse(u?.sevenDay, u?.updatedAt ?? null, input.now);
  const blocked = input.blockedUntil[id];
  const back = [
    five.used >= input.fiveHourThreshold ? five.resetsAt : 0,
    seven.used >= input.weeklyThreshold ? seven.resetsAt : 0,
    blocked !== undefined && blocked * 1000 > input.now ? blocked : 0,
  ];
  return {
    id,
    index,
    fiveHour: five.used,
    sevenDay: seven.used,
    measured: five.known && seven.known,
    margin: Math.min(input.fiveHourThreshold - five.used, input.weeklyThreshold - seven.used),
    comesBackAt: Math.max(...back),
  };
}

export function chooseAccount(input: ChooseInput): Choice {
  const runnable = input.accounts.map((a, index) => ({ a, index })).filter(({ a }) => canRun(a));

  if (input.pin && runnable.some(({ a }) => a.id === input.pin)) return { accountId: input.pin, reason: 'pinned' };
  if (runnable.length === 0) return { accountId: 'default', reason: 'fallback' };

  const readings = runnable.map(({ a, index }) => read(input, a.id, index));
  const withRoom = readings.filter(r => r.comesBackAt === 0);

  if (input.last && withRoom.some(r => r.id === input.last)) return { accountId: input.last, reason: 'kept' };

  if (withRoom.length > 0) {
    const load = (r: Reading) => input.load[r.id] ?? 0;
    const best = [...withRoom].sort((x, y) => {
      if (Math.abs(x.margin - y.margin) > TIE_POINTS) return y.margin - x.margin;
      if (x.measured !== y.measured) return x.measured ? -1 : 1;
      if (load(x) !== load(y)) return load(x) - load(y);
      return x.index - y.index;
    })[0];
    return { accountId: best.id, reason: 'most-headroom' };
  }

  const first = [...readings].sort((x, y) => x.comesBackAt - y.comesBackAt || x.index - y.index)[0];
  return { accountId: first.id, reason: 'all-at-limit', comesBackAt: first.comesBackAt };
}
