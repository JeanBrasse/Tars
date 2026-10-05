import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { readUsageLines, pricingFor, costOf, diff, add, type Counts, type Pricing } from './transcript-usage';
import { transcriptPath, transcriptRoots } from '../utils/resume-session';
import type { TaskRecord } from './task-ledger';

/**
 * What each task cost, read from the transcripts of the sessions it ran in and
 * priced as the Usage page prices them (transcript-usage.ts), when asked.
 *
 * A reply belongs to the task of its session that had started when it was
 * written, the latest one: the ledger opens a task at a turn, so between the
 * start of one and the start of the next, every reply of that session is the
 * first one's, the work it left in the background included. A reply from
 * before every task of its session (a resumed session copies the earlier
 * conversation in, with its old timestamps) belongs to none.
 *
 * A task none of whose sessions left a transcript is not counted, and says so
 * with a null: a CLI that writes none, an agent of another provider, a task
 * whose session was never heard of. Zero would read as free.
 */

export interface TaskTokens {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

export interface TaskCost {
  /** Null: not counted. */
  costUSD: number | null;
  tokens: TaskTokens | null;
  /** Cost per model the replies came from. */
  byModel: Record<string, number>;
}

interface TimedLine {
  key: string;
  model: string;
  at: number;
  counts: Counts;
}

const ZERO: Counts = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, write1h: 0, write5m: 0, searches: 0 };

/** Parsed files, kept while unchanged: a session still being written is read again, the others not. */
const fileCache = new Map<string, { mtimeMs: number; size: number; lines: TimedLine[] }>();
const FILE_CACHE_MAX = 32;

async function timedLinesOf(file: string): Promise<{ mtimeMs: number; lines: TimedLine[] } | null> {
  let stat: fs.Stats;
  try {
    stat = fs.statSync(file);
  } catch {
    return null;
  }
  const cached = fileCache.get(file);
  if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) {
    fileCache.delete(file);
    fileCache.set(file, cached);
    return cached;
  }
  const read = await readUsageLines(file);
  if (read === null) return null;
  const lines: TimedLine[] = [];
  for (const { key, model, timestamp, counts } of read) {
    const at = timestamp ? Date.parse(timestamp) : NaN;
    if (Number.isFinite(at)) lines.push({ key, model, at, counts });
  }
  fileCache.set(file, { mtimeMs: stat.mtimeMs, size: stat.size, lines });
  while (fileCache.size > FILE_CACHE_MAX) fileCache.delete(fileCache.keys().next().value as string);
  return { mtimeMs: stat.mtimeMs, lines };
}

/** The session's transcript and its subagents', under the first folder that holds it. */
function filesOfSession(task: TaskRecord, sessionId: string, homeDir: string): string[] {
  for (const root of transcriptRoots(task.worktreePath ?? undefined, task.projectPath ?? undefined)) {
    const main = transcriptPath(root, sessionId, homeDir);
    if (!fs.existsSync(main)) continue;
    const files = [main];
    const subagents = path.join(path.dirname(main), sessionId, 'subagents');
    try {
      for (const name of fs.readdirSync(subagents)) {
        if (name.endsWith('.jsonl')) files.push(path.join(subagents, name));
      }
    } catch { /* none */ }
    return files;
  }
  return [];
}

