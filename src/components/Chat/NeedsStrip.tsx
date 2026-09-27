'use client';

import { useState } from 'react';
import { ChevronDown } from 'lucide-react';
import { Button, StatusSquare } from '@/components/ui';
import type { NeedAction, NeedRow } from './team-view';

/** Rows shown before the rest fold behind `show N more`. */
const SHOWN = 3;

/**
 * What needs you, as a band across the top of the room. Frame: the needs-you
 * strip of `Chat · A · Room · *`.
 *
 * Each row is 40 high: the status square in the time column at 24, the
 * sentence from 72 like the thread's words, then `since` and the action. The
 * action sits in a 96px slot, right-aligned, so every `since` ends at the same
 * x whatever the button.
 */
export function NeedsStrip({ rows, onAction }: { rows: NeedRow[]; onAction: (action: NeedAction, agentId: string) => void }) {
  const [all, setAll] = useState(false);
  if (rows.length === 0) return null;
  const shown = all ? rows : rows.slice(0, SHOWN);
  return (
    <div data-needs-strip className="shrink-0 bg-secondary border-b border-border">
      {shown.map(row => (
        <div key={row.id} className="h-10 flex items-center px-6 border-b border-border last:border-b-0">
          <span className="w-12 shrink-0 flex items-center">
            {row.tone === 'hollow' ? <StatusSquare hollow /> : row.tone !== 'none' && <StatusSquare tone={row.tone} />}
          </span>
          <span className="flex-1 min-w-0 text-[13px] leading-4 text-foreground truncate" title={row.text}>{row.text}</span>
          <span className="shrink-0 pl-3 font-mono text-[11px] leading-4 text-text-muted whitespace-nowrap">
            {row.since ? `since ${row.since}` : ''}
          </span>
          <span className="w-[108px] shrink-0 pl-3 flex justify-end">
            <Button size="sm" onClick={() => onAction(row.action, row.agentId)}>{row.actionLabel}</Button>
          </span>
        </div>
      ))}
      {rows.length > SHOWN && !all && (
        // The chevron sits at 72, where the rows' sentences start.
        <div className="h-8 flex items-center pl-[62px] border-t border-border">
          <Button size="sm" variant="ghost" onClick={() => setAll(true)}>
            <ChevronDown className="w-3 h-3" />
            show {rows.length - SHOWN} more
          </Button>
        </div>
      )}
    </div>
  );
}
