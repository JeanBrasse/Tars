import type { StatusTone } from '@/components/ui';
import type { RoomAgent } from '@/hooks/useRoomAgents';
import type { AgentStatus, BusMessage, BusThread } from '@/types/electron';
import { errorReason } from '@/app/agents/constants';

/**
 * What the Chat's left column says about a room and its agents, in one place.
 * Frames: `Chat · A · Room · agents at work` > `Left column`, and the sheet
 * `Chat · A · Team rows · states` in design/chat-redesign-a.pen.
 *
 * Everything here is decided from values the app already carries (the agent
 * list, the room's members, threads and messages), never from a guess: a
 * figure the bus does not give yet is left out rather than invented.
 */

/** How many agent messages an exchange runs without you before it pauses.
 *  The bus's own bound (electron/services/bus-store.ts, MAX_AGENT_MESSAGES). */
export const AGENT_MESSAGES_BEFORE_PAUSE = 10;

export type RowTone = StatusTone | 'hollow' | 'none';

export function agentTone(agent: RoomAgent): StatusTone | 'none' {
  // An agent whose CLI never reports a turn end has no state Tars can vouch
  // for, so it gets no colour rather than a green one that would claim work.
  if (!agent.hasEndOfTurn) return 'none';
  switch (agent.status) {
    case 'running': return 'running';
    case 'waiting': return 'waiting';
    case 'error': return 'error';
    default: return 'idle';
  }
}

/** Stopped as the room shows it. An error keeps its own word and its colour,
 *  since its reason says more than the absence of a session does. */
export function shownStopped(agent: RoomAgent): boolean {
  return agent.stopped && agent.status !== 'error';
}

export function agentStatusLabel(agent: RoomAgent): string {
  if (!agent.hasEndOfTurn) return 'no turn signal';
  // Idle is an agent at rest between turns, still holding its session, so the
  // word is only replaced when there is no session to rest in.
  if (shownStopped(agent)) return 'stopped';
  return agent.status === 'completed' ? 'finished' : agent.status;
}

/** The status word's ink: the tone's own for running, waiting and error, muted
 *  for an agent at rest, stopped, or whose state Tars cannot vouch for. The
 *  word carries the state; the mark says who it is. */
export function statusInk(agent: RoomAgent): string {
  const tone = agentTone(agent);
  if (tone === 'none' || shownStopped(agent)) return 'text-text-muted';
  if (tone === 'running') return 'text-status-running';
  if (tone === 'waiting') return 'text-status-waiting';
  if (tone === 'error') return 'text-status-error';
  return 'text-text-muted';
}

/**
 * What the agent is on, in words, on the row's second line.
 *
 * Not `statusLine`: that is the last raw line its terminal printed, which for
 * an idle CLI is its shell prompt. A prompt is not a description of work.
 */
export function agentDetail(agent: RoomAgent, lastSpokeAt?: string): string {
  if (!agent.hasEndOfTurn) return 'turns not visible';
  // Why it stopped before what it was asked: an agent whose turn failed still
  // has its task set, and the reason is the part worth reading.
  const reason = errorReason(agent);
  if (reason) return reason;
  // Before the task, which a stopped agent can still carry: it is on nothing.
  if (shownStopped(agent)) return 'no live session';
  if (agent.status === 'running' && agent.currentTask) return agent.currentTask;
  switch (agent.status) {
    case 'running': return 'working';
    // What it waits on (a permission prompt, a question) is not on the record
    // yet; its task is not the answer to that, so it is not shown here.
    case 'waiting': return 'waiting on you';
    case 'error': return agent.currentTask || 'stopped on an error';
    case 'completed': return lastSpokeAt ? `last spoke at ${lastSpokeAt}` : 'finished its turn';
    default: return lastSpokeAt ? `last spoke at ${lastSpokeAt}` : 'listening';
  }
}

/**
 * The model a row names, short and lowercase: `opus 5`, `sonnet 5`,
 * `haiku 4.5`. An agent on another CLI is named by its CLI (`amp`, `codex`),
 * which is what tells it apart in a room.
 */
export function shortModel(agent: Pick<AgentStatus, 'model' | 'sessionModel' | 'provider' | 'localModel'>): string {
  const model = (agent.sessionModel || agent.model || '').toLowerCase();
  const family = model.match(/(fable|mythos|opus|sonnet|haiku)(?:[-.]?(\d{1,2})(?:[-.](\d{1,2})(?!\d))?)?/);
  if (family) {
    const [, name, major, minor] = family;
    return major ? `${name} ${major}${minor ? `.${minor}` : ''}` : name;
  }
  if (agent.provider && agent.provider !== 'claude') return agent.provider;
  return agent.localModel?.toLowerCase() || model || 'claude';
}

/** HH:MM for today, the weekday for this week, the day and month before. */
export function timeLabel(iso: string | undefined, now: Date = new Date()): string {
  if (!iso) return '';
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return '';
  const days = (now.getTime() - at.getTime()) / 86_400_000;
  if (at.toDateString() === now.toDateString()) {
    return at.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false });
  }
  if (days < 6) return at.toLocaleDateString([], { weekday: 'short' });
  return at.toLocaleDateString([], { day: 'numeric', month: 'short' });
}

