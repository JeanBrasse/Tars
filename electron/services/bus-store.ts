import * as fs from 'fs';
import { v4 as uuidv4 } from 'uuid';
import { BUS_FILE } from '../constants';
import { writeAtomicSync } from '../utils/secret-file';
import { isSuperAgent } from '../utils';
import { agents } from '../core/agent-manager';
import { getProvider } from '../providers';
import type {
  AgentStatus,
  BusDelivery,
  BusMessage,
  BusRoom,
  BusRoomSnapshot,
  BusThread,
} from '../types';

/**
 * The bus journal: rooms, threads, messages and deliveries.
 *
 * One JSON file under ~/.dorothy, written the way agents.json is (temp file
 * then rename, through the shared writeAtomicSync). No new service, no
 * database, no network: a room is a view over the fleet Tars already has, and
 * only the journal and the membership overrides are persisted.
 *
 * Rooms are derived rather than stored. There is one `global` room, whose
 * members are the orchestrators, and one room per project that has agents,
 * whose members are that project's agents. A room keeps its `projectPath`, so
 * its id is `project:<path>` verbatim: Claude Code's directory encoding
 * (slashes and dots to dashes) is lossy and two projects can collide in it,
 * and an id that cannot be read back is not worth the shortening.
 *
 * The global room is today's super chat and stays it: its messages are read
 * from the overseer's own conversation through an injected reader, never
 * copied into this journal. Two stores for one conversation would drift, and
 * the overseer's behaviour does not change in v1.
 *
 * What this file does NOT do is deliver. Recording that a message is `queued`
 * is not writing it into a session: the queue is agent-watch.ts, generalised
 * separately, and a delivery row says exactly what has happened and no more.
 */

const BUS_SCHEMA_VERSION = 1;

/** Bounds per anchor, from the contract: three rounds, ten agent messages. */
export const MAX_ROUNDS = 3;
export const MAX_AGENT_MESSAGES = 10;

/**
 * Silence is first class.
 *
 * An agent with nothing to add says so in one of these, and that is not a
 * message: it is never stored, never shown, never delivered and never counted
 * against the bounds. Recognised at publication so an agent cannot spend a
 * thread's budget saying nothing. The list is Hermes's, which is where the
 * mechanism is from.
 */
export const SILENCE_MARKERS = ['(pass)', '[SILENT]', 'SILENT', 'NO_REPLY', 'NO REPLY'];

export function isSilence(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed) return true;
  return SILENCE_MARKERS.some(marker => trimmed.toUpperCase() === marker.toUpperCase());
}

export const GLOBAL_ROOM_ID = 'global';
export const projectRoomId = (projectPath: string) => `project:${projectPath}`;

type BusFile = {
  version: number;
  savedAt: string;
  /** Members set by hand through bus:setMembers, per room. Absent means the
   *  room follows the fleet: orchestrators for global, the project's agents
   *  for a project room. */
  memberOverrides: Record<string, string[]>;
  threads: BusThread[];
  messages: BusMessage[];
  deliveries: BusDelivery[];
};

let state: BusFile = emptyFile();
let loaded = false;

/**
 * Where the global room's messages come from.
 *
 * Injected rather than imported, so this module stays a leaf: the overseer
 * service imports the fleet and the journal would then import it back, which
 * is a require cycle that types cannot see and that fails at runtime.
 */
type GlobalHistoryReader = () => BusMessage[];
let readGlobalHistory: GlobalHistoryReader | undefined;

export function setGlobalHistoryReader(reader: GlobalHistoryReader | undefined): void {
  readGlobalHistory = reader;
}

function emptyFile(): BusFile {
  return {
    version: BUS_SCHEMA_VERSION,
    savedAt: new Date().toISOString(),
    memberOverrides: {},
    threads: [],
    messages: [],
    deliveries: [],
  };
}

