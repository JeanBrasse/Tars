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
  /** Optional so a page that has no template manager simply omits the button. */
  onManageTemplatesClick?: () => void;
}

/**
 * Two actions only, both opening the same `NewChatModal` on its "One agent |
 * A team" switch - `+ Agent` on the agent half, `+ Team` on the team half.
 * The orchestrator (Super Agent) is a choice inside the agent half, not a
 * competing top-level button.
 *
 * Deploying a team is the heavier, more deliberate act, so it takes the accent
 * fill; a single agent is the everyday one and sits beside it as a plain
 * bordered button. Both are label-only - the labels already say `+ Team` and
 * `+ Agent`, so an icon would only repeat them.
 */
export function AgentListHeader({ onNewAgentClick, onDeployTeamClick, onManageTemplatesClick }: AgentListHeaderProps) {
  return (
    <PageHeader
      title="Agents"
      subtitle="Every agent you have deployed, and what it is doing."
      actions={
        <>
          {/* Templates lost their only entry point when the four-step wizard
              went away: they were reachable from a chip row inside its first
              step. The manager still exists and still works, so it gets a door
              of its own rather than becoming code nobody can run. */}
          {onManageTemplatesClick && (
            <Button
              onClick={onManageTemplatesClick}
              title="Saved agent templates: create, edit and deploy one"
            >
              Templates
            </Button>
          )}
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
            title="Create an agent - a folder, a CLI, and what you want done"
          >
            + Agent
          </Button>
        </>
      }
    />
  );
}
