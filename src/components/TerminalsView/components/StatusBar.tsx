'use client';

import type { AgentStatus } from '@/types/electron';

interface StatusBarProps {
  agents: AgentStatus[];
  /** Current git branch of the active project, rendered on the right. */
  branch?: string;
}

export default function StatusBar({ agents, branch }: StatusBarProps) {
  const running = agents.filter(a => a.status === 'running').length;

  return (
    <div className="flex items-center gap-4 px-3 py-1 bg-secondary border-t border-border !rounded-none font-mono text-[10px] text-muted-foreground">
      {/* Agent counts */}
      <span>{agents.length} agent{agents.length !== 1 ? 's' : ''}</span>
      <span className="text-status-running">{running} running</span>

      {/* Spacer */}
      <div className="flex-1" />

      {/* Current branch */}
      {branch && <span>{branch}</span>}
    </div>
  );
}
