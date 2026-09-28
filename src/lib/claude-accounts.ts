import type { AgentStatus, ClaudeAccountState, ClaudeAccountsSettings, ClaudeAccountsView, ClaudeAccountWindow } from '@/types/electron';

/**
 * What Settings > Claude accounts and an agent's account control say, worked
 * out apart from the page. The contract is #263's (DESIGN-COMPTES-CLAUDE.md,
 * B6); the words are the frames' (`Settings · Claude accounts · states`,
 * `Agent · Claude account`, in design/tars-redesign.pen). Its failures are
 * listed, and pinned, in __tests__/lib/claude-accounts.test.ts.
 */

export const DEFAULT_ACCOUNT_ID = 'default';
export const MAX_ACCOUNTS = 5;
/** The menu's value for "let Tars choose": setAgentAccount takes null for it. */
export const AUTOMATIC = 'auto';

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const pad = (n: number) => String(n).padStart(2, '0');

/** A whole percentage from 50 to 100, as main takes it. */
export function isThreshold(value: number): boolean {
  return Number.isInteger(value) && value >= 50 && value <= 100;
}

/** A reset within a day as the time of day, a later one with its weekday: 16:40, Thu 09:00. */
export function formatReset(resetsAt: number, now: Date): string {
  const at = new Date(resetsAt * 1000);
  const time = `${pad(at.getHours())}:${pad(at.getMinutes())}`;
  return at.getTime() - now.getTime() < 24 * 3_600_000 ? time : `${WEEKDAYS[at.getDay()]} ${time}`;
}

export type MeterTone = 'normal' | 'near' | 'full';

/** The waiting colour from the threshold on, the error colour at the limit. */
export function meterTone(usedPercentage: number, threshold: number): MeterTone {
  if (usedPercentage >= 100) return 'full';
  return usedPercentage >= threshold ? 'near' : 'normal';
}

export function accountWord(a: ClaudeAccountState): { word: 'checking' | 'signed in' | 'not signed in'; tone: 'idle' | 'running' | 'waiting' } {
  if (a.signedIn === null) return { word: 'checking', tone: 'idle' };
  return a.signedIn ? { word: 'signed in', tone: 'running' } : { word: 'not signed in', tone: 'waiting' };
}

/** Email, plan and the agents on it, once Claude Code has said it is signed in. */
export function whoLine(a: ClaudeAccountState): string | null {
  if (a.signedIn !== true) return null;
  const n = a.agentIds.length;
  return [a.email, a.subscriptionType, `${n} ${n === 1 ? 'agent' : 'agents'}`].filter(Boolean).join(' · ');
}

/** A path with the home folder written as ~, on macOS and Linux. */
export function tildify(path: string): string {
  return path.replace(/^\/(?:Users|home)\/[^/]+(?=\/|$)/, '~');
}

/** Account 1 is Claude Code's own folder; the others were made by Tars. */
export function accountFolder(a: ClaudeAccountState): string {
  return a.configDir ? tildify(a.configDir) : '~/.claude';
}

const nowSec = (now: Date) => now.getTime() / 1000;
const isBlocked = (a: ClaudeAccountState, now: Date) => a.blockedUntil !== null && a.blockedUntil > nowSec(now);
const isFull = (w: ClaudeAccountWindow | null) => w !== null && w.usedPercentage >= 100;

/** Whether Tars can put an agent on it now: on, signed in, not stopped by a limit, below both thresholds. */
export function hasRoom(a: ClaudeAccountState, settings: ClaudeAccountsSettings, now: Date): boolean {
  return a.enabled && a.signedIn === true && !isBlocked(a, now)
    && (a.fiveHour === null || a.fiveHour.usedPercentage < settings.fiveHourThreshold)
    && (a.sevenDay === null || a.sevenDay.usedPercentage < settings.weeklyThreshold);
}

export type NoteTone = 'muted' | 'secondary' | 'waiting' | 'error';
export interface AccountNote {
  text: string;
  tone: NoteTone;
}

/** Why an account takes no agent, or where its agents go past a threshold. Null when nothing needs saying. */
export function accountNote(a: ClaudeAccountState, view: ClaudeAccountsView, now: Date): AccountNote | null {
  if (a.signedIn === null) return { text: 'Asking Claude Code whether this folder is signed in.', tone: 'muted' };
  if (a.signedIn === false) return { text: 'Not signed in, or its sign-in expired. It takes no agent until it is signed in.', tone: 'secondary' };
  if (!a.enabled) return { text: 'Turned off: Tars starts no agent on it.', tone: 'muted' };
  if (isBlocked(a, now)) return { text: `At its limit until ${formatReset(a.blockedUntil as number, now)}.`, tone: 'error' };
  const full = [a.fiveHour, a.sevenDay].find(isFull);
  if (full) return { text: `At its limit until ${formatReset(full.resetsAt, now)}.`, tone: 'error' };
  if (a.fiveHour === null && a.sevenDay === null) return { text: 'No use seen yet: the first agent that runs on it measures it.', tone: 'muted' };

  const { fiveHourThreshold, weeklyThreshold } = view.settings;
  const pastFive = a.fiveHour !== null && a.fiveHour.usedPercentage >= fiveHourThreshold;
  const pastWeek = a.sevenDay !== null && a.sevenDay.usedPercentage >= weeklyThreshold;
  if (!pastFive && !pastWeek) return null;
  const what = pastFive && pastWeek
    ? 'Past its 5 h and weekly thresholds'
    : pastFive ? `Past ${fiveHourThreshold}% of its 5 h window` : `Past ${weeklyThreshold}% of its weekly window`;
  const elsewhere = view.accounts.some(o => o.id !== a.id && hasRoom(o, view.settings, now));
  return { text: elsewhere ? `${what}: agents go to another account.` : `${what}, and no other account has room.`, tone: 'waiting' };
}

