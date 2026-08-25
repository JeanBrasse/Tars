import { AgentStatus } from '../types';
import { agents } from '../core/agent-manager';
import { ptyProcesses, writeProgrammaticInput, PROGRAMMATIC_SUBMIT_DELAY_MS } from '../core/pty-manager';
import { agentStatusEmitter } from './agent-events';

/**
 * Telling an orchestrator that the agent it dispatched has finished.
 *
 * Delegation was one-directional: an orchestrator started an agent and then
 * had to keep asking, either through wait_for_agent or a shell loop it armed
 * by hand. The day nobody armed one, a whole QA pass finished and the thread
 * simply stopped: the work was done and no one knew. This closes that without
 * anyone having to ask, which is what "by default" means.
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

/** How many distinct children can be held for one orchestrator. Reached only
 *  by an orchestrator that dispatched a crowd and then stayed busy. */
const MAX_PENDING_CHILDREN = 20;

/** Last status each agent was seen in, so a transition can be told from a
 *  repeat: the fleet emitter fires on every post, not only on a change. */
const lastSeen = new Map<string, AgentStatus['status']>();

/**
 * What is waiting for one orchestrator, and which of its sessions it is for.
 *
 * `children` is a map rather than a list, so a child that flaps between
 * running and waiting while its orchestrator is busy collapses to its latest
 * state instead of queueing one interruption per flap.
 *
 * `ptyId` and `sessionId` are the orchestrator as it was when the results were
 * queued. Only `currentSessionId` is authoritative for an agent, and a killed
 * session leaves its id behind in `lastKilledSessionId` as a tombstone: an
 * orchestrator that is killed and relaunched is a different session that never
 * dispatched anything, and handing it the previous one's results would be
 * exactly the stale post the session rule exists to reject.
 */
type Pending = {
  children: Map<string, AgentStatus['status']>;
  ptyId: string;
  sessionId?: string;
};

const pending = new Map<string, Pending>();

/**
 * Orchestrators whose terminal is mid-write, until the trailing carriage
 * return of writeProgrammaticInput has landed.
 *
 * Two children finishing within a moment of each other while the orchestrator
 * is free produced two writes before either submit keystroke, so the two notes
 * ran together on one line and a stray Enter followed. Grouping only helped
 * when the orchestrator was busy, which is not this case.
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

  const existing = pending.get(link.agentId);
  // Results are per session. If the orchestrator has been replaced since the
  // last ones were queued, those belonged to the session that is gone.
  const held = existing && existing.ptyId === requester.ptyId
    ? existing
    : { children: new Map<string, AgentStatus['status']>(), ptyId: requester.ptyId, sessionId: requester.currentSessionId };

  if (!held.children.has(child.id) && held.children.size >= MAX_PENDING_CHILDREN) {
    console.warn(`[agent-watch] ${link.agentId} already holds ${MAX_PENDING_CHILDREN} pending results, dropping ${child.id}`);
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
 * Hand over what is waiting, if this is a moment when it can be handed over.
 *
 * Writing into the PTY of an agent that is mid-task is the thing the
 * orchestrator's own rules forbid, and for good reason: it lands in the input
 * box of a TUI that is busy and derails the turn. So a running requester is
 * left alone and its results stay queued. Nothing schedules a retry, because
 * nothing needs to: the requester's own next transition calls back in here,
 * and that transition is precisely the moment it stopped being busy.
 */
function flush(requesterId: string): void {
  const held = pending.get(requesterId);
  if (!held || held.children.size === 0) return;

  const requester = agents.get(requesterId);
  if (!requester) {
    pending.delete(requesterId);
    return;
  }
  if (requester.status === 'running') return;

  // A write already in flight has not sent its carriage return yet. Adding a
  // second one now would land inside the first message and be submitted by
  // it. The results stay queued and go out as one note when the window closes.
  if (delivering.has(requesterId)) return;

  // The session rule, which is the whole of it: only currentSessionId is
  // authoritative, and an id sitting in lastKilledSessionId is a tombstone.
  // A killed and relaunched orchestrator has a new pty and a new session, and
  // it never dispatched any of this.
  const sameSession = held.ptyId === requester.ptyId
    && held.sessionId === requester.currentSessionId
    && (held.sessionId === undefined || held.sessionId !== requester.lastKilledSessionId);

  const ptyProcess = requester.ptyId ? ptyProcesses.get(requester.ptyId) : undefined;
  if (!ptyProcess || !sameSession) {
    // The session that asked is gone. Its results belong to it and not to
    // whatever session takes its place, so they are dropped rather than
    // delivered to an agent that never dispatched anything.
    console.warn(`[agent-watch] ${requesterId} is no longer the session that dispatched, dropping ${held.children.size} pending result(s)`);
    pending.delete(requesterId);
    return;
  }

  pending.delete(requesterId);
  writeProgrammaticInput(ptyProcess, composeNote(held.children), true);

  // Held slightly past the submit keystroke, so anything that finishes in the
  // meantime waits for a line of its own instead of joining this one.
  delivering.set(requesterId, setTimeout(() => {
    delivering.delete(requesterId);
    flush(requesterId);
  }, PROGRAMMATIC_SUBMIT_DELAY_MS + 50));
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

/** Test seam: the queues are process memory, and a test that drives several
 *  fleets through one module needs them empty between runs. */
export function resetAgentWatch(): void {
  lastSeen.clear();
  pending.clear();
  for (const timer of delivering.values()) clearTimeout(timer);
  delivering.clear();
}
