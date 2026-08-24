'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { FileDiff } from 'lucide-react';
import { Button, LoadingState, PageHeader, Panel, PanelCaption } from '@/components/ui';
import type { AgentStatus, ChangedFile, ReviewDiff } from '@/types/electron';

/**
 * What the agents actually changed.
 *
 * The Git panel showed twenty lines of `git diff --stat`; the question a
 * reviewer has is which files moved and what the patch says. Each agent with
 * its own worktree is a separate column of work here.
 */

interface Workspace {
  key: string;
  label: string;
  repoPath: string;
  /** The project the tree belongs to. Several branches of one project sit
   *  together in the list, which is unreadable without this. */
  projectPath: string;
  projectName: string;
  agents: string[];
}

function statusTone(status: ChangedFile['status']): string {
  if (status === 'added' || status === 'untracked') return 'text-success';
  if (status === 'deleted') return 'text-danger';
  if (status === 'renamed') return 'text-primary';
  return 'text-muted-foreground';
}

function PatchView({ patch }: { patch: string }) {
  const lines = useMemo(() => patch.split('\n').slice(0, 4000), [patch]);

  return (
    <pre className="text-[11px] font-mono leading-relaxed overflow-x-auto">
      {lines.map((line, i) => {
        const tone = line.startsWith('+') && !line.startsWith('+++')
          ? 'text-success'
          : line.startsWith('-') && !line.startsWith('---')
            ? 'text-danger'
            : line.startsWith('@@')
              ? 'text-primary'
              : 'text-muted-foreground';
        return <div key={i} className={tone}>{line || ' '}</div>;
      })}
    </pre>
  );
}

