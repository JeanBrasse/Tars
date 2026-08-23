'use client';

import { useCallback, useEffect, useState } from 'react';
import { AlertCircle, Loader2 } from 'lucide-react';
import Link from 'next/link';
import { Button } from '@/components/ui';

/**
 * Hermes-backed board. The harness - task lifecycle, workers, runs - lives in
 * Hermes; Tars only reads the board and moves cards. Columns are Hermes'
 * own eight, never projected onto a smaller set (that would be lossy on write).
 */

const COLUMNS = ['triage', 'todo', 'scheduled', 'ready', 'running', 'blocked', 'review', 'done'] as const;

interface HermesTask {
  id: string;
  title?: string;
  status?: string;
  priority?: string | number;
  assignee?: string;
  worker?: string;
  labels?: string[];
  children_done?: number;
  children_total?: number;
  comment_count?: number;
}

interface BoardPayload {
  columns?: Record<string, HermesTask[]>;
}

export default function HermesBoard() {
  const [board, setBoard] = useState<BoardPayload | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [needsSignIn, setNeedsSignIn] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const r = await window.electronAPI?.hermes?.kanbanBoard();
      if (!r) { setError('Electron API unavailable'); return; }
      if (!r.success) {
        setError(r.error || 'Could not read the Hermes board');
        setNeedsSignIn(!!r.needsSignIn);
        return;
      }
      setNeedsSignIn(false);
      setBoard((r.board ?? {}) as BoardPayload);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  if (loading && !board) {
    return (
      <div className="flex items-center justify-center h-full text-muted-foreground gap-2">
        <Loader2 className="w-4 h-4 animate-spin" /> Reading the Hermes board…
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex flex-col items-center justify-center h-full gap-3 text-center px-6">
        <AlertCircle className="w-6 h-6 text-warning" />
        <p className="text-sm text-foreground max-w-md">{error}</p>
        <div className="flex items-center gap-2">
          {/* An anchor, so it cannot come through <Button>; the classes are the
              primary variant at the 26px control height, copied verbatim. */}
          <Link
            href="/settings?section=hermes"
            className="inline-flex items-center justify-center h-[26px] px-2.5 text-xs font-medium border border-primary bg-primary text-primary-foreground hover:bg-primary/90"
          >
            {needsSignIn ? 'Sign in to Hermes' : 'Open Hermes settings'}
          </Link>
          <Button size="sm" onClick={load}>Retry</Button>
        </div>
      </div>
    );
  }

  const columns = board?.columns ?? {};

  return (
    <div className="flex flex-col h-full">
      <div className="flex-1 min-h-0 overflow-x-auto">
        {/* Tracks share the width and only scroll once they hit their floor -
            eight columns still overflow, which is Hermes' shape, not a bug. */}
        <div className="flex gap-2 h-full pb-2">
          {COLUMNS.map(col => {
            const tasks = columns[col] ?? [];
            return (
              <div key={col} className="flex-1 min-w-[200px] flex flex-col border border-border bg-card">
                <div className="flex items-center justify-between px-3 py-2">
                  <span className="text-[11.5px] text-text-secondary">{col}</span>
                  <span className="text-[10px] font-mono text-muted-foreground">{tasks.length}</span>
                </div>
                <div className="flex-1 min-h-0 overflow-y-auto p-2 space-y-2">
                  {tasks.map(t => {
                    const tag = (t.labels ?? [])[0];
                    return (
                      <div key={t.id} className="border border-border bg-bg-tertiary p-3 space-y-2">
                        <p className="text-xs text-foreground leading-snug">{t.title || t.id}</p>
                        {(tag || t.assignee) && (
                          <div className="flex items-center justify-between gap-2">
                            <span className="text-[10px] font-mono lowercase text-muted-foreground truncate">{tag}</span>
                            <span className="text-[10px] text-muted-foreground truncate">{t.assignee}</span>
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
