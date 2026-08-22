'use client';

import type { HTMLAttributes, ReactNode } from 'react';

export interface PanelProps extends HTMLAttributes<HTMLDivElement> {
  /**
   * Full-height track (kanban column, review column, log fleet). The panel
   * becomes a flex column that owns the remaining height, so an empty one
   * still reads as a drop target instead of collapsing to its content.
   */
  fill?: boolean;
  /** Off when the panel owns a header band and scroller with their own insets. */
  padded?: boolean;
}

/**
 * The bordered surface every screen is built from.
 *
 * Screens used to draw their columns with `border-l` + `pl-4` dividers, which
 * gave a shared edge to things that are not one object and no edge at all to
 * things that are. A panel is a box: 1px border, card fill, 12px of padding,
 * as tall as what is in it unless it is a track.
 */
export function Panel({ fill = false, padded = true, className = '', children, ...rest }: PanelProps) {
  return (
    <div
      className={`border border-border bg-card ${padded ? 'p-3' : ''} ${
        fill ? 'flex flex-col h-full min-h-0' : ''
      } ${className}`}
      {...rest}
    >
      {children}
    </div>
  );
}

/**
 * The caption above a panel's content - `WORKING TREES`, `BY PROVIDER`,
 * `DAILY COST · 14 DAYS`. 10px uppercase and letter-spaced, and never with an
 * icon beside it (R8): the icons were decoration on text that already says
 * what the panel holds.
 *
 * Spacing below it belongs to the panel's own layout, so this carries no
 * margin of its own.
 */
export function PanelCaption({ children, className = '' }: { children: ReactNode; className?: string }) {
  return (
    <div className={`text-[10px] uppercase tracking-[0.08em] text-muted-foreground ${className}`}>
      {children}
    </div>
  );
}