export function loadBus(): void {
  if (loaded) return;
  loaded = true;
  try {
    if (!fs.existsSync(BUS_FILE)) return;
    const parsed = JSON.parse(fs.readFileSync(BUS_FILE, 'utf-8')) as Partial<BusFile>;
    state = {
      ...emptyFile(),
      ...parsed,
      memberOverrides: parsed.memberOverrides ?? {},
      threads: parsed.threads ?? [],
      messages: parsed.messages ?? [],
      deliveries: parsed.deliveries ?? [],
    };
  } catch (err) {
    // A journal that cannot be read is not a reason to refuse to start: the
    // app keeps working and the next write replaces it.
    console.error('[bus] could not read the journal, starting empty:', err);
    state = emptyFile();
  }
}

function saveBus(): void {
  try {
    state.savedAt = new Date().toISOString();
    writeAtomicSync(BUS_FILE, JSON.stringify(state, null, 2));
  } catch (err) {
    console.error('[bus] could not write the journal:', err);
  }
}

/* ── Rooms ─────────────────────────────────────────────────────────────── */

function memberIdsFor(roomId: string, kind: 'global' | 'project', projectPath?: string): string[] {
  const override = state.memberOverrides[roomId];
  if (override) return override.filter(id => agents.has(id));
  const all = Array.from(agents.values());
  if (kind === 'global') return all.filter(isSuperAgent).map(a => a.id);
  return all.filter(a => a.projectPath === projectPath).map(a => a.id);
}

export function listRooms(): BusRoom[] {
  loadBus();
  const createdAt = state.savedAt;
  const rooms: BusRoom[] = [{
    id: GLOBAL_ROOM_ID,
    kind: 'global',
    title: 'All projects',
    memberIds: memberIdsFor(GLOBAL_ROOM_ID, 'global'),
    createdAt,
  }];

  const projectPaths = Array.from(new Set(
    Array.from(agents.values()).map(a => a.projectPath).filter((p): p is string => !!p),
  )).sort();

  for (const projectPath of projectPaths) {
    const id = projectRoomId(projectPath);
    rooms.push({
      id,
      kind: 'project',
      projectPath,
      title: projectPath.split('/').filter(Boolean).pop() || projectPath,
      memberIds: memberIdsFor(id, 'project', projectPath),
      createdAt,
    });
  }
  return rooms;
}

export function getRoom(roomId: string): BusRoom | undefined {
  return listRooms().find(r => r.id === roomId);
}

export function getRoomSnapshot(roomId: string, opts?: { limit?: number; before?: string }): BusRoomSnapshot | undefined {
  const room = getRoom(roomId);
  if (!room) return undefined;

  // The global room is the super chat, read from where it already lives.
  if (room.kind === 'global') {
    const history = readGlobalHistory ? readGlobalHistory() : [];
    const limit = Math.max(1, Math.min(opts?.limit ?? 200, 1000));
    return { room, threads: [], messages: history.slice(-limit), deliveries: [] };
  }

  let messages = state.messages.filter(m => m.roomId === roomId);
  if (opts?.before) {
    const cut = state.messages.find(m => m.id === opts.before)?.createdAt;
    if (cut) messages = messages.filter(m => m.createdAt < cut);
  }
  // Newest last, which is the order the Chat page renders in; the window is
  // taken from the end so a limit gives the most recent conversation.
  const limit = Math.max(1, Math.min(opts?.limit ?? 200, 1000));
  messages = messages.slice(-limit);

  const messageIds = new Set(messages.map(m => m.id));
  const threadIds = new Set(messages.map(m => m.threadId));
  return {
    room,
    threads: state.threads.filter(t => threadIds.has(t.id)),
    messages,
    deliveries: state.deliveries.filter(d => messageIds.has(d.messageId)),
  };
}

/* ── Threads and messages ──────────────────────────────────────────────── */

export function openThread(roomId: string, anchorMessageId: string): BusThread {
  const thread: BusThread = {
    id: uuidv4(),
    roomId,
    anchorMessageId,
    state: 'open',
    round: 1,
    agentMessageCount: 0,
    openedAt: new Date().toISOString(),
  };
  state.threads.push(thread);
  return thread;
}

export function openThreadOf(roomId: string): BusThread | undefined {
  return [...state.threads].reverse().find(t => t.roomId === roomId && t.state === 'open');
}

export function getThread(threadId: string): BusThread | undefined {
  return state.threads.find(t => t.id === threadId);
}

export function messagesOfThread(threadId: string): BusMessage[] {
  return state.messages.filter(m => m.threadId === threadId);
}

