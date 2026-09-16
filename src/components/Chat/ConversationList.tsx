'use client';

import { StatusSquare } from '@/components/ui';
import type { StatusTone } from '@/components/ui';
import type { BusRoom } from '@/types/electron';

/**
 * The left column, 224 wide: the global room at the top, one room per project
 * under it. Frame: `Chat · Hermes · with rooms` > `Conversations`.
 *
 * Two captions rather than one list, because the two levels are not the same
 * kind of thing: Hermes watches every project and answers across them, a room
 * is the agents of one project talking to each other and to you.
 */

export interface ConversationSummary {
  id: string;
  name: string;
  /** `overseer` under Hermes, the project folder under a room. */
  sub?: string;
  tone: StatusTone | 'none';
  time: string;
  preview: string;
  /** Short state counts: `2 running`, `2 queued`, `2 need you`. */
  counts: Array<{ label: string; tone?: 'running' | 'waiting' | 'secondary' }>;
  unread?: number;
}

const COUNT_CLASS: Record<'running' | 'waiting' | 'secondary', string> = {
  running: 'text-status-running',
  waiting: 'text-status-waiting',
  secondary: 'text-text-secondary',
};

function Row({
  conversation,
  active,
  onSelect,
}: {
  conversation: ConversationSummary;
  active: boolean;
  onSelect: () => void;
}) {
  const unread = !!conversation.unread && !active;
  return (
    <button
      type="button"
      onClick={onSelect}
      aria-current={active ? 'true' : undefined}
      // Active is a box: the tinted fill DESIGN.md gives nav and menu rows,
      // never a rule down the side.
      className={`w-full text-left flex flex-col gap-[3px] px-2.5 py-[9px] border-b border-border cursor-pointer ${
        active ? 'bg-accent-dim' : 'hover:bg-secondary'
      }`}
    >
      <div className="flex items-center gap-2 min-w-0">
        {conversation.tone === 'none'
          ? <span className="w-1.5 h-1.5 shrink-0" />
          : <StatusSquare tone={conversation.tone} />}
        <span
          className={`text-[12.5px] truncate ${
            unread || active ? 'text-foreground' : 'text-text-secondary'
          } ${unread ? 'font-medium' : ''}`}
        >
          {conversation.name}
        </span>
        {conversation.sub && (
          <span className="font-mono text-[9.5px] text-muted-foreground truncate">{conversation.sub}</span>
        )}
        <span className="flex-1" />
        <span className={`font-mono text-[10px] shrink-0 ${unread ? 'text-foreground' : 'text-muted-foreground'}`}>
          {unread ? `${conversation.unread} new` : conversation.time}
        </span>
      </div>
      <p className="pl-3.5 text-[11px] leading-[1.45] text-muted-foreground truncate">{conversation.preview}</p>
      {conversation.counts.length > 0 && (
        <div className="pl-3.5 flex items-center gap-1.5 min-w-0">
          {conversation.counts.map((c, i) => (
            <span key={c.label} className="flex items-center gap-1.5 min-w-0">
              {i > 0 && <span className="text-[10.5px] text-muted-foreground">·</span>}
              <span className={`text-[10.5px] truncate ${c.tone ? COUNT_CLASS[c.tone] : 'text-muted-foreground'}`}>
                {c.label}
              </span>
            </span>
          ))}
        </div>
      )}
    </button>
  );
}

function Caption({ children }: { children: React.ReactNode }) {
  return (
    <div className="px-2.5 pt-3 pb-1.5 border-b border-border">
      <span className="text-[10px] uppercase tracking-[0.06em] text-muted-foreground">{children}</span>
    </div>
  );
}

export function ConversationList({
  global,
  rooms,
  selectedId,
  onSelect,
  error = null,
}: {
  global: ConversationSummary;
  rooms: ConversationSummary[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  /** The bus refused or failed to answer. Without this, a bus that is down
   *  renders exactly like a fleet that has not spoken yet, under a sentence
   *  promising rooms will appear. */
  error?: string | null;
}) {
  return (
    <div className="w-[224px] shrink-0 flex flex-col min-h-0 border border-border bg-card">
      <div className="flex items-center justify-between h-8 pl-2.5 pr-[3px] border-b border-border shrink-0">
        <span className="text-[10px] uppercase tracking-[0.06em] text-muted-foreground">conversations</span>
        <span className="font-mono text-[10px] text-muted-foreground">
          {rooms.length} {rooms.length === 1 ? 'room' : 'rooms'}
        </span>
      </div>

      <div className="flex-1 min-h-0 overflow-y-auto">
        <Caption>across all projects</Caption>
        <Row conversation={global} active={selectedId === global.id} onSelect={() => onSelect(global.id)} />

        <Caption>one room per project</Caption>
        {error ? (
          // Same treatment as the room's own error line, so a failure reads the
          // same wherever it happens on this page.
          <p className="mx-2.5 my-2.5 border border-danger/40 px-2 py-1.5 text-[11px] leading-[1.5] text-danger">
            The bus did not answer, so this list is not the whole truth. {error}
          </p>
        ) : rooms.length === 0 ? (
          <p className="px-2.5 py-3 text-[11px] leading-[1.5] text-muted-foreground">
            No project room yet. A room appears for a project as soon as one of its agents speaks.
          </p>
        ) : (
          rooms.map(room => (
            <Row
              key={room.id}
              conversation={room}
              active={selectedId === room.id}
              onSelect={() => onSelect(room.id)}
            />
          ))
        )}
      </div>
    </div>
  );
}

/** A room, as the list shows it. Kept beside the component so the page builds
 *  summaries in one place rather than shaping them inline. */
export function roomSummary(
  room: BusRoom,
  opts: { time: string; preview: string; counts: ConversationSummary['counts']; tone: StatusTone | 'none'; unread?: number },
): ConversationSummary {
  const parts = (room.projectPath ?? '').split('/').filter(Boolean);
  return {
    id: room.id,
    name: room.title || parts[parts.length - 1] || room.id,
    tone: opts.tone,
    time: opts.time,
    preview: opts.preview,
    counts: opts.counts,
    unread: opts.unread,
  };
}
