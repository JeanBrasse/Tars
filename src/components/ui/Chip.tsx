'use client';

import type { ButtonHTMLAttributes, ReactNode } from 'react';

export interface ChipProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'children'> {
  active?: boolean;
  /**
   * A 6px solid square before the label. Pass the fill class for it
   * (`bg-status-running`, `bg-status-error`, ...). Omit it and the chip is
   * label-only.
   */
  marker?: string;
  children?: ReactNode;
}

/**
 * The filter chip - `All (22)`, `Running (3)`.
 *
 * One 26px bordered box on a transparent fill. The count belongs *inside* the
 * label string, not in a second badge span beside it: the design writes the
 * filter as one sentence and the badge was the only reason those rows had a
 * pill in them. Selected is the R2(b) box, never an inverted or tinted fill.
 */
export function Chip({ active = false, marker, className = '', children, ...rest }: ChipProps) {
  return (
    <button
      type="button"
      aria-pressed={active}
      className={`inline-flex items-center gap-1.5 h-[26px] px-2.5 text-xs border transition-colors cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed ${
        active
          ? 'bg-secondary border-border-accent text-foreground'
          : 'border-border text-muted-foreground hover:text-foreground hover:bg-secondary'
      } ${className}`}
      {...rest}
    >
      {marker && <span className={`w-1.5 h-1.5 shrink-0 ${marker}`} />}
      {children}
    </button>
  );
}

/**
 * The read-only triplet under an agent or kanban card - provider, model,
 * branch. Not a control, so it sits below the 26px scale: it is a label with a
 * raised background, no border and no radius.
 */
export function MetaChip({ className = '', children }: { className?: string; children: ReactNode }) {
  return (
    <span className={`inline-flex items-center h-5 px-1.5 font-mono text-[10.5px] leading-none text-muted-foreground bg-bg-tertiary ${className}`}>
      {children}
    </span>
  );
}