export function closeThread(threadId: string, next: BusThread['state']): BusThread | undefined {
  const thread = getThread(threadId);
  if (!thread || thread.state !== 'open') return thread;
  thread.state = next;
  saveBus();
  return thread;
}

/**
 * Who has already spoken in the round now in progress.
 *
 * Derived from the journal rather than stored on the thread: the contract
 * fixes what a thread carries, and a round is a reading of the messages, not
 * another field to keep in step with them. A round ends when an agent that has
 * already spoken in it speaks again, which is the rotation: everyone gets one
 * turn before anyone gets a second.
 */
function currentRound(threadId: string): { round: number; heard: Set<string> } {
  let round = 1;
  let heard = new Set<string>();
  for (const message of messagesOfThread(threadId)) {
    if (message.authorKind !== 'agent') continue;
    if (heard.has(message.authorId)) {
      round += 1;
      heard = new Set<string>();
    }
    heard.add(message.authorId);
  }
  return { round, heard };
}

/**
 * Add a human message to a room.
 *
 * A human message closes the anchor in flight and opens a new one, which is
 * the contract's rule: the turn already running finishes, and the discussion
 * starts again at round one from what Noah just said. Nothing here cancels a
 * turn.
 */
export function appendMessage(input: {
  roomId: string;
  authorKind: BusMessage['authorKind'];
  authorId: string;
  authorName: string;
  text: string;
  mentions?: string[];
}): { message: BusMessage; thread: BusThread; supersededThreadId?: string } {
  loadBus();
  const now = new Date().toISOString();
  const messageId = uuidv4();

  let supersededThreadId: string | undefined;
  let thread = openThreadOf(input.roomId);
  if (input.authorKind === 'human') {
    if (thread) {
      thread.state = 'superseded';
      supersededThreadId = thread.id;
    }
    thread = openThread(input.roomId, messageId);
  } else if (!thread) {
    thread = openThread(input.roomId, messageId);
  }

  const message: BusMessage = {
    id: messageId,
    roomId: input.roomId,
    threadId: thread.id,
    authorKind: input.authorKind,
    authorId: input.authorId,
    authorName: input.authorName,
    text: input.text,
    mentions: input.mentions ?? [],
    createdAt: now,
  };
  state.messages.push(message);

  if (input.authorKind === 'agent') {
    thread.agentMessageCount += 1;
    const { round } = currentRound(thread.id);
    thread.round = round;
    if (thread.agentMessageCount >= MAX_AGENT_MESSAGES || round > MAX_ROUNDS) {
      thread.state = 'bounded';
    }
  }

  saveBus();
  return { message, thread, supersededThreadId };
}

export type PublishRefusal =
  | 'silence'
  | 'no_open_thread'
  | 'thread_stopped'
  | 'thread_bounded'
  | 'thread_superseded'
  | 'not_a_member'
  | 'self_reply'
  | 'not_your_turn';

/**
 * An agent publishes into a room, with every bound applied here.
 *
 * Server side on purpose: an agent that writes faster must not be able to get
 * around the bounds, so the tool is a caller of this and never a second
 * implementation of it. Refusals are returned with a reason rather than
 * swallowed, because a message that quietly never appears is the silent
 * failure this app has already had once.
 */
