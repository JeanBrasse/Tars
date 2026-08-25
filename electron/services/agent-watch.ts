import { AgentStatus } from '../types';
import { agents } from '../core/agent-manager';
import { ptyProcesses, writeProgrammaticInput } from '../core/pty-manager';
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

/** How many distinct children can be held for one orchestrator. Reached only
 *  by an orchestrator that dispatched a crowd and then stayed busy. */
const MAX_PENDING_CHILDREN = 20;

/** Last status each agent was seen in, so a transition can be told from a
 *  repeat: the fleet emitter fires on every post, not only on a change. */
const lastSeen = new Map<string, AgentStatus['status']>();

/**
 * requester id -> (child id -> the status it reached).
 *
 * A map rather than a list, so a child that flaps between running and waiting
 * while its orchestrator is busy collapses to its latest state instead of
 * queueing one interruption per flap.
 */
const pending = new Map<string, Map<string, AgentStatus['status']>>();

let listening = false;

export function startAgentWatch(): void {
  if (listening) return;
  listening = true;
  agentStatusEmitter.on('fleet-change', onFleetChange);
}

export function stopAgentWatch(): void {
  agentStatusEmitter.off('fleet-change', onFleetChange);
  listening = false;
  lastSeen.clear();
  pending.clear();
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
  const requesterId = child.requestedBy;
  // Self-dispatch would be a message an agent sends itself on every task.
  if (!requesterId || requesterId === child.id) return;
  if (!agents.has(requesterId)) return;

  const forRequester = pending.get(requesterId) ?? new Map<string, AgentStatus['status']>();
  if (!forRequester.has(child.id) && forRequester.size >= MAX_PENDING_CHILDREN) {
    console.warn(`[agent-watch] ${requesterId} already holds ${MAX_PENDING_CHILDREN} pending results, dropping ${child.id}`);
    return;
  }
  forRequester.set(child.id, child.status);
  pending.set(requesterId, forRequester);

  flush(requesterId);
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
  const forRequester = pending.get(requesterId);
  if (!forRequester || forRequester.size === 0) return;

  const requester = agents.get(requesterId);
  if (!requester) {
    pending.delete(requesterId);
    return;
  }
  if (requester.status === 'running') return;

  const ptyProcess = requester.ptyId ? ptyProcesses.get(requester.ptyId) : undefined;
  if (!ptyProcess) {
    // The session that asked is gone. Its results belong to it and not to
    // whatever session takes its place, so they are dropped rather than
    // delivered to an agent that never dispatched anything.
    console.warn(`[agent-watch] ${requesterId} has no live session, dropping ${forRequester.size} pending result(s)`);
    pending.delete(requesterId);
    return;
  }

  pending.delete(requesterId);
  writeProgrammaticInput(ptyProcess, composeNote(forRequester), true);
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
}
