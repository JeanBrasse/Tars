import type {
  AgentStatus,
  BusDelivery,
  BusDeliveryReason,
  BusDeliveryState,
  BusMessage,
  BusRoom,
  BusThread,
} from '@/types/electron';

/**
 * What the bus means, in one place.
 *
 * The page renders delivery and thread state, never a guess: every label here
 * comes from a value the contract defines (`BusDeliveryState`,
 * `BusDeliveryReason`, `BusThreadState`).
 *
 * What is drawn is decided by those values and never by English. The sentence
 * printed in a note is the exception and it is deliberate: `reasonText` prefers
 * the main process's own `reason` because that sentence names the agent, so a
 * rewording there does change what is written, while the row it is written on
 * stays what the state says it is. This paragraph used to claim English was
 * never read at all, which the code below then disproved twice.
 */

/** The CLIs that never report the end of a turn, so nothing can be delivered to
 *  them at rest. The backend does not keep a list: it derives the same answer
 *  from `getHookConfig().supportsNativeHooks` (`bus-store.ts`), so that a CLI
 *  which gains hooks stops being an exception the day it gains them.
 *
 *  This copy is on borrowed time. It exists because the renderer contract has
 *  no such field yet, and the day `src/types/electron.d.ts` carries one, delete
 *  the list and read it. Until then the two can drift, and the way that shows
 *  is the rail promising a message waits for you while the bus has queued it. */
const NO_TURN_SIGNAL = new Set(['amp', 'codex', 'grok', 'opencode', 'pi']);

export function reportsTurnEnds(provider: string | undefined): boolean {
  return !NO_TURN_SIGNAL.has(provider ?? 'claude');
}

export type RowKind =
  | 'say'      // an agent wrote to another agent, or to all
  | 'you'      // your own line: the only boxed row
  | 'queued'   // waiting for the target's turn to end
  | 'unsent'   // the target has no end of turn: yours to send
  | 'dropped'  // it will never arrive, and says why
  | 'system';  // the room itself talking

export interface RowTag {
  /** The delivery state this tag stands for. Everything the page decides
   *  switches on this; `label` is only ever printed. */
  state: BusDeliveryState;
  label: string;
  note: string;
}

/** Which row a message becomes, given the strongest thing that happened to it.
 *  A record rather than a chain of comparisons: add a state to the contract and
 *  this stops compiling, which is the point. `delivered` is here for
 *  completeness, since a fully delivered message carries no tag at all. */
const KIND_FOR_STATE: Record<BusDeliveryState, RowKind> = {
  delivered: 'say',
  queued: 'queued',
  not_sent: 'unsent',
  dropped: 'dropped',
};

export interface RoomRowModel {
  id: string;
  kind: RowKind;
  time: string;
  from: string;
  to: string;
  text: string;
  /** Receipts under your own line, or the reason a line is still waiting. */
  tag?: RowTag;
  note?: string;
}

const HHMM = (iso: string): string => {
  try {
    return new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  } catch {
    return '';
  }
};

/** A reason the page can render without reading the sentence the backend
 *  wrote. `reason` is shown when it is there, because it names the agent. */
const REASON_TEXT: Record<BusDeliveryReason, string> = {
  no_end_of_turn: 'this CLI never reports a turn end: yours to send.',
  no_live_session: 'it has no live session, so nothing could be written.',
  session_replaced: 'its session was replaced before this could be written.',
  thread_stopped: 'you stopped the thread, so it was never written.',
  thread_replaced: 'a newer message replaced the thread it belonged to.',
  members_changed: 'the members changed, which closed the thread it belonged to.',
};

export function reasonText(delivery: BusDelivery): string {
  return delivery.reason ?? (delivery.reasonCode ? REASON_TEXT[delivery.reasonCode] : '');
}

const nameOf = (agents: AgentStatus[], id: string): string =>
  agents.find(a => a.id === id)?.name ?? id.slice(0, 8);

