import type {
  AgentStatus,
  BusDelivery,
  BusDeliveryReason,
  BusDeliveryState,
  BusMessage,
  BusRoom,
  BusSystemKind,
  BusThread,
} from '@/types/electron';

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

const nameOf = (agents: Array<Pick<AgentStatus, 'id' | 'name'>>, id: string): string =>
  agents.find(a => a.id === id)?.name ?? id.slice(0, 8);

const list = (names: string[]): string =>
  names.length <= 1
    ? (names[0] ?? '')
    : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;

/** Why a message is not on its way, per target, in the room's words. */
const REFUSED: Record<BusDeliveryReason, (name: string) => string> = {
  no_end_of_turn: name => `waits for you: ${name} never reports the end of a turn`,
  no_live_session: name => `${name} is stopped: no live session to deliver into`,
  session_replaced: name => `for ${name}: its session was replaced before this could be written`,
  thread_stopped: name => `for ${name}: you stopped the exchange, so it was never written`,
  thread_replaced: name => `for ${name}: a newer message replaced the exchange it belonged to`,
  members_changed: name => `for ${name}: the members changed, which closed the exchange it belonged to`,
};

/** The sentence a refused delivery prints. */
export function reasonText(delivery: BusDelivery, name: string): string {
  return delivery.reasonCode ? REFUSED[delivery.reasonCode](name) : '';
}

/**
 * Your own line carries its receipts: who has it, who is still waiting, and
 * who will never get it. Showing only the delivered ones is the omission that
 * made the old Chat look healthy while nothing moved.
 */
export function receipts(deliveries: BusDelivery[], agents: Array<Pick<AgentStatus, 'id' | 'name'>>): string {
  const by = (state: BusDelivery['state']) =>
    deliveries.filter(d => d.state === state).map(d => nameOf(agents, d.targetAgentId));
  const parts: string[] = [];
  const delivered = by('delivered');
  const queued = by('queued');
  const notSent = by('not_sent');
  const dropped = by('dropped');
  if (delivered.length) parts.push(`delivered to ${list(delivered)}`);
  if (queued.length) parts.push(`queued for ${list(queued)}`);
  if (notSent.length) parts.push(`not sent to ${list(notSent)}`);
  if (dropped.length) parts.push(`dropped for ${list(dropped)}`);
  return parts.join(' · ');
}

/** The chip under an agent's line: the delivery state, as the frame labels it. */
const CHIP: Record<BusDeliveryState, string | null> = {
  delivered: null,
  queued: 'queued',
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
 * delivered, which carries no tag at all.
 */
function agentTag(deliveries: BusDelivery[], agents: Array<Pick<AgentStatus, 'id' | 'name'>>): DeliveryTag | undefined {
  const dropped = deliveries.find(d => d.state === 'dropped');
  if (dropped) {
    return { state: 'dropped', label: CHIP.dropped!, note: reasonText(dropped, nameOf(agents, dropped.targetAgentId)) };
  }
  const notSent = deliveries.find(d => d.state === 'not_sent');
  if (notSent) {
    return { state: 'not_sent', label: CHIP.not_sent!, note: reasonText(notSent, nameOf(agents, notSent.targetAgentId)) };
  }
  const queued = deliveries.filter(d => d.state === 'queued');
  if (queued.length) {
    const names = queued.map(d => nameOf(agents, d.targetAgentId));
    return {
      state: 'queued',
      label: CHIP.queued!,
      note: names.length === 1
        ? `delivered when ${names[0]} ends its turn`
        : `delivered when ${list(names)} end their turns`,
    };
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
}

export interface SystemItem {
  kind: 'system';
  id: string;
  time: string;
  systemKind?: BusSystemKind;
  text: string;
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
  agents: Array<Pick<AgentStatus, 'id' | 'name'>>,
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
      items.push({ kind: 'system', id: message.id, time: HHMM(message.createdAt), systemKind: message.systemKind, text: message.text });
      continue;
    }
    const mine = deliveries.filter(d => d.messageId === message.id);
    const to = message.mentions.length ? list(message.mentions.map(id => nameOf(agents, id))) : 'all';
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
    });
  }
  const notice = threadNotice(thread);
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
 */
export function threadNotice(thread: BusThread | null): ThreadNotice | null {
  if (!thread) return null;
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
  const parts = (room.projectPath ?? '').split('/').filter(Boolean);
  return parts[parts.length - 1] || room.title;
}
