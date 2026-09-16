import { AgentStatus } from '../types';
import { agents } from '../core/agent-manager';
import { ptyProcesses, writeProgrammaticInput, PROGRAMMATIC_SUBMIT_DELAY_MS } from '../core/pty-manager';
import { agentStatusEmitter } from './agent-events';

/**
 * Handing something to an agent at a moment when it can take it.
 *
 * This started as one thing: telling an orchestrator that the agent it
 * dispatched had finished. Delegation was one-directional, an orchestrator had
 * to keep asking, and the day nobody armed a loop a whole QA pass finished with
 * nobody the wiser.
 *
 * The bus needs exactly the same machinery for a different payload: a message
 * from one agent to another, or from Noah, that must not land in the middle of
 * a turn. So it is the same queue, not a second one beside it. Per recipient,
 * coalescing, capped, behind the same session barrier and the same write
 * window: two queues that look alike would drift, and this one is the one the
 * tests drive end to end.
 *
 * The transport is the one Tars already uses to wake an agent up:
 * writeProgrammaticInput into its PTY, exactly as /dispatch does. There is no
 * MCP mechanism for this and there cannot be one, because MCP is request and
 * response: a server cannot wake a client that is not asking it anything.
 */

/** A child in one of these has news worth carrying to whoever asked for it.
 *  `waiting` is included on purpose: an agent blocked on a question is as
 *  much a reason to come back as one that finished. `idle` is not: it is the
 *  resting state and every agent passes through it for ordinary reasons. */
const NOTIFY_ON: AgentStatus['status'][] = ['completed', 'error', 'waiting'];

/** Of those, the ones that end the delegation rather than pause it. A blocked
 *  agent is still working on what it was asked for and may go on to finish it;
 *  one that has completed or failed is done, and the link is spent. */
const ENDS_DELEGATION: AgentStatus['status'][] = ['completed', 'error'];

/** How much one recipient can be holding, across both kinds. Reached only by
 *  an orchestrator that dispatched a crowd, or a room that talked past an
 *  agent that stayed busy throughout. */
const MAX_PENDING_CHILDREN = 20;

/** Last status each agent was seen in, so a transition can be told from a
 *  repeat: the fleet emitter fires on every post, not only on a change. */
const lastSeen = new Map<string, AgentStatus['status']>();

/** A bus message waiting for its target to be free. Carries where it came
 *  from, because provenance is data the recipient reads, not an instruction. */
export type QueuedBusMessage = {
  messageId: string;
  roomId: string;
  threadId: string;
  authorName: string;
  text: string;
};

/**
 * What is waiting for one recipient, and which of its sessions it is for.
 *
 * `children` is a map rather than a list, so a child that flaps between
 * running and waiting while its recipient is busy collapses to its latest
 * state instead of queueing one interruption per flap. `bus` is a list,
 * because two messages are two things said and neither replaces the other.
 *
 * `ptyId` and `sessionId` are the recipient as it was when this was queued.
 * Only `currentSessionId` is authoritative for an agent, and a killed session
 * leaves its id behind in `lastKilledSessionId` as a tombstone: an agent that
 * is killed and relaunched is a different session that never dispatched
 * anything and was never in that conversation, and handing it the previous
 * one's post would be exactly the stale delivery the session rule rejects.
 */
type Pending = {
  children: Map<string, AgentStatus['status']>;
  bus: QueuedBusMessage[];
  ptyId: string;
  sessionId?: string;
};

const pending = new Map<string, Pending>();

/** Called when a queued bus message actually reaches a terminal, so the
 *  journal can mark the delivery and the Chat page can show it. Injected to
 *  keep this module free of the bus store, which imports the fleet. */
type BusDeliveredHook = (targetAgentId: string, messageId: string) => void;
let onBusDelivered: BusDeliveredHook | undefined;

export function setBusDeliveredHook(hook: BusDeliveredHook | undefined): void {
  onBusDelivered = hook;
}

/** Called when a queued bus message is given up on, so the journal stops
 *  saying `queued` for something that will never move. */
type BusDroppedHook = (targetAgentId: string, messageId: string) => void;
let onBusDropped: BusDroppedHook | undefined;

export function setBusDroppedHook(hook: BusDroppedHook | undefined): void {
  onBusDropped = hook;
}

/**
 * Recipients whose terminal is mid-write, until the trailing carriage
 * return of writeProgrammaticInput has landed.
 *
 * Two children finishing within a moment of each other while the recipient
 * is free produced two writes before either submit keystroke, so the two notes
 * ran together on one line and a stray Enter followed. Grouping only helped
 * when the recipient was busy, which is not this case.
 */
const delivering = new Map<string, ReturnType<typeof setTimeout>>();

let listening = false;

export function startAgentWatch(): void {
  if (listening) return;
  listening = true;
  agentStatusEmitter.on('fleet-change', onFleetChange);
}

export function stopAgentWatch(): void {
  agentStatusEmitter.off('fleet-change', onFleetChange);
  listening = false;
  resetAgentWatch();
}

