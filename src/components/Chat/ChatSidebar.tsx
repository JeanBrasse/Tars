'use client';

import { Fragment, memo, useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { ChevronDown, ChevronRight, Ellipsis, Eye, Pencil, Plus, RotateCcw, Square, UserMinus } from 'lucide-react';
import { AgentMark, Button, MetaChip, StatusSquare } from '@/components/ui';
import type { RoomAgent } from '@/hooks/useRoomAgents';
import type { AgentStatus } from '@/types/electron';
import { sameProps } from '@/lib/same-props';
import { AnchoredMenu } from './AnchoredMenu';
import {
  agentDetail,
  agentDuration,
  agentStatusLabel,
  rowActions,
  shortModel,
  statusInk,
} from './team-view';
import type { RowActionId, RowCount, RowTone } from './team-view';

/**
 * The Chat's left column, 256 wide: Hermes, the rooms, then the open room's
 * team or what Hermes can reach. Frames: `Chat · A · Room · agents at work` and
 * `Chat · A · Hermes` > `Left column`, and the sheet `Chat · A · Team rows ·
 * states`, in design/chat-redesign-a.pen.
 *
 * One text column for every row: each row leads with a 16px slot at 12 (a
 * status square, a chevron, an agent mark or an icon), then 8, so every name,
 * caption and line starts 36 from the column's edge. Rows are 52 (Hermes and
 * rooms), 56 (agents, 96 open) and 32 (captions and what Hermes can reach).
 */

const COUNT_INK: Record<NonNullable<RowCount['tone']>, string> = {
  waiting: 'text-status-waiting',
  error: 'text-status-error',
};

/** The 16px slot every row leads with. */
function Lead({ children }: { children?: ReactNode }) {
  return <span className="w-4 h-4 shrink-0 flex items-center justify-center">{children}</span>;
}

function ToneSquare({ tone }: { tone: RowTone }) {
  if (tone === 'none') return null;
  return tone === 'hollow' ? <StatusSquare hollow /> : <StatusSquare tone={tone} />;
}

/**
 * A caption, 10px and letter-spaced, sat 1px low: the renderer puts a 10px
 * baseline one pixel above the 11px mono count beside it (measured on the
 * pen engine's glyphs, the same fonts as the app).
 */
function Caption({ children }: { children: ReactNode }) {
  return (
    <span className="relative top-px text-[10px] leading-4 uppercase tracking-[0.08em] text-text-secondary whitespace-nowrap">
      {children}
    </span>
  );
}

/** Hermes or a room: a name, then one line of counts. 52 high. */
export function ConversationRow({
  name,
  sub,
  tone,
  time,
  counts,
  selected,
  onSelect,
}: {
  name: string;
  sub?: string;
  tone: RowTone;
  time?: string;
  counts: RowCount[];
  selected: boolean;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onSelect}
      aria-current={selected ? 'true' : undefined}
      // Active is a box: the tinted fill, never a rule down the side.
      // pb 7: the bottom border takes the last pixel of the row, as the frame's
      // stroke does, so the row is 52 and not 53.
      className={`w-full h-[52px] shrink-0 flex flex-col gap-1 px-3 pt-2 pb-[7px] text-left border-b border-border cursor-pointer ${
        selected ? 'bg-accent-dim' : 'hover:bg-secondary'
      }`}
    >
      <span className="w-full h-4 flex items-center gap-2 min-w-0">
        <Lead><ToneSquare tone={tone} /></Lead>
        <span className={`text-[13px] leading-4 text-foreground truncate ${selected ? 'font-medium' : ''}`}>{name}</span>
        {sub && <span className="font-mono text-[11px] leading-4 text-text-muted shrink-0">{sub}</span>}
        <span className="flex-1" />
        {time && <span className="font-mono text-[11px] leading-4 text-text-muted shrink-0">{time}</span>}
      </span>
      <span className="w-full h-4 flex items-center gap-1.5 pl-6 min-w-0 overflow-hidden">
        {counts.map((c, i) => (
          <Fragment key={c.label}>
            {i > 0 && <span className="text-[12px] leading-4 text-text-muted">·</span>}
            <span className={`text-[12px] leading-4 whitespace-nowrap ${c.tone ? COUNT_INK[c.tone] : 'text-text-muted'}`}>{c.label}</span>
          </Fragment>
        ))}
      </span>
    </button>
  );
}