export default function ReviewPage() {
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [diff, setDiff] = useState<ReviewDiff | null>(null);
  const [activeFile, setActiveFile] = useState<string | null>(null);
  const [filePatch, setFilePatch] = useState<string>('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // One entry per working tree: agents sharing a worktree share their changes.
  useEffect(() => {
    window.electronAPI?.agent?.list?.().then((agents: AgentStatus[] | undefined) => {
      const byPath = new Map<string, Workspace>();
      for (const agent of agents ?? []) {
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
          label: agent.branchName || repoPath.split('/').pop() || repoPath,
          repoPath,
          projectPath,
          projectName: projectPath.split('/').filter(Boolean).pop() || projectPath,
          agents: [agent.name || agent.id],
        });
      }
      const list = Array.from(byPath.values()).sort(
        (a, b) => a.projectName.localeCompare(b.projectName) || a.label.localeCompare(b.label),
      );
      setWorkspaces(list);
      setSelected(current => current ?? list[0]?.key ?? null);
    }).catch(() => setWorkspaces([]));
  }, []);

  const load = useCallback(async (repoPath: string) => {
    setLoading(true);
    setError(null);
    setActiveFile(null);
    setFilePatch('');
    try {
      const res = await window.electronAPI?.review?.diff(repoPath);
      if (!res?.success || !res.diff) {
        setDiff(null);
        setError(res?.error || 'Could not read this repository');
        return;
      }
      setDiff(res.diff);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (selected) void load(selected);
  }, [selected, load]);

  const openFile = useCallback(async (file: string) => {
    if (!diff) return;
    setActiveFile(file);
    setFilePatch('');
    const res = await window.electronAPI?.review?.file(diff.repo, file, diff.baseBranch ?? undefined);
    setFilePatch(res?.patch || '');
  }, [diff]);

  return (
    <div className="h-[calc(100vh-7rem)] lg:h-[calc(100vh-44px)] flex flex-col">
      <PageHeader
        title="Review"
        subtitle="What your agents changed, per working tree."
        actions={
          <Button
            size="md"
            onClick={() => selected && load(selected)}
            disabled={loading || !selected}
          >
            Refresh
          </Button>
        }
      />

      {workspaces.length === 0 ? (
        <div className="flex flex-col items-center justify-center flex-1 gap-2 text-center">
          <FileDiff className="w-6 h-6 text-muted-foreground/40" />
          <p className="text-sm text-muted-foreground">No agent has a working tree yet.</p>
          <p className="text-xs text-muted-foreground">Deploy a team, and their branches show up here.</p>
        </div>
      ) : (
        <div className="flex-1 min-h-0 flex gap-3">
          {/* Three panels, not one strip cut up by `border-l`: the trees, the
              files in the selected tree, and the patch of the selected file. */}
          <Panel fill className="w-[236px] shrink-0">
            <PanelCaption>Working trees</PanelCaption>
            <div className="flex-1 min-h-0 overflow-y-auto mt-2 space-y-2">
              {workspaces.map((w, i) => (
                <div key={`g-${w.key}`} className="space-y-2">
                {/* The project name once, above its branches, rather than
                    repeated on every row or left off entirely. */}
                {(i === 0 || workspaces[i - 1].projectName !== w.projectName) && (
                  <p
                    className={`font-mono text-[10px] font-medium text-text-secondary truncate ${i === 0 ? '' : 'pt-2'}`}
                    title={w.projectPath}
                  >
                    {w.projectName.toUpperCase()}
                  </p>
                )}
                <button
                  key={w.key}
                  onClick={() => setSelected(w.key)}
                  className={`w-full text-left px-2.5 py-2 border transition-colors ${
                    w.key === selected
                      ? 'bg-secondary border-border-accent'
                      : 'bg-card border-border hover:bg-secondary'
                  }`}
                >
                  <span
                    className={`block truncate text-[12.5px] ${
                      w.key === selected ? 'text-foreground' : 'text-text-secondary'
                    }`}
                  >
                    {w.label}
                  </span>
                  <span className="block text-[10px] text-muted-foreground truncate mt-0.5">
                    {w.agents.join(', ')}
                  </span>
                </button>
                </div>
              ))}
            </div>
          </Panel>

          {/* Files */}
          <Panel fill className="w-[300px] shrink-0">
            <LoadingState
              loading={loading}
              rows={5}
              what="Still reading the working tree…"
              detail="git diff against the base branch"
            />
            {error && <p className="text-xs text-danger py-4">{error}</p>}
            {diff && !loading && (
              <>
                <p className="text-[11px] font-mono text-muted-foreground">
                  {diff.branch}
                  {diff.baseBranch ? ` vs ${diff.baseBranch}` : ''}
                  {diff.ahead ? ` · ${diff.ahead} commit${diff.ahead > 1 ? 's' : ''} ahead` : ''}
                </p>
                <p className="text-[11px] font-mono mt-1">
                  <span className="text-success">+{diff.totalAdditions}</span>{' '}
                  <span className="text-danger">-{diff.totalDeletions}</span>{' '}
                  <span className="text-muted-foreground">
                    in {diff.files.length} file{diff.files.length === 1 ? '' : 's'}
                  </span>
                </p>
                {diff.files.length === 0 && (
                  <p className="text-xs text-muted-foreground mt-3">Nothing changed in this tree.</p>
                )}
                {/* The open file is a box the width of the panel's inside, with
                    its path, counts and status in it - not a bare wash. */}
                <div className="flex-1 min-h-0 overflow-y-auto mt-3 space-y-1">
                  {diff.files.map(f => (
                    <button
                      key={f.path}
                      onClick={() => openFile(f.path)}
                      className={`w-full text-left px-2 py-1.5 border text-[11px] font-mono transition-colors ${
                        f.path === activeFile
                          ? 'bg-secondary border-border-accent text-foreground'
                          : 'border-transparent text-muted-foreground hover:text-foreground'
                      }`}
                    >
                      <span className="flex items-center justify-between gap-2">
                        <span className="truncate">{f.path}</span>
                        <span className="shrink-0 text-[10px]">
                          <span className="text-success">+{f.additions}</span>{' '}
                          <span className="text-danger">-{f.deletions}</span>
                        </span>
                      </span>
                      <span className={`block text-[10px] ${statusTone(f.status)}`}>{f.status}</span>
                    </button>
                  ))}
                </div>
              </>
            )}
          </Panel>

          {/* Patch */}
          <Panel fill className="flex-1 min-w-0">
            <div className="flex-1 min-h-0 overflow-auto">
              {activeFile ? (
                <>
                  <p className="text-xs font-mono text-foreground mb-2 sticky top-0 bg-card py-1">{activeFile}</p>
                  {filePatch ? <PatchView patch={filePatch} /> : (
                    <p className="text-xs text-muted-foreground">No textual change to show for this file.</p>
                  )}
                </>
              ) : diff?.patch ? (
                <PatchView patch={diff.patch} />
              ) : (
                <p className="text-xs text-muted-foreground">Pick a file to read its patch.</p>
              )}
            </div>
          </Panel>
        </div>
      )}
    </div>
  );
}
