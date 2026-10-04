import * as fs from 'fs';
import * as path from 'path';
import { randomUUID } from 'crypto';
import { writeAtomicSync } from '../utils/secret-file';
import type { MessageSender } from '../core/pty-manager';

/**
 * The tasks the Usage page prices: one record per piece of work an agent does,
 * from the turn that starts it to the rest that ends it, with who handed it
 * over and the task it was handed for (PLAN-1.9.3.md, item 2).
 *
 * Nothing in Tars kept this. `workHandedAt` is overwritten at each hand-off,
 * the end of a turn leaves no time, and `requestedBy` is spent once the result
 * is handed back. So the ledger listens where those already happen: a hand-off
 * (Tars types work in, or starts a session with it), the turn it starts
 * (UserPromptSubmit), and the state the agent comes to rest in. What a task
 * cost is not written here: it is read from the transcripts when asked
 * (task-cost.ts), so a price that changes later is the price shown.
 *
 * Kept in ~/.dorothy/task-ledger.jsonl, which every agent can read: a task's
 * text is cut to 200 characters, as `currentTask` is in agents.json.
 */

export type TaskSource = 'terminal' | 'agent' | 'tars' | 'telegram' | 'slack' | 'discord' | 'hermes' | 'acp';
export type TaskOutcome = 'running' | 'completed' | 'error' | 'stopped';

/** What the ledger reads of an agent: the fields of AgentStatus it needs. */
export interface TaskAgentView {
  id: string;
  status: 'idle' | 'running' | 'completed' | 'error' | 'waiting' | 'stopped';
  waitingReason?: string;
  projectPath?: string;
  worktreePath?: string;
  provider?: string;
  model?: string;
  claudeAccountId?: string | null;
}

export interface AcpUsage {
  inputTokens: number;
  outputTokens: number;
  cachedReadTokens: number;
  cachedWriteTokens: number;
  costUSD: number | null;
}

export interface TaskRecord {
  id: string;
  agentId: string;
  projectPath: string | null;
  /** Where the CLI ran when it was not the project itself: its transcripts are filed under it. */
  worktreePath: string | null;
  provider: string | null;
  model: string | null;
  accountId: string | null;
  source: TaskSource;
  requesterAgentId: string | null;
  parentTaskId: string | null;
  text: string;
  /** Epoch ms. */
  startedAt: number;
  endedAt: number | null;
  /** The last moment the ledger heard of it: where a task cut short by a quit ends. */
  lastAt: number;
  outcome: TaskOutcome;
  turns: number;
  sessionIds: string[];
  /** A delegation over ACP: what the run itself reported. */
  acp?: AcpUsage;
}

export interface HandOff {
  source: Exclude<TaskSource, 'terminal' | 'acp'>;
  requesterAgentId?: string;
  text: string;
}

export interface AcpRun {
  agent: TaskAgentView;
  requesterAgentId?: string;
  text: string;
  startedAt: number;
  endedAt: number;
  outcome: Exclude<TaskOutcome, 'running'>;
  usage: Omit<AcpUsage, 'costUSD'> | null;
  costUSD: number | null;
}

/** A hand-off not followed by a turn within this long started nothing. */
const HAND_OFF_TTL_MS = 15 * 60_000;
const TEXT_MAX = 200;
const DEFAULT_MAX_LINES = 20_000;

/** One line of text, at most 200 characters, never a character cut in two. */
function clip(text: string | undefined): string {
  return Array.from((text ?? '').replace(/\s+/g, ' ').trim()).slice(0, TEXT_MAX).join('');
}

/**
 * How the agent's state ends its open task, or null when it does not: at
 * rest, as agent-watch.ts reads it (idle, stopped, or waiting for its next
 * prompt), or done or failed. A permission prompt or a question is not an end.
 */
export function endingOf(agent: TaskAgentView): Exclude<TaskOutcome, 'running'> | null {
  switch (agent.status) {
    case 'error': return 'error';
    case 'stopped': return 'stopped';
    case 'idle':
    case 'completed': return 'completed';
    case 'waiting': return agent.waitingReason === 'idle' ? 'completed' : null;
    default: return null;
  }
}

