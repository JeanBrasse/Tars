'use client';

import { useMemo } from 'react';
import type { AgentStatus } from '@/types/electron';
import type { ActiveTab } from '../types';

interface ProjectTabBarProps {
  agents: AgentStatus[];
  activeTab: ActiveTab;
  onSelectProject: (projectPath: string) => void;
  /** @deprecated the panel toggle no longer lives on the tab strip; kept optional until the call site drops it */
  panelOpen?: boolean;
  /** @deprecated the panel toggle no longer lives on the tab strip; kept optional until the call site drops it */
  onTogglePanel?: () => void;
}

export default function ProjectTabBar({
  agents,
  activeTab,
  onSelectProject,
}: ProjectTabBarProps) {
  // tabs are label-only now: the strip only needs the distinct project paths, in order
  const projects = useMemo(() => {
    const paths = new Set<string>();
    for (const agent of agents) paths.add(agent.projectPath);
    return Array.from(paths).map(path => ({
      path,
      name: path.split('/').pop() || path,
    }));
  }, [agents]);

  const isActive = (path: string) =>
    activeTab.type === 'project' && activeTab.projectPath === path;

  return (
    <div data-sidebar-ignore className="relative flex items-end h-10 [&_button]:cursor-pointer">
      {/* full-width hairline; the active tab's fill breaks it */}
      <div className="absolute inset-x-0 bottom-0 h-px bg-border" />

      <div className="relative flex items-end gap-0.5 h-full flex-1 overflow-x-auto scrollbar-none">
        {projects.map(project => (
          <button
            key={project.path}
            onClick={() => onSelectProject(project.path)}
            className={`
              flex items-center h-full px-3 text-xs whitespace-nowrap transition-colors shrink-0
              ${isActive(project.path)
                ? 'bg-card border border-border border-b-transparent text-foreground'
                : 'text-muted-foreground hover:text-foreground'
              }
            `}
          >
            {project.name}
          </button>
        ))}

        {projects.length === 0 && (
          <span className="flex items-center h-full px-3 text-xs text-muted-foreground">No projects</span>
        )}
      </div>
    </div>
  );
}