/** A section's caption row, 32 high. Folds its section when it has one to fold. */
function SectionHead({
  label,
  count,
  folded,
  onFold,
  summary,
  action,
}: {
  label: string;
  count?: number | string;
  folded?: boolean;
  onFold?: () => void;
  summary?: RowCount[];
  action?: ReactNode;
}) {
  const body = (
    <>
      <Lead>
        {onFold && (folded
          ? <ChevronRight className="w-3 h-3 text-text-muted" />
          : <ChevronDown className="w-3 h-3 text-text-muted" />)}
      </Lead>
      <span className="flex items-center gap-2 min-w-0">
        <Caption>{label}</Caption>
        {count != null && <span className="font-mono text-[11px] leading-4 text-text-muted">{count}</span>}
        {folded && summary?.map(c => (
          <Fragment key={c.label}>
            <span className="text-[12px] leading-4 text-text-muted">·</span>
            <span className={`text-[12px] leading-4 whitespace-nowrap ${c.tone ? COUNT_INK[c.tone] : 'text-text-muted'}`}>{c.label}</span>
          </Fragment>
        ))}
      </span>
    </>
  );
  return (
    <div className="h-8 shrink-0 flex items-center gap-2 pl-3 pr-[5px] border-b border-border">
      {onFold ? (
        <button
          type="button"
          onClick={onFold}
          aria-expanded={!folded}
          className="flex-1 min-w-0 h-full flex items-center gap-2 text-left cursor-pointer"
        >
          {body}
        </button>
      ) : (
        <span className="flex-1 min-w-0 h-full flex items-center gap-2">{body}</span>
      )}
      {!folded && action}
    </div>
  );
}

/** A 26px square ghost button holding one icon. */
function IconButton({
  label,
  open = false,
  onClick,
  buttonRef,
  children,
}: {
  label: string;
  open?: boolean;
  onClick: () => void;
  buttonRef?: React.Ref<HTMLButtonElement>;
  children: ReactNode;
}) {
  return (
    <button
      ref={buttonRef}
      type="button"
      aria-label={label}
      title={label}
      aria-haspopup="menu"
      aria-expanded={open}
      onClick={onClick}
      className={`w-[26px] h-[26px] shrink-0 flex items-center justify-center border cursor-pointer ${
        open ? 'bg-secondary border-border-accent text-foreground' : 'border-transparent text-text-secondary hover:bg-secondary hover:text-foreground'
      }`}
    >
      {children}
    </button>
  );
}

/** One line of a menu, 32 high, its icon in the same 16px slot as the rows. */
function MenuItem({ icon, label, hint, onSelect }: { icon?: ReactNode; label: string; hint?: string; onSelect: () => void }) {
  return (
    <button
      type="button"
      role="menuitem"
      // The menu moves the focus between its items: Tab leaves the menu.
      tabIndex={-1}
      onClick={onSelect}
      className="w-full h-8 flex items-center gap-2 px-2 text-left hover:bg-secondary focus-visible:bg-secondary focus-visible:outline-none cursor-pointer"
    >
      <Lead>{icon}</Lead>
      <span className="text-[12px] leading-4 font-medium text-foreground">{label}</span>
      <span className="flex-1" />
      {hint && <span className="text-[11px] leading-4 text-text-muted">{hint}</span>}
    </button>
  );
}

function MenuCaption({ children }: { children: ReactNode }) {
  return <div className="h-7 flex items-center px-2"><Caption>{children}</Caption></div>;
}

function MenuRule() {
  return <div className="h-2 flex items-center" aria-hidden><span className="w-full border-t border-border" /></div>;
}

const ROW_MENU_ICON: Partial<Record<RowActionId, ReactNode>> = {
  stop: <Square className="w-3.5 h-3.5 text-text-secondary" />,
  restart: <RotateCcw className="w-3.5 h-3.5 text-text-secondary" />,
  'remove from room': <UserMinus className="w-3.5 h-3.5 text-text-secondary" />,
};

/** The frame's hint beside an item, where the word alone could mislead:
 *  restart is not a stop then a start, which begins a new conversation. */
const ROW_MENU_HINT: Partial<Record<RowActionId, string>> = {
  restart: 'keeps the conversation',
};

/**
 * An agent in the open room. Folded: the mark and name, then what it is on,
 * with its state as a word in its colour, how long it has been in it, and a
 * chip for what waits for it. A click opens it in place with its actions, one
 * row at a time.
 *
 * Memoised on what it shows: the room's agents are joined again on every
 * tick, and a row whose agent did not move has nothing new to draw.
 */
