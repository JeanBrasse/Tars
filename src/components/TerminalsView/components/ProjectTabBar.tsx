'use client';

import { memo, useMemo, useState } from 'react';
import { ChevronDown } from 'lucide-react';
import { DndContext, PointerSensor, useSensor, useSensors, type DragEndEvent } from '@dnd-kit/core';
import { SortableContext, horizontalListSortingStrategy, useSortable } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
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
  /** Called when a tab is dropped on another. Both are project paths. */
  onReorder?: (from: string, to: string) => void;
  /** Panels taken off this board, and the way back. Empty means no control. */
  hidden?: { id: string; name: string }[];
  onShow?: (agentId: string) => void;
  onShowAll?: () => void;
  /** @deprecated the panel toggle no longer lives on the tab strip; kept optional until the call site drops it */
  panelOpen?: boolean;
  /** @deprecated the panel toggle no longer lives on the tab strip; kept optional until the call site drops it */
  onTogglePanel?: () => void;
}

/**
 * One tab. Sortable, so the strip can be arranged: the order used to be
 * whatever order the agents happened to be in, which changed under the user
 * every time an agent was created.
 *
 * The drag needs 5px of travel before it starts, or every click on a tab would
 * be swallowed as a drag and the strip would stop selecting projects.
 */
function ProjectTab({ path, name, active, onSelect }: {
  path: string;
  name: string;
  active: boolean;
  onSelect: () => void;
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: path });

  return (
    <button
      ref={setNodeRef}
      style={{ transform: CSS.Translate.toString(transform), transition, opacity: isDragging ? 0.5 : 1 }}
      onClick={onSelect}
      {...attributes}
      {...listeners}
      className={`
        flex items-center h-full px-3 text-xs whitespace-nowrap transition-colors shrink-0
        ${active
          ? 'bg-card border border-border border-b-transparent text-foreground'
          : 'text-muted-foreground hover:text-foreground'
        }
      `}
    >
      {name}
    </button>
  );
}

const POINTER_SENSOR_OPTIONS = { activationConstraint: { distance: 5 } };

function ProjectTabBar({
  projectPaths,
  activeTab,
  onSelectProject,
  onReorder,
  hidden = [],
  onShow,
  onShowAll,
}: ProjectTabBarProps) {
  const [hiddenOpen, setHiddenOpen] = useState(false);
  // tabs are label-only now: the strip only needs the distinct project paths, in order
  const projects = useMemo(() => (
    projectPaths.map(path => ({
      path,
      name: path.split('/').pop() || path,
    }))
  ), [projectPaths]);

  const isActive = (path: string) =>
    activeTab.type === 'project' && activeTab.projectPath === path;

  const sensors = useSensors(useSensor(PointerSensor, POINTER_SENSOR_OPTIONS));

  const handleDragEnd = (event: DragEndEvent) => {
    const { active, over } = event;
    if (over && active.id !== over.id) onReorder?.(String(active.id), String(over.id));
  };

  return (
    <div data-sidebar-ignore className="relative flex items-end h-10 [&_button]:cursor-pointer">
      {/* full-width hairline; the active tab's fill breaks it */}
      <div className="absolute inset-x-0 bottom-0 h-px bg-border" />

      <div className="relative flex items-end gap-0.5 h-full flex-1 overflow-x-auto scrollbar-none">
        {/* Its own DndContext: the board's context handles skill drops onto
            panels, and mixing the two would let a tab be dropped on a
            terminal. */}
        <DndContext sensors={sensors} onDragEnd={handleDragEnd}>
          <SortableContext items={projectPaths} strategy={horizontalListSortingStrategy}>
            {projects.map(project => (
              <ProjectTab
                key={project.path}
                path={project.path}
                name={project.name}
                active={isActive(project.path)}
                onSelect={() => onSelectProject(project.path)}
              />
            ))}
          </SortableContext>
        </DndContext>

        {projects.length === 0 && (
          <span className="flex items-center h-full px-3 text-xs text-muted-foreground">No projects</span>
        )}
      </div>

      {/* Hiding a panel has to have a way back, and this is where the space
          already is. Absent entirely when nothing is hidden: a control that
          always reads zero is noise. */}
      {hidden.length > 0 && (
        <div className="relative shrink-0 pb-1">
          <button
            type="button"
            onClick={() => setHiddenOpen(o => !o)}
            className="h-[26px] px-2 flex items-center gap-1.5 font-mono text-[11px] text-muted-foreground hover:text-foreground transition-colors"
          >
            {hidden.length} hidden
            <ChevronDown className={`w-3 h-3 transition-transform ${hiddenOpen ? 'rotate-180' : ''}`} />
          </button>

          {hiddenOpen && (
            <div className="absolute right-0 z-[90] mt-1 min-w-[200px] bg-card border border-border">
              {hidden.map(agent => (
                <button
                  key={agent.id}
                  type="button"
                  onClick={() => { onShow?.(agent.id); setHiddenOpen(false); }}
                  className="w-full text-left px-2.5 py-1.5 text-xs text-text-secondary hover:bg-secondary hover:text-foreground truncate"
                >
                  {agent.name}
                </button>
              ))}
              <button
                type="button"
                onClick={() => { onShowAll?.(); setHiddenOpen(false); }}
                className="w-full text-left px-2.5 py-1.5 border-t border-border font-mono text-[10.5px] text-muted-foreground hover:bg-secondary hover:text-foreground"
              >
                show all
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export default memo(ProjectTabBar);
