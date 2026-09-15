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
 * What this file does NOT do, on purpose, is deliver anything. Recording that a
 * message is `queued` is not the same as writing it into a session: the queue
 * is agent-watch.ts, generalised in a later commit, and until then a delivery
 * row says exactly what has happened and nothing more.
 */

const BUS_SCHEMA_VERSION = 1;

/** Bounds per anchor, from the contract: three rounds, ten agent messages. */
export const MAX_ROUNDS = 3;
export const MAX_AGENT_MESSAGES = 10;

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
    round: 0,
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

export function closeThread(threadId: string, next: BusThread['state']): BusThread | undefined {
  const thread = getThread(threadId);
  if (!thread || thread.state !== 'open') return thread;
  thread.state = next;
  saveBus();
  return thread;
}

/**
 * Add a message to a room.
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
    if (thread.agentMessageCount >= MAX_AGENT_MESSAGES || thread.round >= MAX_ROUNDS) {
      thread.state = 'bounded';
    }
  }

  saveBus();
  return { message, thread, supersededThreadId };
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
}