type Line =
  | { t: 'task'; task: TaskRecord }
  | { t: 'turn'; id: string; at: number; sessionId?: string }
  | { t: 'end'; id: string; at: number; outcome: Exclude<TaskOutcome, 'running'> };

export interface TaskLedger {
  handedOff(agentId: string, handOff: HandOff): void;
  turnStarted(agent: TaskAgentView, turn: { sessionId?: string; text?: string }): void;
  stateChanged(agent: TaskAgentView, opts?: { backgroundLeft?: boolean }): void;
  acpRun(run: AcpRun): void;
  openTaskOf(agentId: string): TaskRecord | undefined;
  tasks(): TaskRecord[];
}

export function createTaskLedger(opts: { file: string; now?: () => number; maxLines?: number }): TaskLedger {
  const { file } = opts;
  const now = opts.now ?? Date.now;
  const maxLines = opts.maxLines ?? DEFAULT_MAX_LINES;

  const byId = new Map<string, TaskRecord>();
  const open = new Map<string, string>();
  const pending = new Map<string, HandOff & { at: number; parentTaskId: string | null }>();
  let lines = 0;

  const apply = (line: Line): void => {
    if (line.t === 'task') {
      byId.set(line.task.id, { ...line.task, sessionIds: [...line.task.sessionIds] });
      return;
    }
    const task = byId.get(line.id);
    if (!task || task.endedAt !== null) return;
    if (line.t === 'turn') {
      task.turns += 1;
      task.lastAt = Math.max(task.lastAt, line.at);
      if (line.sessionId && !task.sessionIds.includes(line.sessionId)) task.sessionIds.push(line.sessionId);
    } else {
      task.endedAt = line.at;
      task.lastAt = Math.max(task.lastAt, line.at);
      task.outcome = line.outcome;
    }
  };

  const write = (line: Line): void => {
    apply(line);
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.appendFileSync(file, JSON.stringify(line) + '\n');
      lines += 1;
      if (lines > maxLines) compact();
    } catch (err) {
      console.warn('[task-ledger] could not write:', (err as Error).message);
    }
  };

  /** The file again, one line per task, the newest half of the bound kept. */
  const compact = (): void => {
    const kept = [...byId.values()].sort((a, b) => a.startedAt - b.startedAt).slice(-Math.floor(maxLines / 2));
    byId.clear();
    for (const task of kept) byId.set(task.id, task);
    writeAtomicSync(file, kept.map((task) => JSON.stringify({ t: 'task', task }) + '\n').join(''));
    lines = kept.length;
  };

  // What was written before: a damaged line is skipped, the rest read. A task
  // still open was cut short by a quit, and ends where it was last heard of.
  let raw = '';
  try {
    raw = fs.readFileSync(file, 'utf-8');
  } catch { /* none yet */ }
  for (const text of raw.split('\n')) {
    if (!text.trim()) continue;
    lines += 1;
    try {
      const line = JSON.parse(text) as Line;
      if (line && (line.t === 'task' ? line.task?.id : typeof line.id === 'string')) apply(line);
    } catch { /* damaged: skipped */ }
  }
  for (const task of byId.values()) {
    if (task.endedAt === null) write({ t: 'end', id: task.id, at: task.lastAt, outcome: 'stopped' });
  }

  const openTaskOf = (agentId: string): TaskRecord | undefined => {
    const id = open.get(agentId);
    return id ? byId.get(id) : undefined;
  };

  return {
    handedOff(agentId, handOff) {
      const requester = handOff.requesterAgentId && handOff.requesterAgentId !== agentId
        ? openTaskOf(handOff.requesterAgentId) : undefined;
      pending.set(agentId, { ...handOff, text: clip(handOff.text), at: now(), parentTaskId: requester?.id ?? null });
    },

    turnStarted(agent, turn) {
      const at = now();
      // A hand-off is taken by the first turn after it, whichever task that
      // turn belongs to: typed in while a task was open, it is that task's.
      const handOff = pending.get(agent.id);
      pending.delete(agent.id);
      const current = openTaskOf(agent.id);
      if (current) {
        write({ t: 'turn', id: current.id, at, sessionId: turn.sessionId });
        return;
      }
      const fresh = handOff && at - handOff.at <= HAND_OFF_TTL_MS ? handOff : undefined;
      const task: TaskRecord = {
        id: randomUUID(),
        agentId: agent.id,
        projectPath: agent.projectPath ?? null,
        worktreePath: agent.worktreePath ?? null,
        provider: agent.provider ?? null,
        model: agent.model ?? null,
        accountId: agent.claudeAccountId ?? null,
        source: fresh?.source ?? 'terminal',
        requesterAgentId: fresh?.requesterAgentId ?? null,
        parentTaskId: fresh?.parentTaskId ?? null,
        text: fresh ? fresh.text : clip(turn.text),
        startedAt: at,
        endedAt: null,
        lastAt: at,
        outcome: 'running',
        turns: 1,
        sessionIds: turn.sessionId ? [turn.sessionId] : [],
      };
      open.set(agent.id, task.id);
      write({ t: 'task', task });
    },

    stateChanged(agent, opts) {
      const task = openTaskOf(agent.id);
      if (!task) return;
      const outcome = endingOf(agent);
      if (!outcome) return;
      // Resting with work still running in the background is not the end: the
      // agent comes back when that work reports (agent-watch.ts says why).
      if (outcome === 'completed' && opts?.backgroundLeft) return;
      open.delete(agent.id);
      write({ t: 'end', id: task.id, at: now(), outcome });
    },

    acpRun(run) {
      const requester = run.requesterAgentId && run.requesterAgentId !== run.agent.id
        ? openTaskOf(run.requesterAgentId) : undefined;
      write({
        t: 'task',
        task: {
          id: randomUUID(),
          agentId: run.agent.id,
          projectPath: run.agent.projectPath ?? null,
          worktreePath: run.agent.worktreePath ?? null,
          provider: run.agent.provider ?? null,
          model: run.agent.model ?? null,
          accountId: run.agent.claudeAccountId ?? null,
          source: 'acp',
          requesterAgentId: run.requesterAgentId ?? null,
          parentTaskId: requester?.id ?? null,
          text: clip(run.text),
          startedAt: run.startedAt,
          endedAt: run.endedAt,
          lastAt: run.endedAt,
          outcome: run.outcome,
          turns: 1,
          sessionIds: [],
          acp: {
            inputTokens: run.usage?.inputTokens ?? 0,
            outputTokens: run.usage?.outputTokens ?? 0,
            cachedReadTokens: run.usage?.cachedReadTokens ?? 0,
            cachedWriteTokens: run.usage?.cachedWriteTokens ?? 0,
            costUSD: run.costUSD,
          },
        },
      });
    },

    openTaskOf,

    tasks() {
      return [...byId.values()].sort((a, b) => a.startedAt - b.startedAt).map((t) => ({ ...t, sessionIds: [...t.sessionIds] }));
    },
  };
}

/**
 * The app's ledger, once main.ts has started it (task-watch.ts). Null before
 * that and in the tests of everything else, where a hand-off or a turn is then
 * simply not recorded.
 */
let live: TaskLedger | null = null;

export function setLiveTaskLedger(ledger: TaskLedger | null): void {
  live = ledger;
}

export function liveTaskLedger(): TaskLedger | null {
  return live;
}

/** Who handed the work over, from the sender Tars typed before it. */
export function handOffFrom(sender: MessageSender | undefined): Pick<HandOff, 'source' | 'requesterAgentId'> {
  if (sender?.kind === 'agent') return { source: 'agent', requesterAgentId: sender.id };
  if (sender?.kind === 'channel') return { source: sender.channel.toLowerCase() as HandOff['source'] };
  return { source: 'tars' };
}

/** Recorded, never thrown: a ledger that cannot write must not stop the work it describes. */
export function noteHandOff(agentId: string, handOff: HandOff): void {
  try {
    live?.handedOff(agentId, handOff);
  } catch (err) {
    console.warn('[task-ledger] hand-off not recorded:', (err as Error).message);
  }
}
