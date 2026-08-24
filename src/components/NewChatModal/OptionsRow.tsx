'use client';

import { ChevronRight, ChevronDown } from 'lucide-react';
import type { ReactNode } from 'react';

/**
 * The single collapsed row that replaced three of the four wizard steps.
 *
 * Closed, it is a 38px bordered row: a chevron, "Options", and its own
 * contents read out in mono on the right - `2 skills · medium effort · own
 * worktree · auto`. Nothing behind it is hidden, only folded: the summary
 * line is generated from the same state the open panel edits, so it can never
 * drift out of sync with what is actually set.
 */
export function OptionsRow({ open, onToggle, summary, children }: {
  open: boolean;
  onToggle: () => void;
  /** The row's own contents, in mono - blank once nothing has been changed. */
  summary: string;
  children: ReactNode;
}) {
  return (
    <div className="border border-border">
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={open}
        className="w-full h-[38px] px-2.5 flex items-center gap-2 text-left hover:bg-secondary transition-colors cursor-pointer"
      >
        {open ? (
          <ChevronDown className="w-3.5 h-3.5 text-muted-foreground shrink-0" />
        ) : (
          <ChevronRight className="w-3.5 h-3.5 text-muted-foreground shrink-0" />
        )}
        <span className="text-sm text-foreground">Options</span>
        <span className="ml-auto font-mono text-[11px] text-muted-foreground truncate">{summary}</span>
      </button>
      {open && <div className="border-t border-border divide-y divide-border">{children}</div>}
    </div>
  );
}

/**
 * One row inside the open Options panel: a label, a one-line explanation, and
 * the control - always in that order, always inside the same bordered list.
 */
export function OptionRow({ label, hint, children }: { label: string; hint: string; children: ReactNode }) {
  return (
    <div className="flex items-center gap-4 px-2.5 py-2.5">
      <div className="min-w-0 flex-1">
        <p className="text-[13px] text-foreground">{label}</p>
        <p className="text-[11px] text-muted-foreground">{hint}</p>
      </div>
      <div className="shrink-0 w-[220px]">{children}</div>
    </div>
  );
}
