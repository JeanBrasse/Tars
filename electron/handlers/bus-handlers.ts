import { ipcMain } from 'electron';
import { agents } from '../core/agent-manager';
import { broadcastToAllWindows } from '../utils/broadcast';
import { getOverseerHistory } from '../services/overseer';
import {
  appendMessage,
  cancelQueuedDeliveries,
  closeThread,
  getRoomSnapshot,
  getThread,
  hasEndOfTurn,
  listRooms,
  loadBus,
  recordDelivery,
  setGlobalHistoryReader,
  setMembers,
  GLOBAL_ROOM_ID,
} from '../services/bus-store';
import type { BusDelivery, BusMessage } from '../types';

/**
 * The bus over IPC: five calls and three pushes, exactly the contract.
 *
 * The renderer never polls: a message, a delivery or a thread change is pushed
 * on the channel of that name, the same way every other live update in the app
 * reaches the window. Nothing else is pushed, and there is no sixth call: a
 * room's deliveries come back with its snapshot.
 *
 * A delivery row is the only thing the interface may show as proof a message
 * went somewhere, so this is careful about what it writes into one. Nothing is
 * written into a session here: a target that can be reached is recorded
 * `queued` for the queue to drain, and one that cannot is recorded `not_sent`
 * with its reason, which is what the Chat page renders as NOT SENT. Nothing is
 * ever inferred from silence.
 */
export function registerBusHandlers(): void {
  loadBus();

  // The global room is the super chat, and stays where it already lives: read
  // from the overseer's own conversation, never copied into the bus journal.
  // Injected here rather than imported by the store, which would close a
  // require cycle the types cannot see.
  setGlobalHistoryReader(() => getOverseerHistory().map((m): BusMessage => ({
    id: m.id,
    roomId: GLOBAL_ROOM_ID,
    threadId: GLOBAL_ROOM_ID,
    authorKind: m.role === 'user' ? 'human' : 'agent',
    authorId: m.role === 'user' ? 'human' : 'overseer',
    authorName: m.role === 'user' ? 'Noah' : 'Overseer',
    text: m.text,
    mentions: [],
    createdAt: m.timestamp,
  })));

  ipcMain.handle('bus:listRooms', async () => {
    try {
      return { rooms: listRooms() };
    } catch (err) {
      console.error('[bus] listRooms failed:', err);
      return { rooms: [], error: err instanceof Error ? err.message : 'Failed to list rooms' };
    }
  });

  ipcMain.handle('bus:getRoom', async (_event, roomId: string, params?: { limit?: number; before?: string }) => {
    try {
      const snapshot = getRoomSnapshot(roomId, params);
      if (!snapshot) return { success: false, error: 'Room not found' };
      return { success: true, ...snapshot };
    } catch (err) {
      console.error('[bus] getRoom failed:', err);
      return { success: false, error: err instanceof Error ? err.message : 'Failed to read room' };
    }
  });

  ipcMain.handle('bus:postMessage', async (_event, params: { roomId: string; text: string; mentions?: string[] }) => {
    try {
      const text = (params?.text ?? '').trim();
      if (!text) return { success: false, error: 'A message needs text' };

      const room = listRooms().find(r => r.id === params.roomId);
      if (!room) return { success: false, error: 'Room not found' };
      if (room.kind === 'global') {
        // The super chat has its own send, with its own model and its own
        // rules. Posting there through the bus would be a second way in.
        return { success: false, error: 'The global room is the super chat: send through overseer:send.' };
      }

      const { message, thread, supersededThreadId } = appendMessage({
        roomId: params.roomId,
        authorKind: 'human',
        authorId: 'human',
        authorName: 'Noah',
        text,
        mentions: params.mentions,
      });

      // Who this message is for: the agents named in it, or every member of
      // the room when it names nobody.
      const targets = (message.mentions.length > 0 ? message.mentions : room.memberIds)
        .filter(id => id !== message.authorId);

      const deliveries: BusDelivery[] = [];
      for (const targetAgentId of targets) {
        const target = agents.get(targetAgentId);
        if (!target) continue;
        const reachable = hasEndOfTurn(target);
        deliveries.push(recordDelivery({
          messageId: message.id,
          targetAgentId,
          // Kept and shown rather than dropped: a provider with no end of turn
          // cannot be written to at rest, so this waits for a human action
          // instead of sitting in a queue that would never drain.
          state: reachable ? 'queued' : 'not_sent',
          reason: reachable
            ? undefined
            : `${target.provider ?? 'this provider'} stays running until its process exits, so nothing can be delivered to it at rest`,
          queuedAt: new Date().toISOString(),
        }));
      }

      broadcastToAllWindows('bus:message', message);
      broadcastToAllWindows('bus:thread', thread);
      if (supersededThreadId) {
        const superseded = getThread(supersededThreadId);
        if (superseded) {
          // The anchor this replaced takes its queued deliveries with it: a
          // reply to a thread nobody is in any more is not worth waking an
          // agent for.
          for (const dropped of cancelQueuedDeliveries(superseded.id, 'a newer message replaced this thread')) {
            broadcastToAllWindows('bus:delivery', dropped);
          }
          broadcastToAllWindows('bus:thread', superseded);
        }
      }
      for (const delivery of deliveries) broadcastToAllWindows('bus:delivery', delivery);

      return { success: true, messageId: message.id, threadId: thread.id, deliveries };
    } catch (err) {
      console.error('[bus] postMessage failed:', err);
      return { success: false, error: err instanceof Error ? err.message : 'Failed to post' };
    }
  });

  ipcMain.handle('bus:stopThread', async (_event, threadId: string) => {
    try {
      const thread = closeThread(threadId, 'stopped');
      if (!thread) return { success: false, error: 'Thread not found' };
      // Stop is a barrier: what had not gone out does not go out.
      for (const dropped of cancelQueuedDeliveries(thread.id, 'the thread was stopped')) {
        broadcastToAllWindows('bus:delivery', dropped);
      }
      broadcastToAllWindows('bus:thread', thread);
      return { success: true, thread };
    } catch (err) {
      console.error('[bus] stopThread failed:', err);
      return { success: false, error: err instanceof Error ? err.message : 'Failed to stop thread' };
    }
  });

  ipcMain.handle('bus:setMembers', async (_event, roomId: string, memberIds: string[]) => {
    try {
      const result = setMembers(roomId, Array.isArray(memberIds) ? memberIds : []);
      if (!result) return { success: false, error: 'Room not found' };
      // Changing the members closes the anchor in flight, and that close is a
      // thread change like any other: it goes out on bus:thread so the Chat
      // page never has to infer it from a room that looks different.
      if (result.superseded) {
        for (const dropped of cancelQueuedDeliveries(result.superseded.id, 'the room members changed')) {
          broadcastToAllWindows('bus:delivery', dropped);
        }
        broadcastToAllWindows('bus:thread', result.superseded);
      }
      return { success: true, room: result.room };
    } catch (err) {
      console.error('[bus] setMembers failed:', err);
      return { success: false, error: err instanceof Error ? err.message : 'Failed to set members' };
    }
  });
}