export const TeamRow = memo(function TeamRow({
  agent,
  open,
  onToggle,
  queued,
  held,
  notSent,
  lastSpokeAt,
  joinedAt,
  duration,
  onAction,
}: {
  agent: RoomAgent;
  open: boolean;
  onToggle: (agentId: string) => void;
  queued: number;
  /** Taken by its terminal, waiting on a draft in its field (PR 169). */
  held: number;
  notSent: number;
  lastSpokeAt?: string;
  /** When it joined the room, while it has not spoken since. */
  joinedAt?: string;
  /** How long it has been in its state, `4m`: empty where the frame shows none. */
  duration: string;
  onAction: (action: RowActionId, agent: RoomAgent) => void;
}) {
  const [menuOpen, setMenuOpen] = useState(false);
  const more = useRef<HTMLButtonElement>(null);
  const actions = rowActions(agent, notSent);
  const name = agent.name || agent.id.slice(0, 8);
  // Refused, then waiting on a person, then waiting for a turn: the frame's order.
  const chip = notSent > 0 ? `${notSent} not sent` : held > 0 ? `${held} held` : queued > 0 ? `${queued} queued` : null;
  const act = (id: RowActionId) => { setMenuOpen(false); onAction(id, agent); };

  return (
    // 56 folded and 96 open: pb 7, the bottom border taking the last pixel.
    <div className={`shrink-0 flex flex-col gap-1 px-3 pt-2 pb-[7px] border-b border-border ${open ? 'bg-secondary' : ''}`}>
      <button
        type="button"
        onClick={() => onToggle(agent.id)}
        aria-expanded={open}
        className="w-full flex flex-col gap-1 text-left cursor-pointer"
      >
        <span className="w-full h-4 flex items-center gap-2 min-w-0">
          <AgentMark name={agent.name || agent.id} orchestrator={agent.role === 'orchestrator'} />
          <span className="text-[13px] leading-4 text-foreground truncate">{name}</span>
          <span className="font-mono text-[11px] leading-4 text-text-muted shrink-0">{shortModel(agent)}</span>
          <span className="flex-1" />
          <span className={`text-[12px] leading-4 shrink-0 ${statusInk(agent)}`}>{agentStatusLabel(agent)}</span>
          {/* Counts up while the agent holds its state: marked for the e2e's mask. */}
          {duration && <span data-volatile className="font-mono text-[11px] leading-4 text-text-muted shrink-0">{duration}</span>}
        </span>
        <span className="w-full h-5 flex items-center justify-between gap-2 pl-6 min-w-0">
          <span className="text-[12px] leading-4 text-text-muted truncate">{agentDetail(agent, lastSpokeAt, held, joinedAt)}</span>
          {/* Whole, whatever the detail beside it: the detail is what gives way. */}
          {chip && <MetaChip raised={open} className="shrink-0 whitespace-nowrap">{chip}</MetaChip>}
        </span>
      </button>
      {open && (
        <div className="flex items-center gap-2 pt-2 pb-0.5 pl-6">
          <Button size="sm" onClick={() => act(actions.primary)}>{actions.primary}</Button>
          {actions.secondary && (
            <Button size="sm" variant="ghost" onClick={() => act(actions.secondary!)}>{actions.secondary}</Button>
          )}
          <IconButton label={`More for ${name}`} open={menuOpen} buttonRef={more} onClick={() => setMenuOpen(o => !o)}>
            <Ellipsis className="w-3 h-3" />
          </IconButton>
          <AnchoredMenu anchor={more} open={menuOpen} onClose={() => setMenuOpen(false)} width={220} label={`More for ${name}`}>
            <div className="p-1">
              {actions.menu.map(id => (
                <Fragment key={id}>
                  {id === 'remove from room' && actions.menu.length > 1 && <MenuRule />}
                  <MenuItem icon={ROW_MENU_ICON[id]} label={id} hint={ROW_MENU_HINT[id]} onSelect={() => act(id)} />
                </Fragment>
              ))}
            </div>
          </AnchoredMenu>
        </div>
      )}
    </div>
  );
}, sameProps);

/** The time now, moved on every `everyMs`: what a row's duration counts to. */
function useNow(everyMs: number): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), everyMs);
    return () => clearInterval(id);
  }, [everyMs]);
  return now;
}

