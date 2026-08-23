'use client';

import { memo, useMemo } from 'react';
import type { ActiveTab } from '../types';

interface ProjectTabBarProps {
  // Distinct project paths, in order - the already-stabilized derivation
  // (agentProjectPaths in TerminalsView/index.tsx) rather than the raw
  // agents array. `agents` gets a new identity on every agents:tick even for
  // an unrelated status/task change, and this bar is mounted above the grid
  // on every tab, so an unmemoized component fed that array re-ran its Set
  // computation and re-rendered twice a second regardless of the grid-level
  // memoization work (see TerminalPanel.tsx's memo comment for that story).
  projectPaths: string[];
  activeTab: ActiveTab;
  onSelectProject: (projectPath: string) => void;
  /** @deprecated the panel toggle no longer lives on the tab strip; kept optional until the call site drops it */
  panelOpen?: boolean;
  /** @deprecated the panel toggle no longer lives on the tab strip; kept optional until the call site drops it */
  onTogglePanel?: () => void;
}

function ProjectTabBar({
  projectPaths,
  activeTab,
  onSelectProject,
}: ProjectTabBarProps) {
  // tabs are label-only now: the strip only needs the distinct project paths, in order
  const projects = useMemo(() => (
    projectPaths.map(path => ({
      path,
      name: path.split('/').pop() || path,
    }))
  ), [projectPaths]);

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

export default memo(ProjectTabBar);
