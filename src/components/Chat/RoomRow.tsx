'use client';

import type { ReactNode } from 'react';
import type { RoomRowModel } from './bus-view';

/**
 * One row per thing that happened, in columns: when, who, to whom, then the
 * text. Frame: `Chat · Room · the rows a room is made of`.
 *
 * Columns rather than bubbles because every line in a room has both a speaker
 * and a recipient: a bubble puts one on the edge and the other nowhere, and
 * six agents read as a scatter. Colour is spent on state only, and your own
 * line is the only boxed one.
 */

/** The three fixed columns, in px, exactly as the frame draws them. */
const COL = { time: 'w-8', from: 'w-[84px]', to: 'w-[100px]' };

function Tag({ children }: { children: ReactNode }) {
  return (
    <span className="inline-flex shrink-0 items-center h-[18px] px-1.5 border border-border-accent bg-secondary font-mono text-[9.5px] tracking-[0.06em] text-text-secondary">
      {children}
    </span>
  );
}

export function RoomRow({ row, actions }: { row: RoomRowModel; actions?: ReactNode }) {
  const machine = row.kind === 'system';
  const dimmed = row.kind === 'queued' || row.kind === 'unsent' || row.kind === 'dropped';

  return (
    <div
      data-row-kind={row.kind}
      className={`flex gap-2 px-2 py-[5px] ${row.kind === 'you' ? 'bg-secondary border border-border' : ''}`}
    >
      <span className={`${COL.time} shrink-0 font-mono text-[10.5px] leading-[1.78] text-muted-foreground`}>
        {row.time}
      </span>
      <span
        className={`${COL.from} shrink-0 font-mono text-[10.5px] leading-[1.78] truncate ${
          machine || row.kind === 'you' ? 'text-muted-foreground' : 'text-foreground'
        }`}
      >
        {row.from}
      </span>
      <span
        className={`${COL.to} shrink-0 font-mono text-[10.5px] leading-[1.78] truncate ${
          machine ? 'text-muted-foreground' : 'text-text-secondary'
        }`}
      >
        {row.to}
      </span>

      <div className="flex-1 min-w-0 flex flex-col gap-[5px]">
        <p
          className={`whitespace-pre-wrap break-words ${
            machine
              ? 'font-mono text-[10.5px] leading-[1.78] text-muted-foreground'
              : `text-[12.5px] leading-[1.5] ${dimmed ? 'text-text-secondary' : 'text-foreground'}`
          }`}
        >
          {row.text}
        </p>

        {/* The tag never travels alone: the note beside it says who is waiting
            and until when, which is the part a reader acts on. */}
        {row.tag && (
          <div className="flex items-start gap-2">
            <Tag>{row.tag.label}</Tag>
            <span className="flex-1 min-w-0 font-mono text-[10px] leading-[1.8] text-muted-foreground break-words">
              {row.tag.note}
            </span>
          </div>
        )}

        {/* Receipts under your own line: who has it, who is waiting, who will
            never get it. Shown alongside a tag, never instead of it. */}
        {row.note && (
          <span className="font-mono text-[10px] leading-[1.5] text-muted-foreground break-words">{row.note}</span>
        )}

        {actions && <div className="flex items-center gap-2 py-0.5">{actions}</div>}
      </div>
    </div>
  );
}

/** The separator a notice sits on: a rule, a caption, a rule. */
export function RoomNotice({ caption, lines }: { caption: string; lines: string[] }) {
  return (
    <div className="flex flex-col items-center gap-2 px-2 py-3.5">
      <div className="w-full flex items-center gap-2.5">
        <span className="flex-1 border-t border-border" />
        <span className="font-mono text-[10.5px] text-foreground">{caption}</span>
        <span className="flex-1 border-t border-border" />
      </div>
      {lines.map((line, i) => (
        <p key={i} className="max-w-[440px] text-center text-xs leading-[1.5] text-text-secondary">
          {line}
        </p>
      ))}
    </div>
  );
}
