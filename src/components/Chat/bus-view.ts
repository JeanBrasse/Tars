import type {
  AgentStatus,
  BusAttachment,
  BusDelivery,
  BusDeliveryReason,
  BusDeliveryState,
  BusMembersChanged,
  BusMessage,
  BusRoom,
  BusSystemKind,
  BusThread,
} from '@/types/electron';
import { pathName } from '@/lib/display-path';

/**
 * What the bus means, in one place. Frames: the thread of every `Chat · A ·
 * Room` page and the sheet `Chat · A · Thread rows · states`, in
 * design/chat-redesign-a.pen.
 *
 * The page renders delivery and thread state, never a guess: every label here
 * comes from a value the contract defines (`BusDeliveryState`,
 * `BusDeliveryReason`, `BusThreadState`, `BusSystemKind`), and every sentence
 * is written here from those values and the agent's name. The main process's
 * own `reason` sentence is not printed: matching or relaying English is how a
 * rewording there once changed what this page said.
 */

const HHMM = (iso: string): string => {
  try {
    return new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false });
  } catch {
    return '';
  }
};

/**
 * What the thread reads of an agent: its name, and what a message queued for
 * it waits on when that is not the end of its turn (#172): a dialog only a
 * person can answer, or a session that is still starting.
 */
export type ThreadAgent = Pick<AgentStatus, 'id' | 'name'> & { waitsOn?: 'dialog' | 'start' };

const nameOf = (agents: ThreadAgent[], id: string): string =>
  agents.find(a => a.id === id)?.name ?? id.slice(0, 8);

const waitsOnOf = (agents: ThreadAgent[], id: string): ThreadAgent['waitsOn'] =>
  agents.find(a => a.id === id)?.waitsOn;

const list = (names: string[]): string =>
  names.length <= 1
    ? (names[0] ?? '')
    : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;

/** A list as a receipt writes it: four names at most, then a count, so one
 *  line of a thirty-agent room still says who is missing. */
const SHOWN = 4;
const some = (names: string[]): string =>
  names.length <= SHOWN
    ? list(names)
    : `${names.slice(0, SHOWN - 1).join(', ')} and ${names.length - (SHOWN - 1)} more`;

/** Why a message is not on its way, per target, in the room's words. */
const REFUSED: Record<BusDeliveryReason, (name: string) => string> = {
  no_end_of_turn: name => `waits for you: ${name} never reports the end of a turn`,
  no_live_session: name => `${name} is stopped: no live session to deliver into`,
  session_replaced: name => `for ${name}: its session was replaced before this could be written`,
  thread_stopped: name => `for ${name}: you stopped the exchange, so it was never written`,
  thread_replaced: name => `for ${name}: a newer message replaced the exchange it belonged to`,
  members_changed: name => `for ${name}: the members changed, which closed the exchange it belonged to`,
  draft: name => `something is typed in ${name}’s field: it goes in once that is sent or cleared`,
};

/** The sentence a refused delivery prints. */
export function reasonText(delivery: BusDelivery, name: string): string {
  return delivery.reasonCode ? REFUSED[delivery.reasonCode](name) : '';
}

/**
 * Your own line carries its receipts: who has it, who is still waiting, and
 * who will never get it. Showing only the delivered ones is the omission that
 * made the old Chat look healthy while nothing moved.
 *
 * What went wrong first, then what waits, then what arrived: in a room of
 * thirty the delivered names ran on and the one not sent was never read.
 * A queue that waits on a dialog or on a start says so, as the frame's
 * `queued for reviewer: delivered once it has started`.
 */
export function receipts(deliveries: BusDelivery[], agents: ThreadAgent[]): string {
  const by = (state: BusDelivery['state'], on?: ThreadAgent['waitsOn']) =>
    deliveries
      .filter(d => d.state === state && (state !== 'queued' || waitsOnOf(agents, d.targetAgentId) === on))
      .map(d => nameOf(agents, d.targetAgentId));
  const parts: string[] = [];
  const dropped = by('dropped');
  const notSent = by('not_sent');
  const held = by('held');
  const queued = by('queued');
  const onDialog = by('queued', 'dialog');
  const onStart = by('queued', 'start');
  const delivered = by('delivered');
  if (dropped.length) parts.push(`dropped for ${some(dropped)}`);
  if (notSent.length) parts.push(`not sent to ${some(notSent)}`);
  if (held.length) parts.push(`held for ${some(held)}`);
  if (queued.length) parts.push(`queued for ${some(queued)}`);
  if (onDialog.length) {
    parts.push(`queued for ${some(onDialog)}: delivered once ${onDialog.length === 1 ? 'its dialog is' : 'their dialogs are'} answered`);
  }
  if (onStart.length) {
    parts.push(`queued for ${some(onStart)}: delivered once ${onStart.length === 1 ? 'it has' : 'they have'} started`);
  }
  if (delivered.length) parts.push(`delivered to ${some(delivered)}`);
  return parts.join(' · ');
}

