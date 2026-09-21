'use client';

import { useCallback, useSyncExternalStore } from 'react';
import type { AgentMessageWaiting } from '@/types/electron';

/**
 * What is waiting for each agent's input field, for the panel that draws it.
 *
 * Since 1.7.8 a message meant for an agent waits instead of being typed across
 * a half-written prompt, and if Tars cannot promise to put that draft back as
 * it was it writes nothing at all. Only the person at that keyboard can end
 * such a wait, by sending what they are typing or clearing the field, so a
 * wait that nothing shows is worse than either outcome. This is where the
 * panels read it from.
 *
 * One subscription for the whole window rather than one per panel: a board can
 * hold twenty terminals, the main process pushes the same event to all of
 * them, and `messagesWaiting()` is a round trip that should happen once. Each
 * panel then reads its own agent out of the map, so a message waiting for one
 * terminal re-renders that panel and no other.
 */
const EMPTY: ReadonlyMap<string, AgentMessageWaiting> = new Map();

let waiting: ReadonlyMap<string, AgentMessageWaiting> = EMPTY;
const listeners = new Set<() => void>();

/** Agents an event has already spoken for, so the first read cannot undo it. */
const fromEvent = new Set<string>();
let started = false;

function emit(next: ReadonlyMap<string, AgentMessageWaiting>): void {
  waiting = next;
  for (const listener of listeners) listener();
}

function onEvent(item: AgentMessageWaiting): void {
  if (!item || typeof item.agentId !== 'string') return;
  fromEvent.add(item.agentId);
  const next = new Map(waiting);
  // `waiting: 0` is how the main process says the wait is over, so the entry
  // goes rather than sitting there at zero.
  if (item.waiting > 0) next.set(item.agentId, item);
  else next.delete(item.agentId);
  emit(next);
}

/**
 * Start listening, and read what is already waiting.
 *
 * Both, and in that order: the event is pushed only to a window that was
 * already listening, so a Dashboard opened after a message started waiting
 * would otherwise know nothing about it. The read can land after an event that
 * overtook it, which is what `fromEvent` is for: an agent an event has already
 * spoken for keeps the newer answer.
 *
 * Never torn down. It is one listener and one small map for the life of the
 * window, and dropping it when the last panel unmounts would mean the next
 * panel drawing nothing until a fresh read came back.
 */
function start(): void {
  if (started) return;
  started = true;
  const agent = typeof window === 'undefined' ? undefined : window.electronAPI?.agent;
  if (!agent) return;
  agent.onMessageWaiting?.(onEvent);
  agent.messagesWaiting?.()
    .then(result => {
      if (!result?.success) return;
      const next = new Map(waiting);
      for (const item of result.waiting) {
        if (fromEvent.has(item.agentId)) continue;
        if (item.waiting > 0) next.set(item.agentId, item);
        else next.delete(item.agentId);
      }
      emit(next);
    })
    .catch(() => {});
}

function subscribe(listener: () => void): () => void {
  start();
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

/**
 * What is waiting for this agent's field, or undefined when nothing is.
 *
 * `useSyncExternalStore` rather than state in an effect: the value the server
 * cannot know is served by the third argument during the pre-render and the
 * hydration pass, so the two agree and the tree is not thrown away. The
 * snapshot is the map's own entry, so it keeps its identity between renders
 * and the store does not loop.
 */
export function useMessageWaiting(agentId: string | undefined): AgentMessageWaiting | undefined {
  const snapshot = useCallback(
    () => (agentId ? waiting.get(agentId) : undefined),
    [agentId],
  );
  return useSyncExternalStore(subscribe, snapshot, onServer);
}

function onServer(): undefined {
  return undefined;
}
