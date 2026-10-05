import type { TaskEntry } from '@/types/electron';
import { getProviderDef } from '@/lib/providers';
import { fmtUsd } from '@/lib/usage-format';
import { flat } from '@/lib/stop-line';

/**
 * What the Usage page says of each task (#305's usage.tasks), and the averages
 * it draws from them. Frame: `Usage · cost per task`, and its light copy. Its
 * failures are listed, and pinned, in __tests__/lib/task-costs.test.ts.
 */

const DAY = 86_400_000;

/** Tasks shown at first, and added by each "show more". */
export const TASKS_PAGE = 20;

/**
 * usage.tasks counts back in 24-hour periods from main's clock; the page reads
 * its own window, 14 days from local midnight 13 days back or 24 hours from the
 * hour 23 hours back. Asked a minute early, so main's clock, a moment later,
 * still reaches the window's first task; inWindow then cuts at its start.
 */
export function sinceDaysFor(start: Date, now: number): number {
  return Math.max(now - start.getTime() + 60_000, 60_000) / DAY;
}

export function inWindow(tasks: TaskEntry[], start: Date): TaskEntry[] {
  const from = start.getTime();
  return tasks.filter(t => t.startedAt >= from);
}

export interface TaskFilter {
  projectPath: string | null;
  agentId: string | null;
}

export function filterTasks(tasks: TaskEntry[], filter: TaskFilter): TaskEntry[] {
  return tasks.filter(t => (!filter.projectPath || t.projectPath === filter.projectPath)
    && (!filter.agentId || t.agentId === filter.agentId));
}

export interface FilterOption {
  value: string;
  label: string;
  hint: string;
}

const countOf = (n: number) => (n === 1 ? '1 task' : `${n} tasks`);

