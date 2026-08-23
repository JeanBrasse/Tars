'use client';

import { Button, PageHeader } from '@/components/ui';

interface AgentListHeaderProps {
  /** Unused - the counts live in the filter chips now. Kept optional so the
   *  page can drop them without breaking this call site. */
  totalCount?: number;
  /** Unused - see `totalCount`. */
  runningCount?: number;
  onNewAgentClick: () => void;
  onDeployTeamClick: () => void;
}

/**
 * Two actions only: one agent, or a whole team. Templates and the
 * orchestrator (Super Agent) are choices inside the agent creation flow -
 * not competing top-level buttons.
 *
 * Deploying a team is the heavier, more deliberate act, so it takes the accent
 * fill; a single agent is the everyday one and sits beside it as a plain
 * bordered button. Both are label-only - the labels already say `+ Team` and
 * `+ Agent`, so an icon would only repeat them.
 */
export function AgentListHeader({ onNewAgentClick, onDeployTeamClick }: AgentListHeaderProps) {
  return (
    <PageHeader
      title="Agents"
      subtitle="Every agent you have deployed, and what it is doing."
      actions={
        <>
          <Button
            variant="primary"
            onClick={onDeployTeamClick}
            title="Deploy a whole team of agents onto a project"
          >
            + Team
          </Button>
          <Button
            variant="secondary"
            onClick={onNewAgentClick}
            title="Create an agent - from scratch, from a template, or as an orchestrator"
          >
            + Agent
          </Button>
        </>
      }
    />
  );
}
