'use client';

import type { ReactNode } from 'react';
import { ArrowRight, Send, Square, Users } from 'lucide-react';
import { MetaChip } from '@/components/ui';
import type { BusSystemKind } from '@/types/electron';
import type { DayItem, MessageItem, NoticeItem, SystemItem } from './bus-view';

/**
 * The rows a thread is made of. Frames: the thread of every `Chat · A · Room`
 * page and the sheet `Chat · A · Thread rows · states`.
 *
 * Two columns for every row: the time at 24 from the panel's edge, 36 wide,
 * then everything else from 72. Your own line is a band across the room, like
 * the needs-you strip, so no box adds an edge the rest do not share. Lines are
 * 20 high, and the 11px mono time sits on the same baseline as the 13px names
 * (the renderer puts both 4px under their line's centre).
 */

function Time({ children }: { children: ReactNode }) {
  return <span className="w-9 shrink-0 font-mono text-[11px] leading-5 text-text-muted">{children}</span>;
}

export function MessageRow({ item }: { item: MessageItem }) {
  return (
    <div
      data-row-kind={item.you ? 'you' : item.tag?.state ?? 'delivered'}
      // Your line's band: the top and bottom borders take their pixels from
      // the padding, so the row is as tall as any other.
      className={`flex gap-3 px-6 ${item.you ? 'bg-secondary border-y border-border py-[7px]' : 'py-2'}`}
    >
      <Time>{item.time}</Time>
      <div className="flex-1 min-w-0 flex flex-col">
        <div className="h-5 flex items-center gap-1.5 min-w-0">
          <span className="text-[13px] leading-5 font-medium text-foreground truncate">{item.from}</span>
          <ArrowRight aria-label="to" className="w-3 h-3 shrink-0 text-text-secondary" />
          <span className="text-[13px] leading-5 text-text-secondary truncate">{item.to}</span>
        </div>
        <p className={`max-w-[720px] text-[14px] leading-5 whitespace-pre-wrap break-words ${item.dim ? 'text-text-secondary' : 'text-foreground'}`}>
          {item.text}
        </p>
        {(item.tag || item.note) && (
          <div className="flex items-center gap-2 pt-1 min-w-0">
            {item.tag && <MetaChip>{item.tag.label}</MetaChip>}
            <span className="text-[12px] leading-5 text-text-muted truncate">{item.tag?.note ?? item.note}</span>
          </div>
        )}
      </div>
    </div>
  );
}

const SYSTEM_ICON: Record<BusSystemKind, ReactNode> = {
  // Who joined or left is not on the message yet (#159, contract 2), so a
  // change of members has one icon for both ways.
  members_changed: <Users className="w-3.5 h-3.5 shrink-0 text-text-muted" />,
  thread_stopped: <Square className="w-3.5 h-3.5 shrink-0 text-text-muted" />,
  queue_released: <Send className="w-3.5 h-3.5 shrink-0 text-text-muted" />,
};

/** A line the room writes about itself: a change of members, a stopped
 *  exchange, a queue you sent on. Its icon says which. */
export function SystemRow({ item }: { item: SystemItem }) {
  return (
    <div data-row-kind="system" className="flex gap-3 px-6 py-2">
      <Time>{item.time}</Time>
      <div className="flex-1 min-w-0 h-5 flex items-center gap-2">
        {item.systemKind ? SYSTEM_ICON[item.systemKind] : <Users className="w-3.5 h-3.5 shrink-0 text-text-muted" />}
        <span className="text-[12px] leading-5 text-text-secondary truncate">{item.text}</span>
      </div>
    </div>
  );
}

/** A rule between two days, the day in its middle. */
export function DayRow({ item }: { item: DayItem }) {
  return (
    <div className="h-9 flex items-center gap-3 px-6" role="separator" aria-label={item.label}>
      <span className="flex-1 border-t border-border" />
      <span className="font-mono text-[11px] leading-4 text-text-muted">{item.label}</span>
      <span className="flex-1 border-t border-border" />
    </div>
  );
}

/** Where an exchange ended without you: paused at its limit, stopped, or
 *  replaced. A block in the body column, like a card in a message. */
export function NoticeRow({ item }: { item: NoticeItem }) {
  return (
    <div className="py-2 pr-6 pl-[72px]">
      <div className="border border-border px-3 py-3 flex flex-col gap-1">
        <span className="relative top-px text-[10px] leading-4 uppercase tracking-[0.08em] text-text-secondary">
          {item.caption}
        </span>
        {item.lines.map((line, i) => (
          <p key={i} className="text-[12px] leading-5 text-text-secondary">{line}</p>
        ))}
      </div>
    </div>
  );
}