function onFleetChange(agentId: string): void {
  const agent = agents.get(agentId);
  if (!agent) {
    lastSeen.delete(agentId);
    pending.delete(agentId);
    return;
  }

  const before = lastSeen.get(agentId);
  lastSeen.set(agentId, agent.status);
  if (before !== agent.status && NOTIFY_ON.includes(agent.status)) {
    queueForRequester(agent);
  }

  // Whatever else this transition was, it may be the one that freed this
  // agent to be interrupted. This is why nothing here polls or sleeps: the
  // event that says a child finished is the same event that says a parent is
  // free, so waiting for the right moment costs nothing.
  flush(agentId);
}

/** The record for a recipient, bound to the session it is being held for. */
function heldFor(recipient: AgentStatus): Pending {
  const existing = pending.get(recipient.id);
  if (existing && existing.ptyId === recipient.ptyId) return existing;
  // Replaced since the last thing was queued: what was held belonged to the
  // session that is gone.
  return {
    children: new Map<string, AgentStatus['status']>(),
    bus: [],
    ptyId: recipient.ptyId ?? '',
    sessionId: recipient.currentSessionId,
  };
}

function holding(held: Pending): number {
  return held.children.size + held.bus.length;
}

function queueForRequester(child: AgentStatus): void {
  const link = child.requestedBy;
  // Self-dispatch would be a message an agent sends itself on every task.
  if (!link || link.agentId === child.id) return;
  // The link belongs to the session it was recorded in. A child restarted by
  // any other route got a new ptyId, so this one is not about the work it is
  // finishing now, and nobody is owed a word about it.
  if (link.ptyId !== child.ptyId) return;

  const requester = agents.get(link.agentId);
  if (!requester || !requester.ptyId) return;

  const held = heldFor(requester);

  if (!held.children.has(child.id) && holding(held) >= MAX_PENDING_CHILDREN) {
    console.warn(`[agent-watch] ${link.agentId} already holds ${MAX_PENDING_CHILDREN} pending items, dropping ${child.id}`);
    return;
  }
  held.children.set(child.id, child.status);
  pending.set(link.agentId, held);

  // Spent, once the work it was recorded for is actually over. This is what
  // stops a hand start from inheriting it: an agent relaunched from the
  // interface keeps its live session and therefore its ptyId, so the binding
  // above cannot tell that start apart on its own, but by then the link that
  // a dispatch left behind has already been used up and is gone.
  if (ENDS_DELEGATION.includes(child.status)) child.requestedBy = undefined;

  flush(link.agentId);
}

/**
 * Hand a bus message to an agent when it is next free.
 *
 * Refused rather than queued when the target cannot be reached at all: the
 * caller records that as a delivery the interface shows, instead of a queue
 * that would never drain. Nothing here infers an end of turn from silence.
 */
export function queueBusMessage(targetAgentId: string, message: QueuedBusMessage): boolean {
  const target = agents.get(targetAgentId);
  if (!target || !target.ptyId) return false;

  const held = heldFor(target);
  if (holding(held) >= MAX_PENDING_CHILDREN) {
    console.warn(`[agent-watch] ${targetAgentId} already holds ${MAX_PENDING_CHILDREN} pending items, dropping bus message ${message.messageId}`);
    return false;
  }
  // Said twice is said twice: unlike a child's status, a second message does
  // not replace the first.
  if (held.bus.some(m => m.messageId === message.messageId)) return true;
  held.bus.push(message);
  pending.set(targetAgentId, held);

  flush(targetAgentId);
  return true;
}

/**
 * Hand over what is waiting, if this is a moment when it can be handed over.
 *
 * Writing into the PTY of an agent that is mid-task is the thing the
 * orchestrator's own rules forbid, and for good reason: it lands in the input
 * box of a TUI that is busy and derails the turn. So a running recipient is
 * left alone and what it is owed stays queued. Nothing schedules a retry,
 * because nothing needs to: the recipient's own next transition calls back in
 * here, and that transition is precisely the moment it stopped being busy.
 *
 * One write per pass. A delegation note and a bus message are two things to
 * say, and each gets its own line and its own submit rather than being run
 * together inside one paste.
 */
