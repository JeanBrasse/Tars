import { agents } from '../core/agent-manager';
import { broadcastToAllWindows } from '../utils/broadcast';
import { queueBusMessage } from './agent-watch';
import { appendSystemMessage, cancelQueuedDeliveries, getThread, hasEndOfTurn, markDropped, recordDelivery } from './bus-store';
import type { BusDelivery, BusDeliveryReason, BusMessage, BusRoom, BusSystemKind, BusThread } from '../types';

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
      reasonCode: queued ? undefined : reachable ? 'no_live_session' : 'no_end_of_turn',
      reason: queued
        ? undefined
        : reachable
          ? 'no live session to deliver into yet'
          : `${target.provider ?? 'this provider'} stays running until its process exits, so nothing can be delivered to it at rest`,
      queuedAt: new Date().toISOString(),
      refusedAt: queued ? undefined : new Date().toISOString(),
    }));
  }
  return deliveries;
}

/**
 * A machine line, written into the room and pushed like any other message.
 *
 * Here rather than in the handlers because both doors need it and because a
 * system line is a message: the page renders it in the transcript, in place,
 * and would otherwise have to reconstruct it from a thread push.
 */
export function announceSystem(
  roomId: string,
  threadId: string,
  systemKind: BusSystemKind,
  text: string,
): BusMessage {
  const message = appendSystemMessage({ roomId, threadId, systemKind, text });
  broadcastToAllWindows('bus:message', message);
  return message;
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
export function closeAndAnnounce(threadId: string, reasonCode: BusDeliveryReason, reason: string): void {
  for (const dropped of cancelQueuedDeliveries(threadId, reasonCode, reason)) {
    broadcastToAllWindows('bus:delivery', dropped);
  }
  const thread = getThread(threadId);
  if (thread) broadcastToAllWindows('bus:thread', thread);
}

/**
 * The queue could not keep what it was holding.
 *
 * Wired into agent-watch, which drops a recipient's queue when the session it
 * was queued for is gone. The row stops saying `queued` and says why, and the
 * Chat page hears it like any other delivery change.
 */
export function announceDropped(targetAgentId: string, messageId: string, reasonCode: BusDeliveryReason, reason: string): void {
  const dropped = markDropped(targetAgentId, messageId, reasonCode, reason);
  if (dropped) broadcastToAllWindows('bus:delivery', dropped);
}