export async function readTaskCosts(tasks: TaskRecord[], opts: { homeDir?: string } = {}): Promise<Map<string, TaskCost>> {
  const homeDir = opts.homeDir ?? os.homedir();
  const out = new Map<string, TaskCost>();

  // Each session's tasks, in the order they started.
  const sessions = new Map<string, TaskRecord[]>();
  const found = new Set<string>();
  const files: Array<{ file: string; sessionId: string }> = [];
  for (const task of tasks) {
    if (task.acp) {
      out.set(task.id, {
        costUSD: task.acp.costUSD,
        tokens: { input: task.acp.inputTokens, output: task.acp.outputTokens, cacheRead: task.acp.cachedReadTokens, cacheWrite: task.acp.cachedWriteTokens },
        byModel: task.acp.costUSD !== null && task.model ? { [task.model]: task.acp.costUSD } : {},
      });
      continue;
    }
    for (const sessionId of task.sessionIds) {
      let list = sessions.get(sessionId);
      if (!list) {
        list = [];
        sessions.set(sessionId, list);
        for (const file of filesOfSession(task, sessionId, homeDir)) files.push({ file, sessionId });
      }
      list.push(task);
    }
  }
  for (const list of sessions.values()) list.sort((a, b) => a.startedAt - b.startedAt);

  const read: Array<{ sessionId: string; mtimeMs: number; lines: TimedLine[] }> = [];
  for (const { file, sessionId } of files) {
    const parsed = await timedLinesOf(file);
    if (!parsed) continue;
    read.push({ sessionId, ...parsed });
    for (const task of sessions.get(sessionId) ?? []) found.add(task.id);
  }
  // Oldest first, as on the Usage page: a reply is its first writer's.
  read.sort((a, b) => a.mtimeMs - b.mtimeMs);

  // One reply is written as several lines whose usage grows, the last one
  // whole: each line tops up what its key has already given (transcript-usage.ts).
  const applied = new Map<string, { taskId: string; counts: Counts }>();
  const perTask = new Map<string, Map<string, Counts>>();
  for (const { sessionId, lines } of read) {
    const owners = sessions.get(sessionId) ?? [];
    for (const line of lines) {
      const prior = applied.get(line.key);
      let taskId = prior?.taskId;
      if (!taskId) {
        let owner: TaskRecord | undefined;
        for (const task of owners) if (task.startedAt <= line.at) owner = task;
        if (!owner) continue;
        taskId = owner.id;
      }
      const delta = diff(line.counts, prior?.counts ?? ZERO);
      applied.set(line.key, { taskId, counts: add(prior?.counts ?? ZERO, delta) });
      let models = perTask.get(taskId);
      if (!models) {
        models = new Map();
        perTask.set(taskId, models);
      }
      models.set(line.model, add(models.get(line.model) ?? ZERO, delta));
    }
  }

  const prices = new Map<string, Pricing>();
  for (const task of tasks) {
    if (task.acp) continue;
    if (!found.has(task.id)) {
      out.set(task.id, { costUSD: null, tokens: null, byModel: {} });
      continue;
    }
    const tokens: TaskTokens = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
    const byModel: Record<string, number> = {};
    let costUSD = 0;
    for (const [model, counts] of perTask.get(task.id) ?? []) {
      let price = prices.get(model);
      if (!price) {
        price = pricingFor(model);
        prices.set(model, price);
      }
      const cost = costOf(price, counts);
      byModel[model] = cost;
      costUSD += cost;
      tokens.input += counts.input;
      tokens.output += counts.output;
      tokens.cacheRead += counts.cacheRead;
      tokens.cacheWrite += counts.cacheWrite;
    }
    out.set(task.id, { costUSD, tokens, byModel });
  }
  return out;
}

export interface TaskQuery {
  /** An exact start, ms since the epoch: the tasks started from it. Before `sinceDays` when both are given. */
  since?: number;
  sinceDays?: number;
  projectPath?: string;
  agentId?: string;
}

export interface TaskView extends TaskRecord, TaskCost {
  /** Its own cost and that of every task handed on from it, down the line. */
  totalCostUSD: number;
  /** The total leaves out a task not counted. */
  totalPartial: boolean;
  /** Null while it runs. */
  durationMs: number | null;
}

export interface TaskAverage {
  tasks: number;
  /** Of those, the ones whose cost is known. */
  counted: number;
  /** Mean over the counted ones; null when none is. */
  costUSD: number | null;
  /** Mean over the ended ones; null when none has. */
  durationMs: number | null;
}

export interface TaskReport {
  /** Newest first. */
  tasks: TaskView[];
  averages: { byAgent: Record<string, TaskAverage>; byModel: Record<string, TaskAverage> };
  /** Tasks in the report whose cost is not known. */
  notCounted: number;
}

