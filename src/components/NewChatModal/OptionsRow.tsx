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
        className="w-full h-[38px] px-3 flex items-center gap-2 text-left hover:bg-secondary transition-colors cursor-pointer"
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
    <div className={OPTION_ROW}>
      <div className="min-w-0 flex-1">
        <p className="text-[13px] text-foreground">{label}</p>
        <p className="text-[11px] text-muted-foreground">{hint}</p>
      </div>
      <div className="shrink-0">{children}</div>
    </div>
  );
}

/**
 * Exported so the orchestrator toggle, which owns its own hint text, lays out
 * on exactly the same rule rather than a copy of it.
 *
 * The control column used to be a fixed 220px box, which gave the rows three
 * different alignments at once: a segmented control is inline-flex so it sat
 * at the box's left edge, an input is w-full so it filled the box, and a
 * toggle was pushed to the right. Three right edges in one column. The frame
 * has always specified one row with the label at the left and the control at
 * the right, so that is what this is: nothing fixes the control's width except
 * the control.
 */
export const OPTION_ROW = 'flex items-center justify-between gap-3 px-3 py-2.5';

/** The width the frame gives a text field or a picker in this list. */
export const OPTION_CONTROL_WIDTH = 'w-[236px]';
