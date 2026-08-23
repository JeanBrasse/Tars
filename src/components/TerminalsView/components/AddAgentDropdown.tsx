'use client';

import { useState, useRef, useEffect, useMemo } from 'react';
import { ChevronDown } from 'lucide-react';
import type { AgentStatus } from '@/types/electron';
import { Button } from '@/components/ui';
import { STATUS_COLORS, LAYOUT_PRESETS } from '../constants';

// Largest grid the board can render (3x3); agents beyond it are never shown.
const MAX_BOARD_PANELS = Math.max(...Object.values(LAYOUT_PRESETS).map(p => p.maxPanels));

interface AddAgentDropdownProps {
  /** Bulk add - every listed agent of a project in one click. */
  onAddAgents?: (agentIds: string[]) => void;
  allAgents: AgentStatus[];
  currentTabAgentIds: string[];
  onAddAgent: (agentId: string) => void;
  onCreateAgent: () => void;
  /** Menu without its own trigger - the page header owns the `+ Terminal` button.
   *  Pass `open`/`onOpenChange` with it; there is nothing left inside to toggle. */
  asMenuOnly?: boolean;
  /** Controlled open state. Omit both to keep the built-in trigger self-managing. */
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
}

export default function AddAgentDropdown({
  onAddAgents,
  allAgents,
  currentTabAgentIds,
  onAddAgent,
  onCreateAgent,
  asMenuOnly = false,
  open: controlledOpen,
  onOpenChange,
}: AddAgentDropdownProps) {
  const [uncontrolledOpen, setUncontrolledOpen] = useState(false);
  const open = controlledOpen ?? uncontrolledOpen;
  const setOpen = (next: boolean) => {
    if (controlledOpen === undefined) setUncontrolledOpen(next);
    onOpenChange?.(next);
  };

  const [query, setQuery] = useState('');
  const ref = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);

  // Close on click outside. In menu-only mode `ref` wraps the menu alone, so a
  // click on the owner's trigger closes here first and its own onClick reopens -
  // the toggle still reads correctly because mousedown lands before click.
  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    window.addEventListener('mousedown', handler);
    return () => window.removeEventListener('mousedown', handler);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  // Reset the query and focus the search field when the dropdown opens
  useEffect(() => {
    if (open) {
      setQuery('');
      searchRef.current?.focus();
    }
  }, [open]);

  // Agents not on current tab, grouped by project, filtered by search query
  const groups = useMemo(() => {
    const tabSet = new Set(currentTabAgentIds);
    const q = query.trim().toLowerCase();
    const available = allAgents.filter(a => {
      if (tabSet.has(a.id)) return false;
      if (!q) return true;
      const name = (a.name || `Agent ${a.id.slice(0, 6)}`).toLowerCase();
      const project = (a.projectPath.split('/').pop() || a.projectPath).toLowerCase();
      return name.includes(q) || project.includes(q);
    });

    const byProject = new Map<string, AgentStatus[]>();
    for (const agent of available) {
      const key = agent.projectPath;
      if (!byProject.has(key)) byProject.set(key, []);
      byProject.get(key)!.push(agent);
    }

    return Array.from(byProject.entries()).map(([path, agents]) => ({
      projectName: path.split('/').pop() || path,
      projectPath: path,
      agents,
    }));
  }, [allAgents, currentTabAgentIds, query]);

  const totalAvailable = groups.reduce((sum, g) => sum + g.agents.length, 0);

  return (
    <div ref={ref} className="relative">
      {!asMenuOnly && (
        <Button
          variant="primary"
          onClick={() => setOpen(!open)}
          title="Add existing agent to this board"
        >
          Add agent to board
          <ChevronDown className="w-3 h-3" />
        </Button>
      )}

      {open && (
        <div className="absolute top-full right-0 mt-1 bg-card border border-border z-50 min-w-[220px] max-h-[320px] overflow-y-auto">
          {/* Search input - 26px, same field shape as everywhere else */}
          <div className="sticky top-0 z-10 bg-card border-b border-border p-2">
            <input
              ref={searchRef}
              value={query}
              onChange={e => setQuery(e.target.value)}
              placeholder="Search agents…"
              className="w-full h-[26px] px-2 text-xs bg-secondary text-foreground placeholder:text-muted-foreground border border-border focus:border-primary focus:outline-none"
            />
          </div>

          {totalAvailable === 0 ? (
            <div className="px-3 py-4 text-xs text-muted-foreground text-center">
              {query.trim() ? 'No matching agents' : 'All agents are on this board'}
            </div>
          ) : (
            groups.map(group => (
              <div key={group.projectPath}>
                {/* Project caption - click "add all" to pull the whole team in */}
                <div className="flex items-center justify-between gap-2 px-3 py-1.5">
                  <span className="text-[10px] uppercase tracking-wider text-muted-foreground font-medium truncate">
                    {group.projectName}
                  </span>
                  {onAddAgents && group.agents.length > 1 && (() => {
                    const capacity = Math.max(0, MAX_BOARD_PANELS - currentTabAgentIds.length);
                    const addable = Math.min(group.agents.length, capacity);
                    if (addable === 0) {
                      return (
                        <span className="text-[10px] font-mono text-muted-foreground shrink-0" title={`Board is full (${MAX_BOARD_PANELS} max)`}>
                          board full
                        </span>
                      );
                    }
                    return (
                      <button
                        onClick={() => { onAddAgents(group.agents.slice(0, addable).map(a => a.id)); setOpen(false); }}
                        className="text-[10px] font-mono text-primary hover:underline shrink-0"
                        title={addable < group.agents.length
                          ? `Board holds ${MAX_BOARD_PANELS} max - adds the first ${addable} of ${group.agents.length}`
                          : `Add all ${group.agents.length} agents of ${group.projectName}`}
                      >
                        {addable < group.agents.length ? `add first ${addable}` : `add all (${group.agents.length})`}
                      </button>
                    );
                  })()}
                </div>

                {/* Agent rows - 6px status square, then the name. No emoji tile. */}
                {group.agents.map(agent => {
                  const name = agent.name || `Agent ${agent.id.slice(0, 6)}`;
                  const status = STATUS_COLORS[agent.status] || STATUS_COLORS.idle;

                  return (
                    <button
                      key={agent.id}
                      onClick={() => { onAddAgent(agent.id); setOpen(false); }}
                      className="flex items-center gap-2 w-full h-8 px-3 text-xs text-muted-foreground hover:bg-secondary hover:text-foreground transition-colors"
                    >
                      <span className={`w-1.5 h-1.5 shrink-0 ${status.dot}`} />
                      <span className="truncate flex-1 text-left">{name}</span>
                    </button>
                  );
                })}
              </div>
            ))
          )}

        </div>
      )}
    </div>
  );
}