/** The chip under an agent's line: the delivery state, as the frame labels it. */
const CHIP: Record<BusDeliveryState, string | null> = {
  delivered: null,
  queued: 'queued',
  held: 'held',
  not_sent: 'not sent',
  dropped: 'dropped',
};

export interface DeliveryTag {
  /** What every decision switches on; the chip only prints `label`. */
  state: BusDeliveryState;
  label: string;
  note: string;
}

/**
 * The strongest thing that happened to an agent's message, in the order that
 * matters to a reader: something refused beats something waiting beats
 * delivered, which carries no tag at all. Held waits on a person, so it beats
 * queued, which only waits for a turn to end.
 */
function agentTag(deliveries: BusDelivery[], agents: ThreadAgent[]): DeliveryTag | undefined {
  const dropped = deliveries.find(d => d.state === 'dropped');
  if (dropped) {
    return { state: 'dropped', label: CHIP.dropped!, note: reasonText(dropped, nameOf(agents, dropped.targetAgentId)) };
  }
  const notSent = deliveries.find(d => d.state === 'not_sent');
  if (notSent) {
    return { state: 'not_sent', label: CHIP.not_sent!, note: reasonText(notSent, nameOf(agents, notSent.targetAgentId)) };
  }
  const held = deliveries.find(d => d.state === 'held');
  if (held) {
    return { state: 'held', label: CHIP.held!, note: reasonText(held, nameOf(agents, held.targetAgentId)) };
  }
  const queued = deliveries.filter(d => d.state === 'queued');
  if (queued.length) {
    // What each target's queue waits on: the end of its turn, a dialog only a
    // person answers (the frame's `delivered once qa’s dialog is answered`),
    // or a session still starting.
    const on = (w: ThreadAgent['waitsOn']) =>
      queued.filter(d => waitsOnOf(agents, d.targetAgentId) === w).map(d => nameOf(agents, d.targetAgentId));
    const turn = on(undefined);
    const dialog = on('dialog');
    const start = on('start');
    const notes: string[] = [];
    if (turn.length) {
      notes.push(turn.length === 1 ? `delivered when ${turn[0]} ends its turn` : `delivered when ${list(turn)} end their turns`);
    }
    if (dialog.length) {
      notes.push(dialog.length === 1 ? `delivered once ${dialog[0]}’s dialog is answered` : `delivered once the dialogs of ${list(dialog)} are answered`);
    }
    if (start.length) {
      notes.push(`delivered once ${list(start)} ${start.length === 1 ? 'has' : 'have'} started`);
    }
    return { state: 'queued', label: CHIP.queued!, note: notes.join('; ') };
  }
  return undefined;
}

export interface MessageItem {
  kind: 'message';
  id: string;
  time: string;
  from: string;
  /** Whom it was for: names, or `all`. */
  to: string;
  text: string;
  /** Your own line: a band across the room, carrying its receipts. */
  you: boolean;
  /** Not delivered yet or never will be: the words are dimmed until they land. */
  dim: boolean;
  tag?: DeliveryTag;
  /** Your line's receipts. */
  note?: string;
  /** The files it carried, each where the agents can read it. */
  files?: BusAttachment[];
}

export interface SystemItem {
  kind: 'system';
  id: string;
  time: string;
  systemKind?: BusSystemKind;
  /** Who joined or left, on a change of members: its icon is decided from this. */
  members?: BusMembersChanged;
  text: string;
  /** What the line's own data adds after its sentence, in a lighter ink. */
  more?: string;
}

export interface DayItem {
  kind: 'day';
  id: string;
  label: string;
}

export interface NoticeItem {
  kind: 'notice';
  id: string;
  caption: string;
  lines: string[];
}

export type ThreadItem = MessageItem | SystemItem | DayItem | NoticeItem;

/** 48 KB, 1.2 MB: a file's size as its chip says it. */
export function fileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * What a system line adds after the bus's sentence, from the line's own data
 * and nothing else: the messages a change of members dropped with the
 * exchange it closed. The frame's "It takes part once it has started" is not
 * written: whether an agent had started is a state the line does not carry.
 */
function systemMore(message: BusMessage): string | undefined {
  const dropped = message.systemData?.dropped ?? 0;
  if (message.systemKind !== 'members_changed' || dropped === 0) return undefined;
  return `The exchange closed with it: ${dropped} message${dropped === 1 ? ' was' : 's were'} dropped.`;
}

/**
 * A change of members in the frame's words, from the line's own data: "You
 * added reviewer to the room.", "You removed audit from the room." The bus's
 * sentence says less ("You removed audit."), and a line written before the bus
 * gave its data keeps it.
 */
