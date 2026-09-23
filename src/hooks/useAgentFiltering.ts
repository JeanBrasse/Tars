import { useMemo } from 'react';
import type { AgentStatus } from '@/types/electron';
import { isSuperAgentCheck, getStatusPriority, statusTone } from '@/app/agents/constants';
import { applyOrder } from '@/components/TerminalsView/hooks/useProjectTabOrder';

interface UseAgentFilteringProps {
  agents: AgentStatus[];
  projectFilter: string | null;
  statusFilter?: string | null;
  searchQuery?: string;
  sortBy?: 'created' | 'status' | 'activity' | 'name';
}

interface UniqueProject {
  path: string;
  name: string;
}

/** One project's section of the Agents page. */
export interface ProjectGroup {
  path: string;
  agents: AgentStatus[];
}

/** The folder name, which is what the Dashboard tabs and the Projects page call a project. */
export const projectName = (path: string): string => path.split('/').pop() || path;

export const tildePath = (path: string): string => path.replace(/^\/(?:Users|home)\/[^/]+\//, '~/');

/**
 * What each project is called in the picker and over its section: the folder
 * name, unless two projects share one. Those two get their paths instead, so
 * ~/work/tars and ~/Documents/tars are never two rows reading "tars".
 */
export function projectLabels(paths: string[]): Map<string, string> {
  const seen = new Map<string, number>();
  for (const path of paths) seen.set(projectName(path), (seen.get(projectName(path)) ?? 0) + 1);
  return new Map(paths.map(path => [
    path,
    (seen.get(projectName(path)) ?? 0) > 1 ? tildePath(path) : projectName(path),
  ]));
}

/**
 * The page's sections: one per project, in the order the Dashboard's tabs are
 * arranged, each holding its agents in the order they were sorted. A project
 * with nothing left after the filters has no section, and a project missing
 * from `order` still gets one, at the end.
 */
export function groupByProject(agents: AgentStatus[], order: string[]): ProjectGroup[] {
  const byPath = new Map<string, AgentStatus[]>();
  for (const agent of agents) {
    const group = byPath.get(agent.projectPath);
    if (group) group.push(agent);
    else byPath.set(agent.projectPath, [agent]);
  }
  return applyOrder([...byPath.keys()], order).map(path => ({ path, agents: byPath.get(path)! }));
}

export function useAgentFiltering({ agents, projectFilter, statusFilter, searchQuery, sortBy = 'created' }: UseAgentFilteringProps) {
  // In the order the agents arrived, which is the order an unarranged
  // Dashboard strip shows them in too.
  const uniqueProjects = useMemo<UniqueProject[]>(
    () => [...new Set(agents.map(a => a.projectPath))].map(path => ({ path, name: projectName(path) })),
    [agents],
  );

  const filteredAgents = useMemo(() => {
    let filtered = projectFilter ? agents.filter(a => a.projectPath === projectFilter) : agents;

    // By the word the card prints: a `completed` agent reads idle there, so
    // it is found under Idle rather than under a filter the page does not offer.
    if (statusFilter) {
      filtered = filtered.filter(a => statusTone(a.status) === statusFilter);
    }

    if (searchQuery) {
      const q = searchQuery.toLowerCase();
      filtered = filtered.filter(a => {
        const name = (a.name || '').toLowerCase();
        const project = (a.projectPath.split('/').pop() || '').toLowerCase();
        const task = (a.currentTask || '').toLowerCase();
        const branch = (a.branchName || '').toLowerCase();
        return name.includes(q) || project.includes(q) || task.includes(q) || branch.includes(q);
      });
    }

    return [...filtered].sort((a, b) => {
      const aIsSuper = isSuperAgentCheck(a);
      const bIsSuper = isSuperAgentCheck(b);
      if (aIsSuper && !bIsSuper) return -1;
      if (!aIsSuper && bIsSuper) return 1;

      if (sortBy === 'name') {
        return (a.name || '').localeCompare(b.name || '');
      }
      if (sortBy === 'activity') {
        return new Date(b.lastActivity).getTime() - new Date(a.lastActivity).getTime();
      }
      if (sortBy === 'status') {
        const aPriority = getStatusPriority(a.status);
        const bPriority = getStatusPriority(b.status);
        return aPriority - bPriority;
      }
      // Default: created (newest first); fall back to lastActivity for legacy agents missing createdAt
      const aCreated = new Date(a.createdAt || a.lastActivity).getTime();
      const bCreated = new Date(b.createdAt || b.lastActivity).getTime();
      return bCreated - aCreated;
    });
  }, [agents, projectFilter, statusFilter, searchQuery, sortBy]);

  return {
    filteredAgents,
    uniqueProjects,
  };
}
