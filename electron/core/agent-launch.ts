import type { AgentPermissionMode, AgentProvider } from '../types';

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
