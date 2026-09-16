import { agents } from '../core/agent-manager';
import { broadcastToAllWindows } from '../utils/broadcast';
import { deliverBusMessages, queueBusMessage, releaseBusMessagesNow, type QueuedBusMessage } from './agent-watch';
import {
  appendSystemMessage,
  cancelQueuedDeliveries,
  getMessage,
  getThread,
  hasEndOfTurn,
  markDelivered,
  markDropped,
  notSentFor,
  recordDelivery,
} from './bus-store';
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
      authorKind: message.authorKind,
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
    // Only now, with the row in the journal. Handing the message over is what
    // marks the row delivered, so an agent at rest, which takes it at once,
    // has to have a row to mark.
    if (queued) deliverBusMessages(targetAgentId);
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
 * Send what was never sent, because a human said to.
 *
 * `not_sent` is the state with no way out on its own: the target has no end of
 * turn, so nothing will ever be a safe moment and the queue refuses to guess
 * one. That refusal does not move. What moves is that a person can now decide,
 * and this is what their decision does: the held messages go in, oldest first,
 * into a session whose state Tars does not know. Specifying a state the
 * interface can show but never resolve is the silent failure this bus exists
 * to remove, so it gets a door.
 */
export async function releaseNotSent(agentId: string): Promise<{ released: BusDelivery[]; reason?: string }> {
  const held = notSentFor(agentId);
  if (!held.length) return { released: [] };

  const queued: QueuedBusMessage[] = [];
  for (const delivery of held) {
    const message = getMessage(delivery.messageId);
    if (!message) continue;
    queued.push({
      messageId: message.id,
      roomId: message.roomId,
      threadId: message.threadId,
      authorKind: message.authorKind,
      authorName: message.authorName,
      text: message.text,
    });
  }
  if (!queued.length) return { released: [] };

  // Each one is recorded the moment it is written rather than all of them at
  // the end. The held list was read before the first write, and the writes take
  // hundreds of milliseconds each: anything that reads the journal in between
  // should see what has already gone out, not the state this call started from.
  const released: BusDelivery[] = [];
  const { written, refused } = await releaseBusMessagesNow(agentId, queued, messageId => {
    const delivery = markDelivered(agentId, messageId);
    if (!delivery) return;
    released.push(delivery);
    broadcastToAllWindows('bus:delivery', delivery);
  });

  if (refused === 'already_releasing') {
    return { released: [], reason: 'These messages are already being sent. Wait for that to finish.' };
  }
  if (refused === 'no_terminal' || !written.length) {
    return { released: [], reason: 'That agent has no live terminal to write into.' };
  }

  // Said in the room, on the anchor the last one belongs to: a human action
  // that writes into a terminal should leave a trace where the conversation is.
  const last = queued.find(q => q.messageId === written[written.length - 1]);
  if (last) {
    const name = agents.get(agentId)?.name || agentId;
    announceSystem(last.roomId, last.threadId, 'queue_released',
      `You sent ${written.length} held message${written.length > 1 ? 's' : ''} to ${name}.`);
  }
  return { released };
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
 * A queued message reached a terminal.
 *
 * Wired into agent-watch, which calls it the moment it writes the message. The
 * only thing that turns a delivery `delivered`, and the Chat page hears it at
 * once rather than inferring it from silence.
 */
export function announceDelivered(targetAgentId: string, messageId: string): void {
  const delivered = markDelivered(targetAgentId, messageId);
  if (delivered) broadcastToAllWindows('bus:delivery', delivered);
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