/** Folds kept per viewer, as a remembered convenience and nothing more. */
function useFold(key: string): [boolean, () => void] {
  const [folded, setFolded] = useState(false);
  useEffect(() => {
    try { setFolded(window.localStorage.getItem(key) === '1'); } catch { /* storage refused: stay open */ }
  }, [key]);
  const toggle = useCallback(() => {
    setFolded(prev => {
      const next = !prev;
      try { window.localStorage.setItem(key, next ? '1' : '0'); } catch { /* not remembered, still folds */ }
      return next;
    });
  }, [key]);
  return [folded, toggle];
}

export interface TeamSectionProps {
  /** The project, as the caption names it: TEAM · TARS. */
  project: string;
  agents: RoomAgent[];
  /** Per agent, what waits for it, from the bus. */
  pending: Record<string, { queued: number; held: number; notSent: number }>;
  /** Per agent, when it last spoke in this room. */
  lastSpoke: Record<string, string>;
  /** Per agent, when it joined, while it has not spoken since. */
  joined?: Record<string, string>;
  /** Agents of the project that are not in the room: what + can add. */
  candidates: AgentStatus[];
  onAction: (action: RowActionId, agent: RoomAgent) => void;
  onAdd: (agentId: string) => void;
  onNewAgent: () => void;
  /** Opens this row on first render. For the sheets and the tests. */
  initialOpenId?: string;
}

/** The open room's team: its caption, then one row per agent. */
export function TeamSection({
  project,
  agents,
  pending,
  lastSpoke,
  joined,
  candidates,
  onAction,
  onAdd,
  onNewAgent,
  initialOpenId,
}: TeamSectionProps) {
  const [folded, toggleFold] = useFold('tars-chat-team-folded');
  const [openId, setOpenId] = useState<string | null>(initialOpenId ?? null);
  const [adding, setAdding] = useState(false);
  const plus = useRef<HTMLButtonElement>(null);
  // Half a minute: a duration reads in minutes, and is never more than that behind.
  const now = useNow(30_000);
  const toggle = useCallback((id: string) => setOpenId(open => (open === id ? null : id)), []);
  // The page's callback is new on each of its renders; the rows keep one that
  // calls the current one, so a render of the page redraws no row by itself.
  const action = useRef(onAction);
  useLayoutEffect(() => { action.current = onAction; });
  const act = useCallback((id: RowActionId, agent: RoomAgent) => action.current(id, agent), []);

  const running = agents.filter(a => !a.stopped && a.status === 'running').length;
  const waiting = agents.filter(a => !a.stopped && a.status === 'waiting').length;
  const summary: RowCount[] = [
    ...(running ? [{ label: `${running} running` }] : []),
    ...(waiting ? [{ label: `${waiting} waiting`, tone: 'waiting' as const }] : []),
  ];

  return (
    <>
      <SectionHead
        label={`TEAM · ${project.toUpperCase()}`}
        count={agents.length}
        folded={folded}
        onFold={toggleFold}
        summary={summary}
        action={(
          <>
            <IconButton label="Add an agent to this room" open={adding} buttonRef={plus} onClick={() => setAdding(a => !a)}>
              <Plus className="w-3 h-3" />
            </IconButton>
            <AnchoredMenu anchor={plus} open={adding} onClose={() => setAdding(false)} width={280} label="Add to this room">
              <div className="p-1">
                <MenuCaption>ADD TO THIS ROOM</MenuCaption>
                {candidates.map(a => (
                  <MenuItem
                    key={a.id}
                    icon={a.cliRunning === false ? <StatusSquare hollow /> : <StatusSquare tone={a.status === 'running' ? 'running' : a.status === 'waiting' ? 'waiting' : a.status === 'error' ? 'error' : 'idle'} />}
                    label={a.name || a.id.slice(0, 8)}
                    hint={a.cliRunning === false ? 'stopped' : a.status}
                    onSelect={() => { setAdding(false); onAdd(a.id); }}
                  />
                ))}
                {candidates.length > 0 && <MenuRule />}
                <MenuItem
                  icon={<Plus className="w-3.5 h-3.5 text-text-secondary" />}
                  label={`New agent in ${project}`}
                  onSelect={() => { setAdding(false); onNewAgent(); }}
                />
              </div>
            </AnchoredMenu>
          </>
        )}
      />
      {!folded && (agents.length === 0 ? (
        <SidebarNote>No agent in this project yet.</SidebarNote>
      ) : agents.map(agent => (
        <TeamRow
          key={agent.id}
          agent={agent}
          open={openId === agent.id}
          onToggle={toggle}
          queued={pending[agent.id]?.queued ?? 0}
          held={pending[agent.id]?.held ?? 0}
          notSent={pending[agent.id]?.notSent ?? 0}
          lastSpokeAt={lastSpoke[agent.id]}
          joinedAt={joined?.[agent.id]}
          duration={agentDuration(agent, now)}
          onAction={act}
        />
      )))}
    </>
  );
}