function optionsBy(tasks: TaskEntry[], keyOf: (t: TaskEntry) => string | null, labelOf: (key: string) => string): FilterOption[] {
  const counts = new Map<string, number>();
  for (const t of tasks) {
    const key = keyOf(t);
    if (key) counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return [...counts]
    .map(([value, n]) => ({ value, label: labelOf(value), hint: countOf(n) }))
    .sort((a, b) => a.label.localeCompare(b.label) || a.value.localeCompare(b.value));
}

/** The projects of the window's tasks, by their folder's name. */
export function projectOptions(tasks: TaskEntry[]): FilterOption[] {
  return optionsBy(tasks, t => t.projectPath, value => value.split(/[\\/]/).filter(Boolean).pop() ?? value);
}

/** The agents of the window's tasks, by their names as they are now; one deleted has none. */
export function agentOptions(tasks: TaskEntry[], names: Record<string, string>): FilterOption[] {
  return optionsBy(tasks, t => t.agentId, value => agentName(value, names));
}

/**
 * An agent's name on one line: names are typed by a person or chosen by an
 * agent, and a U+202E or a line break in one turned its row around (the
 * Audit's Low at #311's gate). Flattened as stop-line flattens a name.
 */
export function agentName(agentId: string, names: Record<string, string>): string {
  return agentId in names ? flat(names[agentId]) : 'deleted agent';
}

/** A task's text on one line, the prompt as it was handed over, flattened as a name is. */
export function taskText(task: TaskEntry): string {
  return flat(task.text);
}

/** The model that did most of a task's work, as its replies name it; the one it was launched on when none was counted. */
export function dominantModel(task: TaskEntry): string | null {
  let best: string | null = null;
  for (const [model, cost] of Object.entries(task.byModel)) {
    if (best === null || cost > task.byModel[best]) best = model;
  }
  return best ?? task.model;
}

export interface AverageRow {
  key: string;
  tasks: number;
  /** Of those, the ones whose cost is known. */
  counted: number;
  /** Mean over the counted ones; null when none is. */
  costUSD: number | null;
  /** Mean over the ended ones; null when none has. */
  durationMs: number | null;
}

/** The averages of the tasks listed, grouped by `keyOf`: the most tasks first, then the dearest, the uncounted last. */
export function averagesBy(tasks: TaskEntry[], keyOf: (t: TaskEntry) => string): AverageRow[] {
  const sums = new Map<string, { tasks: number; counted: number; cost: number; ended: number; duration: number }>();
  for (const t of tasks) {
    const key = keyOf(t);
    const s = sums.get(key) ?? { tasks: 0, counted: 0, cost: 0, ended: 0, duration: 0 };
    s.tasks += 1;
    if (t.costUSD !== null) { s.counted += 1; s.cost += t.costUSD; }
    if (t.durationMs !== null) { s.ended += 1; s.duration += t.durationMs; }
    sums.set(key, s);
  }
  return [...sums]
    .map(([key, s]) => ({
      key,
      tasks: s.tasks,
      counted: s.counted,
      costUSD: s.counted ? s.cost / s.counted : null,
      durationMs: s.ended ? s.duration / s.ended : null,
    }))
    .sort((a, b) => b.tasks - a.tasks
      || (b.costUSD ?? -1) - (a.costUSD ?? -1)
      || a.key.localeCompare(b.key));
}

const FROM: Record<string, string> = { tars: 'Tars', telegram: 'Telegram', slack: 'Slack', discord: 'Discord', hermes: 'Hermes' };

/** Who handed the task over: typed in its window, an agent, Tars, a chat, or a run over ACP. */
export function sourceText(task: TaskEntry, names: Record<string, string>): string {
  const requester = task.requesterAgentId && task.requesterAgentId in names ? agentName(task.requesterAgentId, names) : undefined;
  switch (task.source) {
    case 'terminal': return 'typed';
    case 'agent': return `from ${requester ?? 'an agent'}`;
    case 'acp': return requester ? `over ACP, from ${requester}` : 'over ACP';
    default: return `from ${FROM[task.source] ?? task.source}`;
  }
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const pad = (n: number) => String(n).padStart(2, '0');
const sameDay = (a: Date, b: Date) => a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
const clock = (d: Date) => `${pad(d.getHours())}:${pad(d.getMinutes())}`;

/** `4 Oct 23:58` this year, `4 Oct 2025` another. */
function dated(at: Date, now: Date): string {
  const date = `${at.getDate()} ${MONTHS[at.getMonth()]}`;
  return at.getFullYear() === now.getFullYear() ? `${date} ${clock(at)}` : `${date} ${at.getFullYear()}`;
}

/** `14:02` today, with its date another day. */
export function startLabel(ms: number, now: Date): string {
  const at = new Date(ms);
  return sameDay(at, now) ? clock(at) : dated(at, now);
}

/**
 * `running`; the time alone on the day the task started; with its date on
 * another, today's included, so it never reads as a time of the start's day.
 */
export function endLabel(task: TaskEntry, now: Date): string {
  if (task.endedAt === null) return 'running';
  const end = new Date(task.endedAt);
  return sameDay(end, new Date(task.startedAt)) ? clock(end) : dated(end, now);
}

/** `42 s`, `29 min`, `1 h 05`; `-` while the task runs. */
export function durationLabel(ms: number | null): string {
  if (ms === null) return '-';
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds} s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} min`;
  return `${Math.floor(minutes / 60)} h ${pad(minutes % 60)}`;
}

/** Every token the task's replies spent, the cache's included; null when not counted. */
export function tokensTotal(task: TaskEntry): number | null {
  const t = task.tokens;
  return t ? t.input + t.output + t.cacheRead + t.cacheWrite : null;
}

/**
 * The provider, with the Claude account the task ran on when there is one by
 * that id now (`Claude · Second`). An agent that never set its provider runs
 * Claude.
 */
export function providerText(task: TaskEntry, accountLabels: Record<string, string>): string {
  const provider = task.provider ?? 'claude';
  if (provider === 'claude') {
    const account = task.accountId ? accountLabels[task.accountId] : undefined;
    return account ? `Claude · ${account}` : 'Claude';
  }
  return getProviderDef(provider)?.label ?? provider;
}

/** A cost as the page writes it, or `not counted`: never $0.00 for what was not read. */
export function moneyText(cost: number | null): string {
  return cost === null ? 'not counted' : fmtUsd(cost);
}

/** The total with the work handed on, partial when a task in it is not counted. */
export function totalText(task: TaskEntry): { text: string; partial: boolean } {
  if (task.costUSD === null && task.totalCostUSD === 0) return { text: 'not counted', partial: false };
  return { text: fmtUsd(task.totalCostUSD), partial: task.totalPartial };
}

/** `show 20 more`, or what is left when it is less; null when every task is shown. */
export function moreLabel(shown: number, total: number): string | null {
  const next = Math.min(TASKS_PAGE, total - shown);
  return next > 0 ? `show ${next} more` : null;
}
