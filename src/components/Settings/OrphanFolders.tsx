import { useCallback, useEffect, useRef, useState } from 'react';
import { Button, StatusSquare } from '@/components/ui';
import { SettingsRow } from './SettingsRow';
import type { OrphanListing, OrphanRemovalProgress, OrphanRemovalReport } from '@/types/electron';
import { TERMINAL_SURFACE_CLASS } from '@/lib/terminal-theme';
import { flat } from '@/lib/stop-line';
import {
  changedLabel, confirmText, doneHint, folderLabel, listingHint, removeLabel, removingHint, sizeLabel, unreadLine, whyLabel,
} from '@/lib/orphan-folders';

type Phase =
  | { kind: 'reading' }
  | { kind: 'list' }
  | { kind: 'asking' }
  | { kind: 'removing'; progress: OrphanRemovalProgress | null }
  | { kind: 'done'; report: OrphanRemovalReport }
  | { kind: 'failed'; message: string };

const HEAD = 'text-[10px] uppercase tracking-[0.08em] text-text-muted';

/**
 * The folders under the projects' .worktrees that no git worktree holds and no
 * agent owns (PR 334): listed with why, their size and when they last changed,
 * and removed all at once only when the person says so, the folders a process
 * works in kept and listed. Frames: `Settings · System · folders no agent owns`
 * and its states: the list, asking first, removing, done with one kept, none,
 * and a project git could not read, alone and beside folders offered.
 */
export function OrphanFolders() {
  const [listing, setListing] = useState<OrphanListing | null>(null);
  const [phase, setPhase] = useState<Phase>({ kind: 'reading' });
  // The folders gone while a removal runs: the list shrinks as they go.
  const [gone, setGone] = useState<ReadonlySet<string>>(new Set());
  const mounted = useRef(true);

  const read = useCallback(async () => {
    const next = await window.electronAPI?.system?.orphanFolders().catch(() => null);
    if (mounted.current) setListing(next ?? { folders: [], count: 0, totalBytes: 0, unreadProjects: [] });
    return next ?? null;
  }, []);

  useEffect(() => {
    mounted.current = true;
    read().then(() => { if (mounted.current) setPhase(p => (p.kind === 'reading' ? { kind: 'list' } : p)); });
    return () => { mounted.current = false; };
  }, [read]);

  const remove = async () => {
    const system = window.electronAPI?.system;
    if (!system || !listing) return;
    // Exactly the rows the confirm named: a folder that became one no agent
    // owns since the list was read goes only once it has been shown (PR 334).
    const paths = listing.folders.map(f => f.path);
    setGone(new Set());
    setPhase({ kind: 'removing', progress: null });
    const off = system.onOrphanRemovalProgress(progress => {
      if (!mounted.current) return;
      setGone(prev => new Set(prev).add(progress.current));
      setPhase(p => (p.kind === 'removing' ? { kind: 'removing', progress } : p));
    });
    let answer: OrphanRemovalReport | { error: string };
    try {
      answer = await system.removeOrphanFolders(paths);
    } catch (err) {
      answer = { error: err instanceof Error ? err.message : String(err) };
    } finally {
      off();
    }
    // What is left is read again: a folder kept is still there, and listed.
    await read();
    if (!mounted.current) return;
    setGone(new Set());
    setPhase('error' in answer ? { kind: 'failed', message: answer.error } : { kind: 'done', report: answer });
  };

  if (!listing) {
    return (
      <div data-orphan-folders>
        <SettingsRow label="Folders no agent owns" description="Reading your projects' .worktrees…" wrap />
      </div>
    );
  }

  const busy = phase.kind === 'removing';
  const kept = phase.kind === 'done' ? new Map(phase.report.kept.map(k => [k.path, k])) : null;
  const rows = listing.folders.filter(f => !gone.has(f.path));
  const unread = unreadLine(listing.unreadProjects);
  const hint = (() => {
    switch (phase.kind) {
      case 'removing': return removingHint(phase.progress);
      case 'done': return doneHint(phase.report, new Set(listing.folders.map(f => f.path)));
      case 'failed': return <span className="text-status-error">Nothing was removed: {flat(phase.message)}</span>;
      default: return listingHint(listing);
    }
  })();
  const button = listing.count === 0 ? null : (
    <Button
      size="sm"
      variant="ghost"
      className="font-mono"
      disabled={busy || phase.kind === 'asking'}
      onClick={() => setPhase({ kind: 'asking' })}
    >
      {busy ? 'removing…' : removeLabel(listing.count)}
    </Button>
  );

  return (
    <div data-orphan-folders>
      <SettingsRow label="Folders no agent owns" description={hint} control={button} wrap />
      {(unread || phase.kind === 'asking' || rows.length > 0) && (
        <div className="px-4 pb-[11px] flex flex-col gap-2.5">
          {/* A project git could not list: named, so the row never reads it as having none. */}
          {unread && (
            <div data-orphan-unread className="flex items-center gap-2">
              <StatusSquare tone="waiting" />
              <p className="min-w-0 flex-1 text-[11px] leading-[1.4] text-muted-foreground">{unread}</p>
            </div>
          )}
          {phase.kind === 'asking' && (
            <div data-orphan-confirm className="flex items-center gap-2.5 px-3 py-2 bg-secondary border border-border">
              <StatusSquare tone="waiting" />
              <p className="min-w-0 flex-1 text-xs leading-[1.35] text-foreground">{confirmText(listing)}</p>
              <Button size="sm" variant="ghost" className="font-mono shrink-0" onClick={() => setPhase({ kind: 'list' })}>cancel</Button>
              <Button size="sm" variant="danger" className="font-mono shrink-0" onClick={remove}>{removeLabel(listing.count)}</Button>
            </div>
          )}
          {rows.length > 0 && (
            <div className={`max-h-[247px] overflow-y-auto border border-border ${TERMINAL_SURFACE_CLASS}`}>
              <div className="sticky top-0 h-[26px] px-2.5 flex items-center gap-2.5 border-b border-border bg-term-bg">
                <span className={`min-w-0 flex-1 ${HEAD}`}>Folder</span>
                <span className={`w-24 shrink-0 ${HEAD}`}>Why</span>
                <span className={`w-16 shrink-0 text-right ${HEAD}`}>Size</span>
                <span className={`w-24 shrink-0 text-right ${HEAD}`}>Last changed</span>
              </div>
              {rows.map(folder => {
                const keptFor = kept?.get(folder.path);
                return (
                  <div key={folder.path} data-orphan-row className="h-[26px] px-2.5 flex items-center gap-2.5 border-b border-border last:border-b-0 font-mono">
                    <span className="min-w-0 flex-1 truncate text-[11px] text-muted-foreground" title={folderLabel(folder)}>{folderLabel(folder)}</span>
                    {/* A kept folder's why: in use names the process, failed says why, in the title. */}
                    <span
                      data-orphan-why
                      title={keptFor?.detail ? flat(keptFor.detail) : undefined}
                      className={`w-24 shrink-0 text-[10.5px] ${keptFor ? (keptFor.reason === 'failed' ? 'text-status-error' : 'text-status-waiting') : 'text-text-muted'}`}
                    >
                      {whyLabel(keptFor?.reason ?? folder.reason)}
                    </span>
                    <span className="w-16 shrink-0 text-right text-[11px] text-muted-foreground">{sizeLabel(folder.sizeBytes)}</span>
                    <span className="w-24 shrink-0 text-right text-[11px] text-text-muted">{changedLabel(folder.lastChangedAt)}</span>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