/** A line of text in the column, in the text column, with an optional lead. */
export function SidebarNote({ lead, children, detail, actions }: {
  lead?: ReactNode;
  children: ReactNode;
  /** A failure's own words, in mono under the sentence. */
  detail?: string;
  actions?: ReactNode;
}) {
  return (
    <div className="shrink-0 flex gap-2 px-3 pt-2 pb-[7px] border-b border-border">
      <Lead>{lead}</Lead>
      <div className="flex-1 min-w-0 flex flex-col gap-1">
        <p className="text-[12px] leading-4 text-text-muted">{children}</p>
        {detail && <p className="font-mono text-[11px] leading-4 text-text-muted break-words">{detail}</p>}
        {actions && <div className="flex items-center gap-2 pt-0.5">{actions}</div>}
      </div>
    </div>
  );
}

const REACH: Array<[ReactNode, string]> = [
  [<Eye key="eye" className="w-3 h-3 text-text-muted" />, 'reads every agent’s recent output'],
  [<Eye key="eye2" className="w-3 h-3 text-text-muted" />, 'reads git status and branches'],
  [<Pencil key="pencil" className="w-3 h-3 text-text-muted" />, 'writes to one agent, after you confirm'],
];

/** What Hermes can reach, under the rooms while Hermes is open. */
export function ReachSection() {
  return (
    <>
      <SectionHead label="WHAT HERMES CAN REACH" />
      {REACH.map(([icon, text]) => (
        <div key={text} className="h-8 shrink-0 flex items-center gap-2 px-3 border-b border-border">
          <Lead>{icon}</Lead>
          <span className="text-[12px] leading-4 text-text-secondary truncate">{text}</span>
        </div>
      ))}
    </>
  );
}

export interface ConversationItem {
  id: string;
  name: string;
  sub?: string;
  tone: RowTone;
  time?: string;
  counts: RowCount[];
}

/** The whole column. The rooms fold from their caption, like the team. */
export function ChatSidebar({
  hermes,
  rooms,
  selectedId,
  onSelect,
  roomsError,
  onRetryRooms,
  children,
}: {
  hermes: ConversationItem;
  rooms: ConversationItem[];
  selectedId: string;
  onSelect: (id: string) => void;
  /** The bus refused or failed to answer: a list that is not the whole truth
   *  says so, rather than looking like a fleet that has not spoken yet. */
  roomsError?: string | null;
  /** Reads the list again, from the note that says it could not be read. */
  onRetryRooms?: () => void;
  /** Under the rooms: the open room's team, or what Hermes can reach. */
  children?: ReactNode;
}) {
  const [folded, toggleFold] = useFold('tars-chat-rooms-folded');
  return (
    <div data-chat-sidebar className="w-[256px] shrink-0 flex flex-col min-h-0 border border-border bg-card overflow-y-auto">
      <ConversationRow {...hermes} selected={selectedId === hermes.id} onSelect={() => onSelect(hermes.id)} />
      <SectionHead label="ROOMS" count={roomsError ? '?' : rooms.length} folded={folded} onFold={toggleFold} />
      {!folded && (roomsError ? (
        // Frame: `Chat · A · Room · the bus does not answer` > `note bus error`.
        <SidebarNote
          lead={<StatusSquare tone="error" />}
          detail={roomsError}
          actions={onRetryRooms ? <Button size="sm" onClick={onRetryRooms}>retry</Button> : undefined}
        >
          <span className="text-foreground">The bus did not answer, so this list is not the whole truth.</span>
        </SidebarNote>
      ) : rooms.length === 0 ? (
        <SidebarNote>No project yet. A room appears for each project you add an agent to.</SidebarNote>
      ) : rooms.map(room => (
        <ConversationRow key={room.id} {...room} selected={selectedId === room.id} onSelect={() => onSelect(room.id)} />
      )))}
      {children}
    </div>
  );
}
