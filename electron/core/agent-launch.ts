import type { AgentPermissionMode, AgentProvider } from '../types';
import { ptyProcesses } from './pty-manager';
import { cliRunningIn } from './agent-pty';
import { getProvider } from '../providers';

/**
 * The launch of an agent's CLI in its terminal, reachable without a renderer.
 *
 * Every start from a window (the Dashboard, autostart, the Agents and Projects
 * pages, templates, team deployment) goes through the `agent:start` handler.
 * Two starts come from the main process itself and used to build their own
 * command instead: the Kanban automation, which typed a bare
 * `claude --dangerously-skip-permissions` with no model, no effort and no MCP
 * configuration, so its agents ran on whatever the CLI defaulted to; and the
 * restart that applies a changed model or effort, which did not exist. The
 * handler registers its launch here and both call it, so there is one way an
 * agent's CLI is typed into its terminal, not three.
 */
export interface AgentLaunchOptions {
  /** A model chosen for this launch alone, over the agent's own. */
  model?: string;
  provider?: AgentProvider;
  localModel?: string;
  /** Over the agent's own: the Kanban automation runs its tasks unattended. */
  permissionMode?: AgentPermissionMode;
  /**
   * Which conversation to pick up. Absent: the usual rule, the last session
   * once per app run (utils/resume-session.ts). A session id: that session,
   * continued under a new id, which is what a restart does. Null: none.
   */
  resumeSessionId?: string | null;
}

export type AgentLaunchResult =
  | { success: true }
  | { success: false; cliRunning?: boolean; error: string };

export type AgentLauncher = (
  agentId: string,
  prompt: string,
  options?: AgentLaunchOptions,
) => Promise<AgentLaunchResult>;

let launcher: AgentLauncher | null = null;

/** Called once, by the handler that owns the launch. */
export function registerAgentLauncher(fn: AgentLauncher): void {
  launcher = fn;
}

/** Launch an agent's CLI the way `agent:start` does. */
export function launchAgent(agentId: string, prompt: string, options?: AgentLaunchOptions): Promise<AgentLaunchResult> {
  if (!launcher) return Promise.reject(new Error('No agent launcher registered: the IPC handlers are not set up yet'));
  return launcher(agentId, prompt, options);
}

/**
 * How long a launch counts as starting: from the moment one begins until its
 * CLI takes the terminal. A warm start takes about 1.4 s (measured before
 * SessionStart); past this, whatever was typed is not coming up.
 */
export const CLI_BOOT_MS = 15_000;

/**
 * Launches under way, by agent: when each began, and whether it carries a
 * task for the CLI to start on. One per agent, the latest.
 */
const launchesUnderWay = new Map<string, { since: number; withTask: boolean }>();

/**
 * A launch into an agent's terminal has begun: a start from a window, a
 * restart, a bot's cold start. Until its CLI runs there, the terminal is a
 * shell that is about to hand over, and anything that would start a session
 * over it must wait instead (see sessionStarting). Returns the launch, for
 * launchAbandoned.
 */
export function launchBegins(agentId: string, opts: { withTask?: boolean } = {}): object {
  const launch = { since: Date.now(), withTask: !!opts.withTask };
  launchesUnderWay.set(agentId, launch);
  return launch;
}

/** That launch failed or was refused: nothing is coming up. */
export function launchAbandoned(agentId: string, launch: object): void {
  if (launchesUnderWay.get(agentId) === launch) launchesUnderWay.delete(agentId);
}

/**
 * Whether an agent's session is on its way: a launch began less than
 * CLI_BOOT_MS ago and no CLI runs in its terminal yet.
 *
 * Measured by the Audit on 2026-09-23 (re-gate of #120 and #126): from a
 * restart's kill to the new CLI's exec there is about 0.6 s in which the
 * terminal is a bare shell, or none at all, and cliRunningIn rightly says no
 * CLI. A /dispatch landing there started a session over the launch, without
 * --resume (spent once per run), and the conversation was lost; landing just
 * after the launch was typed, the CLI it killed had already started, and its
 * late SessionStart took the agent from the live session, which then ended in
 * error while its CLI answered.
 */
export function sessionStarting(agent: StartingAgent): boolean {
  const launch = launchesUnderWay.get(agent.id);
  if (!launch) return false;
  if (Date.now() - launch.since >= CLI_BOOT_MS || sessionUp(agent, launch)) {
    launchesUnderWay.delete(agent.id);
    return false;
  }
  return true;
}

type StartingAgent = {
  id: string; ptyId?: string; provider?: AgentProvider; sessionRegisteredAt?: string; lastTurnStartedAt?: string;
};

/**
 * Up, for a CLI on the claude binary, once a session has registered since the
 * launch began (its SessionStart), not once the process has exec'd: measured
 * in a sandbox on 2026-09-23, a message typed the moment claude 2.1.280
 * exec'd landed in its field and the Enter after it was lost, the CLI not yet
 * taking keys. The other CLIs send no SessionStart; for them the exec is all
 * there is to go on.
 *
 * A launch that carries a task is up once that task's turn has begun (its
 * UserPromptSubmit), not at its SessionStart: in between, claude submits the
 * prompt it was started with from its own field, and a message typed there in
 * that moment was lost (measured in the app, /start then /dispatch at 0.3 s,
 * once in five after the SessionStart wait). Typed once the turn runs, claude
 * queues it and takes it after the turn.
 */
function sessionUp(agent: StartingAgent, launch: { since: number; withTask: boolean }): boolean {
  const terminal = agent.ptyId ? ptyProcesses.get(agent.ptyId) : undefined;
  if (!terminal || !cliRunningIn(terminal)) return false;
  if (getProvider(agent.provider).binaryName !== 'claude') return true;
  const at = launch.withTask ? agent.lastTurnStartedAt : agent.sessionRegisteredAt;
  return !!at && Date.parse(at) >= launch.since;
}

/**
 * For a sender that launches an agent's CLI unless one already runs in its
 * terminal (the Telegram and Slack bots): the launch is marked the moment it is
 * known to be one, before its terminal is opened and its command typed, so no
 * other sender takes the bare shell in between for an idle terminal. Null when
 * a CLI is up there and the sender will type into it instead: marking that
 * would make every other sender wait on a launch that never happens.
 */
export function launchUnlessRunning(agent: StartingAgent): object | null {
  const terminal = agent.ptyId ? ptyProcesses.get(agent.ptyId) : undefined;
  // A bot's launch always starts the CLI on the message it was sent.
  return terminal && cliRunningIn(terminal) ? null : launchBegins(agent.id, { withTask: true });
}

/** Wait for a session on its way to be up, or for its launch to be given up on. */
export async function sessionStarted(agent: StartingAgent): Promise<void> {
  while (sessionStarting(agent)) await new Promise(resolve => setTimeout(resolve, 100));
}

/** Test seam. */
export function resetLaunches(): void {
  launchesUnderWay.clear();
}
