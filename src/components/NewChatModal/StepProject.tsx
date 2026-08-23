import React, { useMemo } from 'react';
import { Chip, Input, PanelCaption, Select } from '@/components/ui';
import { Toggle } from '@/components/Settings/Toggle';
import type { Project } from './types';

/** How many one-click project chips the RECENT row offers. */
const RECENT_COUNT = 3;

/**
 * Sentinel value for the "Choose a folder…" row of the project dropdown.
 *
 * FAILURE THIS FIXES: the design pass that rewrote this file (d845125) deleted
 * the custom-path Input and its Browse button along with the rest of the old
 * layout, but left `onBrowseFolder` in the props interface. Both the create and
 * the edit modal still thread that callback down from agents/page.tsx, and this
 * component silently dropped it - it was never even destructured. The result:
 * the only projects an agent could ever be pointed at were the ones
 * `fs:list-projects` returns (custom projects plus decodable ~/.claude/projects
 * entries that still exist on disk - 9 of 22 dirs on the author's machine), with
 * no way to reach any other directory. The IPC was never the problem:
 * `dialog:open-folder` exists in ipc-handlers, is bridged in preload as
 * `dialog.openFolder`, and is typed in electron.d.ts.
 *
 * Same sentinel-option pattern DeployTeamDialog already uses, which is why team
 * deployment could always browse and agent creation could not.
 */
const BROWSE = '__browse__';

/** `/Users/noah/Dorothy-fix` reads as `~/Dorothy-fix` on this step. */
const tildePath = (path: string) => path.replace(/^\/(?:Users|home)\/[^/]+\//, '~/');

interface StepProjectProps {
  projects: Project[];
  projectPath: string;
  selectedProject: string;
  /** Still taken from the parent - the custom-path row itself is gone from this step. */
  customPath: string;
  onSelectProject: (path: string) => void;
  onCustomPathChange: (path: string) => void;
  onBrowseFolder?: () => Promise<string | null>;
  showSecondaryProject: boolean;
  onToggleSecondary: () => void;
  selectedSecondaryProject: string;
  onSelectSecondaryProject: (path: string) => void;
  customSecondaryPath: string;
  onCustomSecondaryPathChange: (path: string) => void;
  onClearSecondary: () => void;
  favoriteProjects?: string[];
  hiddenProjects?: string[];
  defaultProjectPath?: string;
  /**
   * WORKTREE + BRANCH belong to the project, not to the task, so they live on
   * this step now. Optional until the modal hands them over, so the step still
   * renders while the call site is being moved.
   */
  useWorktree?: boolean;
  onToggleWorktree?: () => void;
  /** Edit mode with an existing worktree: the branch can't be changed here. */
  worktreeLocked?: boolean;
  branchName?: string;
  onBranchNameChange?: (name: string) => void;
}

const StepProject = React.memo(function StepProject({
  projects,
  projectPath,
  selectedProject,
  onSelectProject,
  onBrowseFolder,
  favoriteProjects = [],
  hiddenProjects = [],
  defaultProjectPath,
  useWorktree = false,
  onToggleWorktree,
  worktreeLocked,
  branchName = '',
  onBranchNameChange,
}: StepProjectProps) {
  // Default first, then favorites, then the rest. The dropdown and the RECENT
  // chips read the same order, so the chips are simply its first three rows.
  const orderedProjects = useMemo(() => {
    const rank = (p: Project) =>
      defaultProjectPath === p.path ? 0 : favoriteProjects.includes(p.path) ? 1 : 2;

    const list = hiddenProjects.length > 0
      ? projects.filter((p) => !hiddenProjects.includes(p.path))
      : projects;

    return [...list].sort((a, b) => rank(a) - rank(b));
  }, [projects, favoriteProjects, hiddenProjects, defaultProjectPath]);

  const recent = orderedProjects.slice(0, RECENT_COUNT);
  // An agent being edited can sit on a project that isn't in the list.
  const current = selectedProject || projectPath;
  const currentIsListed = orderedProjects.some((p) => p.path === current);

  const branchDisabled = !useWorktree || !!worktreeLocked;

  const handleBrowse = async () => {
    if (!onBrowseFolder) return;
    try {
      const picked = await onBrowseFolder();
      if (!picked) return; // dialog cancelled - the Select snaps back to `current`
      const normalized = picked.replace(/\/+$/, '');
      onSelectProject(normalized);
      // Remember it, so a folder reached by browsing joins the quick-pick list
      // instead of having to be re-browsed for every agent. Dedup is handled
      // main-side by writeCustomProjects.
      try {
        await window.electronAPI?.fs?.addCustomProject(normalized);
      } catch { /* the pick still applies to this agent even if persisting fails */ }
    } catch (err) {
      console.error('onBrowseFolder failed:', err);
    }
  };

  return (
    <div className="space-y-5">
      <div>
        <PanelCaption className="mb-1.5">Project</PanelCaption>
        <Select
          value={current}
          onChange={(e) => {
            if (e.target.value === BROWSE) handleBrowse();
            else onSelectProject(e.target.value);
          }}
        >
          {!current && <option value="">Select a project</option>}
          {!!current && !currentIsListed && (
            <option value={current}>{tildePath(current)}</option>
          )}
          {orderedProjects.map((project) => (
            <option key={project.path} value={project.path}>
              {tildePath(project.path)}
            </option>
          ))}
          {onBrowseFolder && <option value={BROWSE}>Choose a folder…</option>}
        </Select>
      </div>

      {recent.length > 0 && (
        <div>
          <PanelCaption className="mb-1.5">Recent</PanelCaption>
          <div className="flex flex-wrap gap-2">
            {recent.map((project) => (
              <Chip
                key={project.path}
                active={current === project.path}
                onClick={() => onSelectProject(project.path)}
                title={project.path}
                className="font-mono"
              >
                {project.name}
              </Chip>
            ))}
          </div>
        </div>
      )}

      <div>
        <PanelCaption className="mb-1.5">Worktree</PanelCaption>
        <div className="flex items-center gap-2.5">
          <Toggle
            enabled={useWorktree}
            onChange={() => onToggleWorktree?.()}
            disabled={worktreeLocked}
          />
          <span className="text-xs text-foreground">
            Give this agent its own branch and directory
          </span>
        </div>
      </div>

      <div>
        <PanelCaption className="mb-1.5">Branch</PanelCaption>
        <Input
          mono
          value={branchName}
          onChange={(e) => onBranchNameChange?.(e.target.value.replace(/\s+/g, '-'))}
          placeholder="feat/frontend"
          disabled={branchDisabled}
        />
        {worktreeLocked && (
          <p className="mt-1 text-[11px] text-muted-foreground">
            The worktree of an existing agent can&apos;t be changed here. To move it to another
            branch, remove the agent and create a new one.
          </p>
        )}
      </div>
    </div>
  );
});

export default StepProject;
