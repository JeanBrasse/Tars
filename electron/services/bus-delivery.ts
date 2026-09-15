import { agents } from '../core/agent-manager';
import { broadcastToAllWindows } from '../utils/broadcast';
import { queueBusMessage } from './agent-watch';
import { cancelQueuedDeliveries, getThread, hasEndOfTurn, recordDelivery } from './bus-store';
import type { BusDelivery, BusMessage, BusRoom, BusThread } from '../types';

/**
 * What happens to a message once it has been published.
 *
 * One implementation, called by both doors: the Chat page over IPC and an
 * agent's room_post over the API. Fanning out deliveries in each of them
 * separately is how the two would end up disagreeing about who got what, and
 * a delivery row is the only thing the interface may show as proof.
 */

/** Who a message is for: the agents it names, or every member of the room when
 *  it names nobody. Never its own author. */
export function targetsOf(message: BusMessage, room: BusRoom): string[] {
  const named = message.mentions.length > 0 ? message.mentions : room.memberIds;
  return named.filter(id => id !== message.authorId);
}

/**
 * Queue a published message for each of its targets, and record what happened.
 *
 * A target that can be reached goes into the one queue Tars has, and is marked
 * delivered only when it actually reaches a terminal. A target that cannot is
 * recorded `not_sent` with its reason and waits for a human: amp, codex, grok,
 * opencode and pi never leave `running` in an interactive session, so a queue
 * for them would never drain. Nothing here reads silence as an end of turn.
 */
export function fanOutDeliveries(message: BusMessage, room: BusRoom): BusDelivery[] {
  const deliveries: BusDelivery[] = [];
  for (const targetAgentId of targetsOf(message, room)) {
    const target = agents.get(targetAgentId);
    if (!target) continue;
    const reachable = hasEndOfTurn(target);
    const queued = reachable && queueBusMessage(targetAgentId, {
      messageId: message.id,
      roomId: message.roomId,
      threadId: message.threadId,
      authorName: message.authorName,
      text: message.text,
    });
    deliveries.push(recordDelivery({
      messageId: message.id,
      targetAgentId,
      state: queued ? 'queued' : 'not_sent',
      reason: queued
        ? undefined
        : reachable
          ? 'no live session to deliver into yet'
          : `${target.provider ?? 'this provider'} stays running until its process exits, so nothing can be delivered to it at rest`,
      queuedAt: new Date().toISOString(),
    }));
  }
  return deliveries;
}

/** Push a message, its thread, and its deliveries to every window. */
export function broadcastPublication(message: BusMessage, thread: BusThread, deliveries: BusDelivery[]): void {
  broadcastToAllWindows('bus:message', message);
  broadcastToAllWindows('bus:thread', thread);
  for (const delivery of deliveries) broadcastToAllWindows('bus:delivery', delivery);
}

/**
 * An anchor closed: drop what had not gone out, and say so.
 *
 * Stop, a newer human message and a change of members all end a thread, and a
 * reply nobody is waiting for any more is not worth waking an agent for.
 */
export function closeAndAnnounce(threadId: string, reason: string): void {
  for (const dropped of cancelQueuedDeliveries(threadId, reason)) {
    broadcastToAllWindows('bus:delivery', dropped);
  }
  const thread = getThread(threadId);
  if (thread) broadcastToAllWindows('bus:thread', thread);
}