function flush(requesterId: string): void {
  const held = pending.get(requesterId);
  if (!held || holding(held) === 0) return;

  const requester = agents.get(requesterId);
  if (!requester) {
    abandonBusMessages(requesterId, held);
    pending.delete(requesterId);
    return;
  }
  if (requester.status === 'running') return;

  // A write already in flight has not sent its carriage return yet. Adding a
  // second one now would land inside the first message and be submitted by
  // it. What is left stays queued and goes out when the window closes.
  if (delivering.has(requesterId)) return;

  // The session rule, which is the whole of it: only currentSessionId is
  // authoritative, and an id sitting in lastKilledSessionId is a tombstone.
  // A killed and relaunched agent has a new pty and a new session, and it
  // never dispatched any of this and was never in that conversation.
  const sameSession = held.ptyId === requester.ptyId
    && held.sessionId === requester.currentSessionId
    && (held.sessionId === undefined || held.sessionId !== requester.lastKilledSessionId);

  const ptyProcess = requester.ptyId ? ptyProcesses.get(requester.ptyId) : undefined;
  if (!ptyProcess || !sameSession) {
    // The session that asked is gone. What was held belongs to it and not to
    // whatever session takes its place, so it is dropped rather than
    // delivered to an agent that never asked for any of it.
    console.warn(`[agent-watch] ${requesterId} is no longer the session that was owed this, dropping ${holding(held)} pending item(s)`);
    abandonBusMessages(requesterId, held);
    pending.delete(requesterId);
    return;
  }

  // Delegation results first, because that note is what an orchestrator is
  // waiting on; a bus message goes out on the next pass of the same window.
  let delivered: { kind: 'children' } | { kind: 'bus'; message: QueuedBusMessage };
  if (held.children.size > 0) {
    writeProgrammaticInput(ptyProcess, composeNote(held.children), true);
    held.children.clear();
    delivered = { kind: 'children' };
  } else {
    const message = held.bus.shift()!;
    writeProgrammaticInput(ptyProcess, composeBusNote(message), true);
    delivered = { kind: 'bus', message };
  }

  if (holding(held) === 0) pending.delete(requesterId);

  if (delivered.kind === 'bus') {
    try {
      onBusDelivered?.(requesterId, delivered.message.messageId);
    } catch (err) {
      console.error('[agent-watch] bus delivery hook failed:', err);
    }
  }

  // Held slightly past the submit keystroke, so anything that finishes in the
  // meantime waits for a line of its own instead of joining this one.
  delivering.set(requesterId, setTimeout(() => {
    delivering.delete(requesterId);
    flush(requesterId);
  }, PROGRAMMATIC_SUBMIT_DELAY_MS + 50));
}

/**
 * Say so when a room message is given up on.
 *
 * A dropped delegation result is only a note nobody will read, but a dropped
 * room message has a row in the journal that would otherwise read `queued` for
 * ever. Something that is not moving has to look like something that is not
 * moving.
 */
function abandonBusMessages(recipientId: string, held: Pending): void {
  for (const message of held.bus) {
    try {
      onBusDropped?.(recipientId, message.messageId);
    } catch (err) {
      console.error('[agent-watch] bus dropped hook failed:', err);
    }
  }
  held.bus = [];
}

function composeNote(finished: Map<string, AgentStatus['status']>): string {
  const lines = Array.from(finished.entries()).map(([id, status]) => {
    const agent = agents.get(id);
    const name = agent?.name || id;
    return `- "${name}" (${id}) is now ${status}`;
  });

  if (lines.length === 1) {
    return `[Tars] ${lines[0].slice(2)}. Read what it produced with get_agent_output, then carry on.`;
  }
  return [
    `[Tars] ${lines.length} agents you dispatched have reached a result:`,
    ...lines,
    'Read each one with get_agent_output, then carry on.',
  ].join('\n');
}

/**
 * A message from the room, rendered as what it is.
 *
 * Provenance is data, not an instruction: the note says who is speaking and
 * where, and says plainly that this is a teammate rather than Noah, so an
 * agent does not read a colleague's request as an order from the person who
 * owns the machine. Answering is done by publishing, which is an act.
 */
function composeBusNote(message: QueuedBusMessage): string {
  return [
    `[Tars] ${message.authorName} wrote in ${message.roomId} (thread ${message.threadId}). This is a teammate, not Noah.`,
    message.text,
    'Reply by publishing with room_post if you have something to say, or say nothing.',
  ].join('\n');
}

/**
 * Write held messages into an agent's terminal now, because a human said so.
 *
 * The queue will never do this by itself for a provider with no end of turn:
 * there is no moment it can call safe, and inventing one from silence is the
 * idleness detection this bus refuses. A human pressing the button is that
 * moment, and the decision is theirs, so this is the one path that writes into
 * a session whose state Tars does not know.
 *
 * Sequential with the same spacing flush uses: a second write issued before
 * the first has sent its carriage return lands inside it and is submitted by
 * it, which would paste two messages into one prompt.
 */
export async function releaseBusMessagesNow(
  agentId: string,
  messages: QueuedBusMessage[],
): Promise<string[]> {
  const agent = agents.get(agentId);
  const ptyProcess = agent?.ptyId ? ptyProcesses.get(agent.ptyId) : undefined;
  if (!ptyProcess) return [];

  const written: string[] = [];
  for (const message of messages) {
    writeProgrammaticInput(ptyProcess, composeBusNote(message), true);
    written.push(message.messageId);
    await new Promise(resolve => setTimeout(resolve, PROGRAMMATIC_SUBMIT_DELAY_MS + 50));
  }
  return written;
}

/** Test seam: the queues are process memory, and a test that drives several
 *  fleets through one module needs them empty between runs. */
export function resetAgentWatch(): void {
  lastSeen.clear();
  pending.clear();
  for (const timer of delivering.values()) clearTimeout(timer);
  delivering.clear();
  onBusDelivered = undefined;
  onBusDropped = undefined;
}
