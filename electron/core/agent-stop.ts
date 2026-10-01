import type { AgentStatus } from '../types';
import { stopAcpRuns } from '../services/acp/delegate';
import { emitAgentStatus } from '../services/agent-events';
import { oneLine } from '../utils/waiting-on';
import { ptyProcesses, endTerminalTree } from './pty-manager';

/**
 * Stopping an agent: it is ended, and it says who stopped it, when and why
 * (PLAN-1.9.2.md item A, Noah 28/09).
 *
 * A stop sent the terminal's shell its hangup and marked the agent `idle`.
 * Measured: on 28/09 two frozen CLIs survived stop_agent, reparented to
 * launchd; on 30/09 a stopped QA's bench (gate.sh, then npm exec tsc) survived
 * orphaned and ignored SIGTERM. And `idle` is what an agent never started
 * reads, so the Dashboard resumed a stopped one at the next launch and the
 * kanban handed it work.
 *
 * Now the agent is `stopped`, with `stoppedBy` (an agent's name, "Tars" for its
 * own pass, "you" for the window), `stoppedAt` and `stopReason`, until a new
 * terminal is started for it (clearStop). The state is recorded, saved and
 * announced first, then the terminal's whole tree is ended as the quit ends it
 * (endTerminalTree): its exit, which comes after, finds its pty no longer the
 * agent's and changes nothing.
 */

export interface StopRequest {
  /** "you", "Tars", or the name of the agent that asked. */
  by: string;
  reason?: string;
}

/** A reason as the record keeps it: one line of a card, or nothing when empty. */
export function stopReasonOf(raw: unknown): string | undefined {
  if (typeof raw !== 'string') return undefined;
  const line = oneLine(raw);
  return line || undefined;
}

export async function stopAgent(
  agent: AgentStatus,
  request: StopRequest,
  notify: { save(): void; announce(agent: AgentStatus): void },
): Promise<void> {
  // Its delegated run too, which has no terminal (the Audit's table, #6).
  await stopAcpRuns(agent.id, 'the agent was stopped');

  const terminal = agent.ptyId ? ptyProcesses.get(agent.ptyId) : undefined;
  if (agent.ptyId) ptyProcesses.delete(agent.ptyId);
  agent.ptyId = undefined;
  agent.status = 'stopped';
  agent.stoppedBy = request.by;
  agent.stoppedAt = new Date().toISOString();
  agent.stopReason = stopReasonOf(request.reason);
  agent.currentTask = undefined;
  agent.waitingReason = undefined;
  // The killed session is a tombstone: its hooks outlive the kill, and a
  // SessionEnd posting `completed` under it would bring the agent back.
  if (agent.currentSessionId) agent.lastKilledSessionId = agent.currentSessionId;
  agent.currentSessionId = undefined;
  agent.lastActivity = agent.stoppedAt;

  notify.save();
  emitAgentStatus(agent.id);
  notify.announce(agent);

  if (terminal) await endTerminalTree(terminal);
}

/**
 * A new terminal for a stopped agent: the stop is over. Called where an agent
 * gets a terminal (initAgentPty, spawnAgentSession), which is the only way out
 * of `stopped`; the caller sets the status the terminal starts in.
 */
export function clearStop(agent: AgentStatus): void {
  if (agent.status === 'stopped') agent.status = 'idle';
  agent.stoppedBy = undefined;
  agent.stoppedAt = undefined;
  agent.stopReason = undefined;
}