const list = (names: string[]): string =>
  names.length <= 1
    ? (names[0] ?? '')
    : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;

/**
 * Your own line carries its receipts: who has it, who is still waiting, and
 * who will never get it. Showing only the delivered ones is the omission that
 * made the old Chat look healthy while nothing moved.
 */
export function receipts(deliveries: BusDelivery[], agents: AgentStatus[]): string {
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

/** The strongest thing that happened to a message, in the order that matters
 *  to a reader: something refused beats something waiting beats delivered. */
function messageTag(deliveries: BusDelivery[], agents: AgentStatus[]): RowTag | undefined {
  const dropped = deliveries.find(d => d.state === 'dropped');
  if (dropped) {
    return {
      state: 'dropped',
      label: 'DROPPED',
      note: `for ${nameOf(agents, dropped.targetAgentId)}. ${reasonText(dropped)}`,
    };
  }
  const notSent = deliveries.find(d => d.state === 'not_sent');
  if (notSent) {
    return { state: 'not_sent', label: 'NOT SENT', note: reasonText(notSent) };
  }
  const queued = deliveries.filter(d => d.state === 'queued');
  if (queued.length) {
    const names = list(queued.map(d => nameOf(agents, d.targetAgentId)));
    return { state: 'queued', label: 'QUEUED', note: `for ${names}. Delivered when that turn ends.` };
  }
  return undefined;
}

export function toRows(
  messages: BusMessage[],
  deliveries: BusDelivery[],
  agents: AgentStatus[],
): RoomRowModel[] {
  return messages.map(message => {
    const mine = deliveries.filter(d => d.messageId === message.id);
    const tag = messageTag(mine, agents);
    const to = message.mentions.length
      ? `→ ${list(message.mentions.map(id => nameOf(agents, id)))}`
      : '→ all';

    if (message.authorKind === 'human') {
      return {
        id: message.id,
        kind: 'you' as const,
        time: HHMM(message.createdAt),
        from: 'you',
        to,
        text: message.text,
        note: receipts(mine, agents) || undefined,
        // Your own line already lists who has it and who is waiting, so a
        // QUEUED tag on top of the receipts would say it twice.
        tag: tag && tag.state !== 'queued' ? tag : undefined,
      };
    }

    if (message.authorKind === 'system') {
      // The room talking about itself. The contract gives no subtype, so it is
      // rendered as one machine line rather than guessed at.
      return {
        id: message.id,
        kind: 'system' as const,
        time: HHMM(message.createdAt),
        from: message.authorName || 'room',
        to: '',
        text: message.text,
      };
    }

    const kind: RowKind = tag ? KIND_FOR_STATE[tag.state] : 'say';

    return {
      id: message.id,
      kind,
      time: HHMM(message.createdAt),
      from: message.authorName,
      to,
      text: message.text,
      tag,
    };
  });
}

export interface QueueSummary {
  queued: number;
  queuedItems: string[];
  notSent: number;
  notSentItems: string[];
}

/** The band above the composer: what is waiting, and what will not move on its
 *  own. A queue that grows has to be visible or the page lies by omission. */
export function summarise(deliveries: BusDelivery[], agents: AgentStatus[]): QueueSummary {
  const count = (state: BusDelivery['state']) => deliveries.filter(d => d.state === state);
  const per = (subset: BusDelivery[]) => {
    const byAgent = new Map<string, number>();
    for (const d of subset) byAgent.set(d.targetAgentId, (byAgent.get(d.targetAgentId) ?? 0) + 1);
    return [...byAgent.entries()].map(([id, n]) => `${n} for ${nameOf(agents, id)}`);
  };
  const queued = count('queued');
  const notSent = count('not_sent');
  return {
    queued: queued.length,
    queuedItems: per(queued),
    notSent: notSent.length,
    notSentItems: per(notSent),
  };
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
        lines: [
          'Nobody was stopped: every agent finished its turn and is waiting for you.',
          'What you write here starts a new exchange.',
        ],
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
