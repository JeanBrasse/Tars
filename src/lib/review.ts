import type { AgentStatus } from '@/types/electron';

/**
 * What the Review page lists, and how it says a patch is cut, worked out apart
 * from the page. Frames: Review · dark, Review · light, Review · states. Its
 * failures are listed, and pinned, in __tests__/lib/review.test.ts.
 */

export interface Workspace {
  key: string;
  label: string;
  repoPath: string;
  /** The project the tree belongs to. Several branches of one project sit
   *  together in the list, which is unreadable without this. */
  projectPath: string;
  projectName: string;
  /** Empty for a project added in Tars that no agent works in. */
  agents: string[];
}

/** The lines a patch view draws; past them it says where it stops. */
export const PATCH_LINES = 4000;

const lastPart = (p: string) => p.split('/').filter(Boolean).pop() || p;

/**
 * One entry per working tree: agents sharing a worktree share their changes.
 * Then the projects added in Tars (the Projects page's list) that no agent
 * works in, under their own name. The other folders Claude Code ran in are
 * not projects of yours, and stay out.
 */
export function workspacesFrom(
  agents: AgentStatus[],
  projects: Array<{ path: string; name?: string; custom?: boolean }>,
): Workspace[] {
  const byPath = new Map<string, Workspace>();
  for (const agent of agents) {
    const repoPath = agent.worktreePath || agent.projectPath;
    if (!repoPath) continue;
    const existing = byPath.get(repoPath);
    if (existing) {
      existing.agents.push(agent.name || agent.id);
      continue;
    }
    const projectPath = agent.projectPath || repoPath;
    byPath.set(repoPath, {
      key: repoPath,
      label: agent.branchName || lastPart(repoPath),
      repoPath,
      projectPath,
      projectName: lastPart(projectPath),
      agents: [agent.name || agent.id],
    });
  }
  const worked = new Set(agents.map(a => a.projectPath).filter(Boolean));
  for (const project of projects) {
    if (!project.custom || worked.has(project.path) || byPath.has(project.path)) continue;
    const name = lastPart(project.path);
    byPath.set(project.path, { key: project.path, label: name, repoPath: project.path, projectPath: project.path, projectName: name, agents: [] });
  }
  return Array.from(byPath.values()).sort(
    (a, b) => a.projectName.localeCompare(b.projectName) || a.label.localeCompare(b.label),
  );
}

/** The lines of a patch, the newline that ends the last one not counted as one more. */
export function patchLines(patch: string): string[] {
  const lines = patch.split('\n');
  return patch.endsWith('\n') ? lines.slice(0, -1) : lines;
}

/**
 * Under a picked file's patch cut at PATCH_LINES: where it stops. The page
 * reads a tree's files without their patches (#247), so a patch shown is
 * always a picked file's, and the note no longer says to pick one.
 */
export function cutNote(total: number): string | null {
  if (total <= PATCH_LINES) return null;
  return `${PATCH_LINES} of ${total} lines shown.`;
}
