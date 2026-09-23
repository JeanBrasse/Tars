'use client';

import { useRef, useState } from 'react';
import { Info } from 'lucide-react';
import { Button, StatusSquare } from '@/components/ui';
import { AnchoredMenu } from './AnchoredMenu';
import type { RoomState } from './team-view';

/** How the room runs. Every line is a rule the bus enforces in code, not
 *  advice. Frame: `Chat · A · Room · nothing said yet, how it runs open`. */
export const ROOM_RULES: Array<[string, string]> = [
  ['posts', 'publishing is an act: a turn can end without a word'],
  ['speaks', 'when named, or to hand back a job it was given'],
  ['never', 'a bare acknowledgement, and nothing on a heartbeat'],
  ['queue', 'a message to a busy agent waits for its turn to end'],
  ['limit', '3 rounds or 10 agent messages without you, then it pauses'],
  ['you', 'only you stop, add or change an agent'],
];

/**
 * The head of a room, 52 high: its name and path, then its state in words,
 * how it runs, and stop while it relays. Frames: the room head of every
 * `Chat · A · Room` page.
 *
 * Content sits 24 from each edge of the panel, as everything in it does. When
 * the last control is the ghost `how it runs`, the head's right padding is 14:
 * a ghost button's label sits 10 inside its box, so its words end at 24 like
 * the bordered buttons' edges.
 */
export function RoomHead({
  title,
  path,
  state,
  onStop,
  stopTitle,
}: {
  title: string;
  path?: string;
  state: RoomState;
  onStop?: () => void;
  stopTitle?: string;
}) {
  const [howOpen, setHowOpen] = useState(false);
  const how = useRef<HTMLButtonElement>(null);
  const showStop = state.relaying && !!onStop;

  return (
    <div data-room-head className={`h-[52px] shrink-0 flex items-center gap-2 pl-6 border-b border-border ${showStop ? 'pr-6' : 'pr-3.5'}`}>
      <span className="text-[15px] leading-5 font-medium text-foreground truncate">{title}</span>
      {/* 1px low: the 11px mono baseline sits a pixel above the 15px title's. */}
      {path && <span className="relative top-px font-mono text-[11px] leading-4 text-text-muted truncate">{path}</span>}
      <span className="flex-1" />
      <span className="flex items-center gap-2 shrink-0" role="status">
        {state.tone === 'hollow' ? <StatusSquare hollow /> : state.tone !== 'none' && <StatusSquare tone={state.tone} />}
        <span className="text-[12px] leading-4 text-text-secondary">{state.word}</span>
        {state.detail && (
          <>
            <span className="text-[12px] leading-4 text-text-muted">·</span>
            <span className="text-[12px] leading-4 text-text-muted">{state.detail}</span>
          </>
        )}
      </span>
      <Button
        ref={how}
        size="sm"
        variant="ghost"
        active={howOpen}
        aria-haspopup="menu"
        aria-expanded={howOpen}
        onClick={() => setHowOpen(o => !o)}
      >
        <Info className="w-3 h-3" />
        how it runs
      </Button>
      <AnchoredMenu anchor={how} open={howOpen} onClose={() => setHowOpen(false)} align="right" width={400} label="How this room runs">
        <div className="pb-2">
          <div className="h-8 flex items-center px-3 border-b border-border">
            <span className="relative top-px text-[10px] leading-4 uppercase tracking-[0.08em] text-text-secondary">how this room runs</span>
          </div>
          {ROOM_RULES.map(([key, value]) => (
            <div key={key} className="flex gap-3 px-3 py-1">
              <span className="w-12 shrink-0 font-mono text-[11px] leading-5 text-foreground">{key}</span>
              <span className="flex-1 min-w-0 text-[12px] leading-5 text-text-secondary">{value}</span>
            </div>
          ))}
        </div>
      </AnchoredMenu>
      {showStop && (
        <Button size="sm" title={stopTitle} onClick={onStop}>stop</Button>
      )}
    </div>
  );
}
