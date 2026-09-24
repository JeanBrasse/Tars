import type { StatusTone } from '@/components/ui';
import type { RoomAgent } from '@/hooks/useRoomAgents';
import type { AgentStatus, BusDelivery, BusMessage, BusThread } from '@/types/electron';
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
  // An error is something Tars saw happen (an exit, a start that failed, a
  // turn the CLI said failed), so it keeps its colour on any CLI.
  if (agent.status === 'error') return 'error';
  // Starting: its session is not up yet, so it is neither at work nor at rest.
  if (agent.launching) return 'idle';
  // An agent whose CLI never reports a turn end has no state Tars can vouch
  // for, so it gets no colour rather than a green one that would claim work.
  if (!agent.hasEndOfTurn) return 'none';
  switch (agent.status) {
    case 'running': return 'running';
    case 'waiting': return 'waiting';
    default: return 'idle';
  }
}

/** Stopped as the room shows it. An error keeps its own word and its colour,
 *  since its reason says more than the absence of a session does. */
export function shownStopped(agent: RoomAgent): boolean {
  return agent.stopped && agent.status !== 'error';
}

export function agentStatusLabel(agent: RoomAgent): string {
  if (agent.status === 'error') return 'error';
  // A launch on its way (a restart, a start from a window, a bot's cold start):
  // the frame's `starting`, never `stopped` with start offered again.
  if (agent.launching) return 'starting';
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
  if (tone === 'none' || shownStopped(agent) || agent.launching) return 'text-text-muted';
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
export function agentDetail(agent: RoomAgent, lastSpokeAt?: string, held = 0, joinedAt?: string): string {
  // Why it stopped before what it was asked, on any CLI: an agent whose turn
  // failed still has its task set, and the reason is the part worth reading.
  const reason = errorReason(agent);
  if (reason) return reason;
  if (agent.status === 'error') return agent.currentTask || 'stopped on an error';
  // The frame's `joined at 09:52` for a member added and not yet up; a restart
  // of one already here has no join to name.
  if (agent.launching) return joinedAt ? `joined at ${joinedAt}` : 'starting its session';
  // What is in the way right now: its terminal holds messages behind a draft.
  if (held > 0) return 'a draft in its field';
  if (!agent.hasEndOfTurn) return 'turns not visible';
  // Before the task, which a stopped agent can still carry: it is on nothing.
  if (shownStopped(agent)) return 'no live session';
  if (agent.status === 'running' && agent.currentTask) return agent.currentTask;
  switch (agent.status) {
    case 'running': return 'working';
    // What it waits on, when it is a dialog its CLI shows (#172's waitingOn);
    // the idle prompt carries none.
    case 'waiting': return agent.waitingOn
      ? (agent.waitingOn.kind === 'permission' ? 'permission dialog' : 'a question for you')
      : 'waiting on you';
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

/** How long, short: `4m`, `2h`, `3d`. Under a minute reads as `1m`. */
export function elapsed(iso: string | undefined, now: number = Date.now()): string {
  if (!iso) return '';
  const at = Date.parse(iso);
  if (Number.isNaN(at)) return '';
  const minutes = Math.max(1, Math.floor((now - at) / 60_000));
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  return hours < 24 ? `${hours}h` : `${Math.floor(hours / 24)}d`;
}

/**
 * How long an agent has been working, waiting or in error, from #172's
 * `statusSince`: the frame's mono `4m` after the status word. Not for rest,
 * a stop or a start, where how long is not the point.
 */
export function agentDuration(agent: RoomAgent, now?: number): string {
  if (agent.launching || shownStopped(agent) || (!agent.hasEndOfTurn && agent.status !== 'error')) return '';
  if (agent.status !== 'running' && agent.status !== 'waiting' && agent.status !== 'error') return '';
  return elapsed(agent.statusSince, now);
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

/**
 * When each agent joined the room, for the ones that have not spoken since:
 * a member added and still starting says so. From the room's own log, as
 * `lastSpoke` is.
 */
export function joinedSilent(messages: BusMessage[]): Record<string, string> {
  const at: Record<string, string> = {};
  for (const m of messages) {
    if (m.authorKind === 'agent') delete at[m.authorId];
    else if (m.systemKind === 'members_changed') {
      for (const id of m.systemData?.added ?? []) at[id] = m.createdAt;
      for (const id of m.systemData?.removed ?? []) delete at[id];
    }
  }
  return Object.fromEntries(Object.entries(at).map(([id, iso]) => [id, timeLabel(iso)]));
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
  /** The ghost button beside it, when there is one. */
  secondary: RowActionId | null;
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
  // Starting: the frame offers the terminal alone, and never start again.
  if (agent.launching) return { primary: 'open terminal', secondary: null, menu };
  if (stopped) return { primary: 'start', secondary: 'write', menu };
  // Whatever it was refused for, a message not sent moves only when you send
  // it: an agent started again still holds what came while it was stopped.
  if (notSent > 0) return { primary: 'open terminal', secondary: 'send it', menu };
  return { primary: 'open terminal', secondary: 'write', menu };
}

export interface RowCount {
  label: string;
  tone?: 'waiting' | 'error';
}

/**
 * A room's line in the list: who needs you, who works, who is stopped,
 * counted from the fleet the app already reads. In the open room, what needs
 * you is what its strip lists, errors apart since the line counts those
 * itself, so the two never disagree. A room you are not in needs the bus's
 * per-room figures for its deliveries, so there only waiting agents count.
 */
export function roomCounts(
  agents: Array<Pick<AgentStatus, 'status' | 'cliRunning' | 'launching'>>,
  open?: { queued: number; needYou: number },
  /** The bus's count of what is queued in the room, for a room you are not in. */
  queuedElsewhere = 0,
): { tone: RowTone; counts: RowCount[] } {
  if (agents.length === 0) return { tone: 'none', counts: [{ label: 'no agents yet' }] };
  const waiting = agents.filter(a => a.status === 'waiting').length;
  const needYou = open ? open.needYou : waiting;
  const errors = agents.filter(a => a.status === 'error').length;
  const running = agents.filter(a => a.status === 'running').length;
  // A launch on its way is neither stopped nor idle, and the frame's line does
  // not count it: its row says `starting`.
  const starting = agents.filter(a => a.launching).length;
  const stopped = agents.filter(a => !a.launching && a.cliRunning === false && a.status !== 'running' && a.status !== 'waiting' && a.status !== 'error').length;
  const idle = agents.length - running - stopped - errors - waiting - starting;
  const counts: RowCount[] = [];
  if (errors) counts.push({ label: `${errors} error`, tone: 'error' });
  if (needYou) counts.push({ label: `${needYou} need${needYou === 1 ? 's' : ''} you`, tone: 'waiting' });
  if (running) counts.push({ label: `${running} running` });
  const queued = open ? open.queued : queuedElsewhere;
  if (queued) counts.push({ label: `${queued} queued` });
  if (!running && idle > 0) counts.push({ label: `${idle} idle` });
  if (stopped) counts.push({ label: `${stopped} stopped` });
  // Three at most, in the order a reader acts on: a fourth truncated every
  // count in 208px instead of leaving one out.
  counts.splice(3);
  const tone: RowTone = errors ? 'error'
    : needYou ? 'waiting'
    : running ? 'running'
    : stopped === agents.length ? 'hollow'
    : 'idle';
  return { tone, counts: counts.length ? counts : [{ label: 'at rest' }] };
}

export type NeedAction = 'open terminal' | 'send it' | 'start';

export interface NeedRow {
  id: string;
  agentId: string;
  tone: RowTone;
  text: string;
  /** When it began: a refused delivery's time, or when a waiting agent began
   *  to wait (#172's statusSince). Worded like the room list's times, so one
   *  older than today says its day. */
  since?: string;
  action: NeedAction;
  actionLabel: string;
}

/**
 * What in this room needs you, one row per thing only you can do, most urgent
 * first: a turn that failed, an agent waiting on you, messages held behind a
 * draft in its field, messages to a stopped agent, then messages a live agent
 * holds unsent. Frame: the needs-you strip
 * of `Chat · A · Room · *` and the sheet `Chat · A · Thread rows · states` >
 * `NEEDS YOU`.
 */
export function needsRows(
  agents: RoomAgent[],
  deliveries: Array<Pick<BusDelivery, 'targetAgentId' | 'state' | 'reasonCode' | 'queuedAt' | 'refusedAt' | 'heldAt'>>,
): NeedRow[] {
  const rows: Array<NeedRow & { rank: number }> = [];
  for (const agent of agents) {
    const name = agent.name || agent.id.slice(0, 8);
    const notSent = deliveries.filter(d => d.targetAgentId === agent.id && d.state === 'not_sent');
    const oldest = notSent.map(d => d.refusedAt ?? d.queuedAt).sort()[0];
    if (agent.status === 'error') {
      const reason = errorReason(agent)?.replace(/[.\s]+$/, '');
      rows.push({
        rank: 0,
        id: `${agent.id}:error`,
        agentId: agent.id,
        tone: 'error',
        text: `${name}’s turn failed${reason ? `: ${reason}` : ''}.${agent.stopped ? '' : ' Its session is still open.'}`,
        action: 'open terminal',
        actionLabel: 'open terminal',
      });
      continue;
    }
    if (!agent.stopped && agent.status === 'waiting') {
      const on = agent.waitingOn;
      rows.push({
        rank: 1,
        id: `${agent.id}:waiting`,
        agentId: agent.id,
        tone: 'waiting',
        // The dialog itself, from #172's waitingOn, in the frame's words:
        // `qa is waiting on a permission dialog: allow npx playwright test?`.
        text: !on ? `${name} is waiting on you.`
          : on.kind === 'permission' ? `${name} is waiting on a permission dialog: allow ${on.text}?`
            : `${name} is waiting on a question: ${on.text}`,
        since: timeLabel(agent.statusSince) || undefined,
        action: 'open terminal',
        actionLabel: 'open terminal',
      });
    }
    // Starting: what was refused while it was stopped waits for its session,
    // and is offered once the session is up.
    if (agent.launching) continue;
    // Its terminal took them and types them once the field is free: only the
    // person at that terminal can send or clear what is in it.
    const held = deliveries.filter(d => d.targetAgentId === agent.id && d.state === 'held');
    if (held.length) {
      const h = held.length;
      rows.push({
        rank: 2,
        id: `${agent.id}:held`,
        agentId: agent.id,
        tone: 'waiting',
        text: `Something is typed in ${name}’s field, so ${h === 1 ? 'one message is' : `${h} messages are`} held until it is sent or cleared.`,
        since: timeLabel(held.map(d => d.heldAt ?? d.queuedAt).sort()[0]) || undefined,
        action: 'open terminal',
        actionLabel: 'open terminal',
      });
    }
    if (notSent.length === 0) continue;
    const n = notSent.length;
    if (shownStopped(agent)) {
      rows.push({
        rank: 3,
        id: `${agent.id}:stopped`,
        agentId: agent.id,
        tone: 'hollow',
        text: `${name} is stopped, so ${n === 1 ? 'one message for it is' : `${n} messages for it are`} not sent.`,
        since: timeLabel(oldest) || undefined,
        action: 'start',
        // The slot is 96 wide: a long name would push the button out of it.
        actionLabel: name.length <= 8 ? `start ${name}` : 'start',
      });
      continue;
    }
    // Live, and still holding what it was refused: `not_sent` moves only when
    // you send it, so an agent started again keeps what came while it was
    // stopped. The words follow the bus's reason, not the agent's CLI.
    const noSession = notSent.every(d => d.reasonCode === 'no_live_session');
    rows.push({
      rank: 4,
      id: `${agent.id}:not-sent`,
      agentId: agent.id,
      tone: 'none',
      text: noSession
        ? `${name} had no live session when ${n === 1 ? 'one message was' : `${n} messages were`} written to it, so ${n === 1 ? 'it waits for you to send it' : 'they wait for you to send them'}.`
        : `${name} cannot tell Tars when its turn ends, so ${n === 1 ? 'one message waits for you to send it' : `${n} messages wait for you to send them`}.`,
      since: timeLabel(oldest) || undefined,
      action: 'send it',
      actionLabel: 'send it',
    });
  }
  rows.sort((a, b) => a.rank - b.rank);
  return rows.map(row => {
    const { rank, ...rest } = row;
    void rank;
    return rest;
  });
}