/**
 * When every account that can take agents is stopped by a limit: the first
 * one back, and when. Null while one still has room, or when none can take
 * agents at all (signed out, turned off), which the rows say themselves.
 */
export function allAtLimit(view: ClaudeAccountsView, now: Date): { at: string; label: string } | null {
  const candidates = view.accounts.filter(a => a.enabled && a.signedIn === true);
  if (candidates.length === 0) return null;
  let first: { resume: number; label: string } | null = null;
  for (const a of candidates) {
    const limits = [
      ...(isBlocked(a, now) ? [a.blockedUntil as number] : []),
      ...[a.fiveHour, a.sevenDay].filter(isFull).map(w => (w as ClaudeAccountWindow).resetsAt),
    ];
    if (limits.length === 0) return null;
    // Back once every window that stops it has reset.
    const resume = Math.max(...limits);
    if (!first || resume < first.resume) first = { resume, label: a.label };
  }
  return first && { at: formatReset(first.resume, now), label: first.label };
}

/** The ids with one row swapped with its neighbour; unchanged past either end. */
export function moveInOrder(ids: string[], index: number, delta: -1 | 1): string[] {
  const next = [...ids];
  const other = index + delta;
  if (other < 0 || other >= next.length) return next;
  [next[index], next[other]] = [next[other], next[index]];
  return next;
}

/** "Account N" with the first N no account has, case aside, as main compares labels. */
export function suggestLabel(view: ClaudeAccountsView): string {
  const taken = new Set(view.accounts.map(a => a.label.toLowerCase()));
  let n = view.accounts.length + 1;
  while (taken.has(`account ${n}`)) n++;
  return `Account ${n}`;
}

type AgentAccountFields = Pick<AgentStatus, 'provider' | 'claudeAccountId' | 'claudeAccountPin'>;

/**
 * Only with the option on and more than one account, and only on an agent
 * that runs Claude on a subscription: the thirteen API-key providers and
 * local run on their own keys (DESIGN-COMPTES-CLAUDE.md, B3).
 */
export function showsAccountControl(view: ClaudeAccountsView | null, agent: Partial<AgentAccountFields>): view is ClaudeAccountsView {
  return !!view && view.settings.enabled && view.accounts.length > 1 && (agent.provider ?? 'claude') === 'claude';
}

function labelOf(view: ClaudeAccountsView, id: string): string {
  return view.accounts.find(a => a.id === id)?.label ?? 'a removed account';
}
const runningOn = (agent: Partial<AgentAccountFields>) => agent.claudeAccountId ?? DEFAULT_ACCOUNT_ID;

export function controlLabel(view: ClaudeAccountsView, agent: Partial<AgentAccountFields>): string {
  return agent.claudeAccountPin ? `${labelOf(view, agent.claudeAccountPin)} · pinned` : labelOf(view, runningOn(agent));
}

export function controlTitle(view: ClaudeAccountsView, agent: Partial<AgentAccountFields>): string {
  const running = labelOf(view, runningOn(agent));
  const pin = agent.claudeAccountPin;
  if (!pin) return `Runs on ${running}, chosen by Tars.`;
  if (pin === runningOn(agent)) return `Runs on ${running}, pinned by you. It stays there past its thresholds, and waits at its limit.`;
  return `Pinned by you to ${labelOf(view, pin)}. It runs on ${running} until its turn ends, then moves.`;
}

export interface AccountMenuOption {
  value: string;
  label: string;
  hint: string;
  hintTone: 'muted' | 'waiting' | 'error';
  disabled?: boolean;
  dividerBefore?: boolean;
}

function usageHint(a: ClaudeAccountState, settings: ClaudeAccountsSettings, now: Date): Pick<AccountMenuOption, 'hint' | 'hintTone' | 'disabled'> {
  if (a.signedIn === null) return { hint: 'checking', hintTone: 'muted', disabled: true };
  if (a.signedIn === false) return { hint: 'not signed in', hintTone: 'muted', disabled: true };
  if (!a.enabled) return { hint: 'turned off', hintTone: 'muted', disabled: true };
  if (isBlocked(a, now)) return { hint: `at its limit until ${formatReset(a.blockedUntil as number, now)}`, hintTone: 'error' };
  const full = [a.fiveHour, a.sevenDay].find(isFull);
  if (full) return { hint: `at its limit until ${formatReset(full.resetsAt, now)}`, hintTone: 'error' };
  const parts = [
    a.fiveHour && `5 h ${Math.round(a.fiveHour.usedPercentage)}%`,
    a.sevenDay && `week ${Math.round(a.sevenDay.usedPercentage)}%`,
  ].filter(Boolean);
  const past = (a.fiveHour !== null && a.fiveHour.usedPercentage >= settings.fiveHourThreshold)
    || (a.sevenDay !== null && a.sevenDay.usedPercentage >= settings.weeklyThreshold);
  return { hint: parts.length ? parts.join(' · ') : 'no use seen yet', hintTone: past ? 'waiting' : 'muted' };
}

/** Automatic, then every account with its use now. One that cannot take the agent cannot be picked. */
export function menuOptions(view: ClaudeAccountsView, agent: Partial<AgentAccountFields>, now: Date): AccountMenuOption[] {
  return [
    { value: AUTOMATIC, label: 'Automatic', hint: agent.claudeAccountPin ? 'Tars picks' : `now on ${labelOf(view, runningOn(agent))}`, hintTone: 'muted' },
    ...view.accounts.map((a, i) => ({ value: a.id, label: a.label, ...usageHint(a, view.settings, now), ...(i === 0 ? { dividerBefore: true } : {}) })),
  ];
}