/** The tasks a query asks for: the period, the project, the agent. */
export function selectTasks(tasks: TaskRecord[], query: TaskQuery, now: number): TaskRecord[] {
  const since = typeof query.since === 'number' && Number.isFinite(query.since) ? query.since
    : typeof query.sinceDays === 'number' && query.sinceDays > 0 ? now - query.sinceDays * 86_400_000 : -Infinity;
  return tasks.filter((t) => t.startedAt >= since
    && (!query.projectPath || t.projectPath === query.projectPath)
    && (!query.agentId || t.agentId === query.agentId));
}

/** The selected tasks and every task handed on from them, which their totals need priced. */
export function withDescendants(selected: TaskRecord[], all: TaskRecord[]): TaskRecord[] {
  const ids = new Set(selected.map((t) => t.id));
  let grew = true;
  while (grew) {
    grew = false;
    for (const t of all) {
      if (t.parentTaskId && ids.has(t.parentTaskId) && !ids.has(t.id)) {
        ids.add(t.id);
        grew = true;
      }
    }
  }
  return all.filter((t) => ids.has(t.id));
}

export function taskReport(tasks: TaskRecord[], costs: Map<string, TaskCost>, query: TaskQuery, now: number): TaskReport {
  const children = new Map<string, TaskRecord[]>();
  for (const t of tasks) {
    if (!t.parentTaskId) continue;
    const list = children.get(t.parentTaskId) ?? [];
    list.push(t);
    children.set(t.parentTaskId, list);
  }
  const totalOf = (id: string, seen: Set<string>): { cost: number; partial: boolean } => {
    seen.add(id);
    const own = costs.get(id)?.costUSD ?? null;
    let cost = own ?? 0;
    let partial = own === null;
    for (const child of children.get(id) ?? []) {
      if (seen.has(child.id)) continue;
      const sub = totalOf(child.id, seen);
      cost += sub.cost;
      partial ||= sub.partial;
    }
    return { cost, partial };
  };

  const views: TaskView[] = selectTasks(tasks, query, now)
    .sort((a, b) => b.startedAt - a.startedAt)
    .map((t) => {
      const cost = costs.get(t.id) ?? { costUSD: null, tokens: null, byModel: {} };
      const total = totalOf(t.id, new Set());
      return {
        ...t,
        ...cost,
        totalCostUSD: total.cost,
        totalPartial: total.partial,
        durationMs: t.endedAt !== null ? t.endedAt - t.startedAt : null,
      };
    });

  type Sum = { tasks: number; counted: number; cost: number; ended: number; duration: number };
  const tally = (sums: Map<string, Sum>, bucket: string, v: TaskView) => {
    const s = sums.get(bucket) ?? { tasks: 0, counted: 0, cost: 0, ended: 0, duration: 0 };
    s.tasks += 1;
    if (v.costUSD !== null) { s.counted += 1; s.cost += v.costUSD; }
    if (v.durationMs !== null) { s.ended += 1; s.duration += v.durationMs; }
    sums.set(bucket, s);
  };
  const agentSums = new Map<string, Sum>();
  const modelSums = new Map<string, Sum>();
  for (const v of views) {
    tally(agentSums, v.agentId, v);
    // The model that did most of the work, as the replies name it; the one the
    // agent was launched on when no reply was counted.
    const dominant = Object.entries(v.byModel).sort((a, b) => b[1] - a[1])[0]?.[0];
    tally(modelSums, dominant ?? v.model ?? v.provider ?? 'unknown', v);
  }
  const averagesOf = (sums: Map<string, Sum>): Record<string, TaskAverage> => {
    const out: Record<string, TaskAverage> = Object.create(null);
    for (const [name, s] of sums) {
      out[name] = {
        tasks: s.tasks,
        counted: s.counted,
        costUSD: s.counted ? s.cost / s.counted : null,
        durationMs: s.ended ? s.duration / s.ended : null,
      };
    }
    return out;
  };

  return { tasks: views, averages: { byAgent: averagesOf(agentSums), byModel: averagesOf(modelSums) }, notCounted: views.filter((v) => v.costUSD === null).length };
}