function systemText(message: BusMessage): string {
  const data = message.systemData;
  if (message.systemKind !== 'members_changed' || !data) return message.text;
  const named = (ids: string[]) => list(ids.map(id => data.names?.[id] ?? id.slice(0, 8)));
  const added = named(data.added);
  const removed = named(data.removed);
  if (added && removed) return `You added ${added} to the room and removed ${removed} from it.`;
  if (added) return `You added ${added} to the room.`;
  if (removed) return `You removed ${removed} from the room.`;
  return message.text;
}

/** `today`, `yesterday`, then the weekday and date: the day lines' words. */
export function dayLabel(iso: string, now: Date = new Date()): string {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return '';
  const day = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const diff = Math.round((day(now) - day(at)) / 86_400_000);
  if (diff === 0) return 'today';
  if (diff === 1) return 'yesterday';
  return at.toLocaleDateString([], { weekday: 'long', day: 'numeric', month: 'long' });
}

/**
 * The thread as rows. A day line goes between two days, and before the first
 * message when the thread spans more than one; a thread of one day has none.
 * The open exchange's notice closes it when it paused or was replaced.
 */
export function threadItems(
  messages: BusMessage[],
  deliveries: BusDelivery[],
  agents: ThreadAgent[],
  thread: BusThread | null,
  now: Date = new Date(),
): ThreadItem[] {
  const items: ThreadItem[] = [];
  const days = new Set(messages.map(m => dayLabel(m.createdAt, now)));
  let lastDay = '';
  for (const message of messages) {
    const label = dayLabel(message.createdAt, now);
    if (days.size > 1 && label !== lastDay) items.push({ kind: 'day', id: `day:${message.id}`, label });
    lastDay = label;

    if (message.authorKind === 'system') {
      items.push({
        kind: 'system',
        id: message.id,
        time: HHMM(message.createdAt),
        systemKind: message.systemKind,
        members: message.systemData,
        text: systemText(message),
        more: systemMore(message),
      });
      continue;
    }
    const mine = deliveries.filter(d => d.messageId === message.id);
    const to = message.mentions.length ? list(message.mentions.map(id => nameOf(agents, id))) : 'all';
    const files = message.attachments?.length ? message.attachments : undefined;
    if (message.authorKind === 'human') {
      items.push({
        kind: 'message',
        id: message.id,
        time: HHMM(message.createdAt),
        from: 'you',
        to,
        text: message.text,
        you: true,
        dim: false,
        // Your line lists who has it and who is waiting: a tag on top would
        // say it twice.
        note: receipts(mine, agents) || undefined,
        files,
      });
      continue;
    }
    const tag = agentTag(mine, agents);
    items.push({
      kind: 'message',
      id: message.id,
      time: HHMM(message.createdAt),
      from: message.authorName,
      to,
      text: message.text,
      you: false,
      dim: !!tag,
      tag,
      files,
    });
  }
  const notice = threadNotice(thread, messages);
  if (notice && messages.length) items.push({ kind: 'notice', id: `notice:${thread!.id}`, ...notice });
  return items;
}

export interface ThreadNotice {
  caption: string;
  lines: string[];
}

/**
 * What the open anchor says about itself. `bounded` is the limit the contract
 * fixes at three rounds or ten agent messages; `stopped` and `superseded` are
 * the two ways an anchor closes without reaching it.
 *
 * A change of members supersedes the exchange in flight too, with no newer
 * message, and writes its line into that exchange (bus:setMembers): an anchor
 * superseded with such a line in it was closed by the members, and says so
 * rather than "replaced by a newer message", which nothing had done.
 */
export function threadNotice(thread: BusThread | null, messages: BusMessage[] = []): ThreadNotice | null {
  if (!thread) return null;
  const byMembers = thread.state === 'superseded'
    && messages.some(m => m.threadId === thread.id && m.systemKind === 'members_changed');
  if (byMembers) {
    return {
      caption: 'closed when the members changed',
      lines: ['What was still queued for it was dropped, and late answers to it are refused. What you write starts a new exchange.'],
    };
  }
  switch (thread.state) {
    case 'bounded':
      return {
        caption: `paused after ${thread.agentMessageCount} agent messages without you`,
        lines: ['Nobody was stopped: every agent finished its turn and is waiting for you. What you write here starts a new exchange.'],
      };
    case 'stopped':
      return {
        caption: 'you stopped this exchange',
        lines: ['Anything still queued for it was cancelled. What you write starts a new one.'],
      };
    case 'superseded':
      return {
        caption: 'replaced by a newer message',
        lines: ['Late answers to the old exchange are refused, and say so.'],
      };
    default:
      return null;
  }
}

/** The live anchor: the last one opened that is still `open`, else the last. */
export function currentThread(threads: BusThread[]): BusThread | null {
  if (!threads.length) return null;
  const sorted = [...threads].sort((a, b) => a.openedAt.localeCompare(b.openedAt));
  return sorted.reverse().find(t => t.state === 'open') ?? sorted[0];
}

export function roomProject(room: BusRoom): string {
  if (room.kind === 'global') return 'every project';
  return pathName(room.projectPath ?? '') || room.title;
}