export function publishAgentMessage(input: {
  roomId: string;
  agentId: string;
  text: string;
  mentions?: string[];
}): { published: true; message: BusMessage; thread: BusThread } | { published: false; reason: PublishRefusal; detail: string } {
  loadBus();

  if (isSilence(input.text)) {
    return { published: false, reason: 'silence', detail: 'Nothing to add: not published, and not counted against the thread.' };
  }

  const room = getRoom(input.roomId);
  if (!room) return { published: false, reason: 'no_open_thread', detail: 'That room does not exist.' };
  if (!room.memberIds.includes(input.agentId)) {
    return { published: false, reason: 'not_a_member', detail: 'Only the agents of this room can post in it.' };
  }

  const thread = openThreadOf(input.roomId);
  if (!thread) {
    return {
      published: false,
      reason: 'no_open_thread',
      detail: 'No thread is open here. A thread opens on a human message, not on an agent one.',
    };
  }
  if (thread.state === 'stopped') return { published: false, reason: 'thread_stopped', detail: 'This thread was stopped.' };
  if (thread.state === 'bounded') {
    return { published: false, reason: 'thread_bounded', detail: 'This thread reached its bounds. Only a human message reopens it.' };
  }
  if (thread.state === 'superseded') {
    return { published: false, reason: 'thread_superseded', detail: 'A newer message replaced this thread.' };
  }

  const priors = messagesOfThread(thread.id);
  const last = priors[priors.length - 1];
  if (last && last.authorKind === 'agent' && last.authorId === input.agentId) {
    return { published: false, reason: 'self_reply', detail: 'No replying to your own message.' };
  }

  const { round, heard } = currentRound(thread.id);
  if (round > 1 || heard.size > 0) {
    // After the first voice, a turn is earned by being named: only an agent
    // another has mentioned, and that has not spoken in this round, speaks.
    const mentionedByAnother = priors.some(m => m.authorId !== input.agentId && m.mentions.includes(input.agentId));
    if (!mentionedByAnother) {
      return { published: false, reason: 'not_your_turn', detail: 'After the first round, only an agent another one mentioned speaks.' };
    }
    if (heard.has(input.agentId)) {
      return { published: false, reason: 'not_your_turn', detail: 'You have already spoken in this round.' };
    }
  }

  const agent = agents.get(input.agentId);
  const { message, thread: updated } = appendMessage({
    roomId: input.roomId,
    authorKind: 'agent',
    authorId: input.agentId,
    authorName: agent?.name || input.agentId,
    text: input.text,
    mentions: input.mentions,
  });
  return { published: true, message, thread: updated };
}

/* ── Deliveries ────────────────────────────────────────────────────────── */

/**
 * Providers whose interactive session never leaves `running`.
 *
 * amp, codex, grok, opencode and pi have no native hooks, so their status only
 * changes when the process exits: a queue that waits for them to be at rest
 * would never drain. Read from the provider's own hook configuration rather
 * than a list written out here, so a provider that gains hooks stops being an
 * exception on the day it gains them, not on the day someone remembers.
 */
export function hasEndOfTurn(agent: AgentStatus): boolean {
  try {
    return getProvider(agent.provider).getHookConfig().supportsNativeHooks;
  } catch {
    return false;
  }
}

export function recordDelivery(delivery: BusDelivery): BusDelivery {
  state.deliveries.push(delivery);
  saveBus();
  return delivery;
}

export function deliveriesOf(messageId: string): BusDelivery[] {
  return state.deliveries.filter(d => d.messageId === messageId);
}

/** Mark every delivery still queued for a thread as dropped, with its reason:
 *  what Stop means for messages that had not gone out yet. */
export function cancelQueuedDeliveries(threadId: string, reason: string): BusDelivery[] {
  const ids = new Set(messagesOfThread(threadId).map(m => m.id));
  const cancelled: BusDelivery[] = [];
  for (const delivery of state.deliveries) {
    if (delivery.state !== 'queued' || !ids.has(delivery.messageId)) continue;
    delivery.state = 'dropped';
    delivery.reason = reason;
    cancelled.push(delivery);
  }
  if (cancelled.length) saveBus();
  return cancelled;
}

export function setMembers(
  roomId: string,
  memberIds: string[],
): { room: BusRoom; superseded?: BusThread } | undefined {
  loadBus();
  const room = getRoom(roomId);
  if (!room) return undefined;
  state.memberOverrides[roomId] = Array.from(new Set(memberIds));
  // Changing who is in the room closes the anchor in flight rather than
  // editing a live thread: that is what keeps the journal replayable. The
  // closed thread is handed back so the caller can push it, because a member
  // change that silently ended a thread would be exactly the invisible state
  // the contract asks the interface to show.
  const open = openThreadOf(roomId);
  if (open) open.state = 'superseded';
  saveBus();
  const updated = getRoom(roomId);
  return updated ? { room: updated, superseded: open } : undefined;
}

/** Test seam: the journal is process state, and a test that drives several
 *  fleets through one module needs it empty between runs. */
export function resetBusStore(): void {
  state = emptyFile();
  loaded = false;
  readGlobalHistory = undefined;
}
