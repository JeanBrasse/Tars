import type { AgentCharacter, AgentProvider, AgentPermissionMode, AgentEffort, AgentRole } from './index';

/** One agent slot in a team. Deploying a team creates one agent per member. */
export interface TeamTemplateMember {
  /** Role name, e.g. "Frontend Dev". The deployed agent is named "<name> - <project>". */
  name: string;
  character: AgentCharacter;
  provider: AgentProvider;
  model?: string;
  localModel?: string;
  permissionMode: AgentPermissionMode;
  effort?: AgentEffort;
  skills: string[];
  savedPrompt?: string;
  /** Git worktree branch the agent works on (omit to work on the main checkout). */
  worktreeBranch?: string;
  /** The Orchestrator toggle of the agent it deploys. See core/agent-role.ts. */
  role?: AgentRole;
  /** The toggle's old name, equal to `role === 'orchestrator'`, for the
   *  renderer that still reads it. */
  orchestratorMode?: boolean;
}

export interface TeamTemplate {
  id: string;
  builtin: boolean;
  name: string;
  description: string;
  icon: string;
  members: TeamTemplateMember[];
  createdAt: string;
  updatedAt: string;
}

export interface TeamTemplateInput {
  name: string;
  description?: string;
  icon?: string;
  members: Partial<TeamTemplateMember>[];
}

export interface TeamTemplateStore {
  user: TeamTemplate[];
}
