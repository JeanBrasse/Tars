'use client';

import type { ReactNode } from 'react';
import { ArrowDown, ArrowRight, FileText, Hand, Image as ImageIcon, Send, Square, UserMinus, UserPlus, Users } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { Button, MetaChip } from '@/components/ui';
import type { BusAttachment, BusSystemKind } from '@/types/electron';
import { fileSize } from './bus-view';
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

export function Time({ children }: { children: ReactNode }) {
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
        {item.files && (
          <div className="flex flex-wrap items-center gap-x-1.5 gap-y-1 pt-1">
            {item.files.map(file => <FileChip key={file.id} file={file} />)}
          </div>
        )}
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

/**
 * One file a message carried: its kind, its name and its size, in a 20px chip
 * on the card's surface, with the path the agents were given in its title.
 * Frame: `Chat · A · Thread rows · states` > `YOUR LINE`, 09:58.
 */
function FileChip({ file }: { file: BusAttachment }) {
  const Kind = file.isImage ? ImageIcon : FileText;
  return (
    <span title={file.path} className="inline-flex items-center gap-1.5 h-5 px-1.5 max-w-[320px] rounded border border-border bg-card">
      <Kind className="w-3 h-3 shrink-0 text-text-secondary" />
      <span className="text-[12px] leading-4 text-foreground truncate">{file.name}</span>
      <span className="shrink-0 font-mono text-[10.5px] leading-4 text-text-muted">{fileSize(file.bytes)}</span>
    </span>
  );
}

const SYSTEM_ICON: Record<BusSystemKind, LucideIcon> = {
  members_changed: Users,
  thread_stopped: Square,
  queue_released: Send,
  // Send now's line (PR 169): the frame's raised hand.
  turn_interrupted: Hand,
};

/** The frame's person-plus and person-minus when the line says which way;
 *  a change both ways, or one written before the bus said, keeps one icon. */
function systemIcon(item: SystemItem): ReactNode {
  const added = item.members?.added.length ?? 0;
  const removed = item.members?.removed.length ?? 0;
  const Icon = item.systemKind === 'members_changed' && added && !removed ? UserPlus
    : item.systemKind === 'members_changed' && removed && !added ? UserMinus
      : item.systemKind ? SYSTEM_ICON[item.systemKind] : Users;
  return <Icon className="w-3.5 h-3.5 shrink-0 text-text-muted" />;
}

/** A line the room writes about itself: a change of members, a stopped
 *  exchange, a queue you sent on, a turn you interrupted. Its icon says which. */
export function SystemRow({ item }: { item: SystemItem }) {
  return (
    <div data-row-kind="system" className="flex gap-3 px-6 py-2">
      <Time>{item.time}</Time>
      <div className="flex-1 min-w-0 h-5 flex items-center gap-2">
        {systemIcon(item)}
        <span className="text-[12px] leading-5 text-text-secondary truncate">{item.text}</span>
        {item.more && <span className="min-w-0 text-[12px] leading-5 text-text-muted truncate">{item.more}</span>}
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

/** Under a thread while you read above its bottom: how many messages arrived
 *  below, and the way back to them. The room's and Hermes's. */
export function NewBelowBand({ count, onJump }: { count: number; onJump: () => void }) {
  if (count <= 0) return null;
  return (
    <div className="h-10 shrink-0 flex items-center px-6 bg-secondary border-t border-border">
      <span className="w-12 shrink-0 flex items-center"><ArrowDown className="w-3 h-3 text-foreground" /></span>
      <span className="flex-1 min-w-0 text-[12px] leading-4 text-foreground">
        {count} new message{count === 1 ? '' : 's'} below
      </span>
      <Button size="sm" onClick={onJump}>jump to latest</Button>
    </div>
  );
}