/** When each author last spoke in a room, as HH:MM, from the room's own log. */
export function lastSpoke(messages: BusMessage[]): Record<string, string> {
  const at: Record<string, string> = {};
  for (const m of messages) {
    if (m.authorKind !== 'agent') continue;
    at[m.authorId] = m.createdAt;
  }
  return Object.fromEntries(Object.entries(at).map(([id, iso]) => [id, timeLabel(iso)]));
}

export interface RoomState {
  tone: RowTone;
  word: string;
  detail?: string;
  /** Stop is offered only while the room relays: at rest there is nothing to stop. */
  relaying: boolean;
}

/**
 * The room's state, as its head says it. Frames: the room head of every
 * `Chat · A · Room` page.
 */
export function roomState(agents: RoomAgent[], thread: BusThread | null, messages: BusMessage[]): RoomState {
  if (agents.length === 0) return { tone: 'none', word: 'no agents', relaying: false };
  if (agents.every(a => a.stopped)) {
    return { tone: 'hollow', word: 'stopped', detail: 'nobody in this room is running', relaying: false };
  }
  if (thread?.state === 'bounded') {
    return { tone: 'idle', word: 'paused', detail: `${thread.agentMessageCount} agent messages without you`, relaying: false };
  }
  if (messages.length === 0) return { tone: 'idle', word: 'quiet', detail: 'nothing said yet', relaying: false };
  const working = agents.some(a => !a.stopped && a.status === 'running');
  if (thread?.state === 'open' && working) {
    const left = Math.max(0, AGENT_MESSAGES_BEFORE_PAUSE - thread.agentMessageCount);
    return {
      tone: 'running',
      word: 'relaying',
      detail: `pauses after ${left} more agent message${left === 1 ? '' : 's'}`,
      relaying: true,
    };
  }
  return { tone: 'idle', word: 'at rest', detail: 'every agent finished its turn', relaying: false };
}

export type RowActionId = 'open terminal' | 'start' | 'write' | 'send it' | 'stop' | 'remove from room';

export interface RowActions {
  /** The bordered button: what fits the agent's state. */
  primary: RowActionId;
  /** The ghost button beside it. */
  secondary: RowActionId;
  /** Behind the three dots: what changes the fleet, never on the row itself. */
  menu: RowActionId[];
}

/**
 * The actions an open team row offers. Frame: `Chat · A · Team rows · states`
 * > `UNFOLDED`. Stop is never offered to an agent Tars holds no session for,
 * whatever its record says.
 */
export function rowActions(agent: RoomAgent, notSent: number): RowActions {
  const stopped = shownStopped(agent);
  const menu: RowActionId[] = [...(stopped ? [] : ['stop' as const]), 'remove from room'];
  if (stopped) return { primary: 'start', secondary: 'write', menu };
  if (!agent.hasEndOfTurn && notSent > 0) return { primary: 'open terminal', secondary: 'send it', menu };
  return { primary: 'open terminal', secondary: 'write', menu };
}

export interface RowCount {
  label: string;
  tone?: 'waiting' | 'error';
}

/**
 * A room's line in the list: who needs you, who works, who is stopped,
 * counted from the fleet the app already reads. Queued and held counts for a
 * room you are not in need the bus's per-room figures, so they are only given
 * for the open room.
 */
export function roomCounts(
  agents: Array<Pick<AgentStatus, 'status' | 'cliRunning'>>,
  pending?: { queued: number; notSent: number },
): { tone: RowTone; counts: RowCount[] } {
  if (agents.length === 0) return { tone: 'none', counts: [{ label: 'no agents yet' }] };
  const needYou = agents.filter(a => a.status === 'waiting').length + (pending?.notSent ?? 0);
  const errors = agents.filter(a => a.status === 'error').length;
  const running = agents.filter(a => a.status === 'running').length;
  const stopped = agents.filter(a => a.cliRunning === false && a.status !== 'running' && a.status !== 'waiting' && a.status !== 'error').length;
  const idle = agents.length - running - stopped - errors - agents.filter(a => a.status === 'waiting').length;
  const counts: RowCount[] = [];
  if (errors) counts.push({ label: `${errors} error`, tone: 'error' });
  if (needYou) counts.push({ label: `${needYou} need${needYou === 1 ? 's' : ''} you`, tone: 'waiting' });
  if (running) counts.push({ label: `${running} running` });
  if (pending?.queued) counts.push({ label: `${pending.queued} queued` });
  if (!running && idle > 0) counts.push({ label: `${idle} idle` });
  if (stopped) counts.push({ label: `${stopped} stopped` });
  const tone: RowTone = errors ? 'error'
    : needYou ? 'waiting'
    : running ? 'running'
    : stopped === agents.length ? 'hollow'
    : 'idle';
  return { tone, counts: counts.length ? counts : [{ label: 'at rest' }] };
}
