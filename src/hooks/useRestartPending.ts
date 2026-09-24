'use client';

import { useCallback, useSyncExternalStore } from 'react';
import type { AgentPendingRestart } from '@/types/electron';

/**
 * The restart each agent is waiting to make, for the panel that says so.
 *
 * A changed model, effort or permission mode applies at the CLI's next launch,
 * and Tars restarts it on the same conversation once it is free (#120). Until
 * then the agent answers on the old settings, and a wait nothing shows reads as
 * "I changed it and it answered on the old one" (the Audit, 4.4). The main
 * process says what each restart waits on (#138); this is where the panels
 * read it from.
 *
 * The shape of useMessagesWaiting, for the same reasons: one subscription for
 * the window, `pendingRestarts()` read once at the start because the push only
 * reaches a window that was already listening, and an agent an event has spoken
 * for keeps that answer over a read that lands after it.
 */
type Pending = Omit<AgentPendingRestart, 'agentId'>;

const EMPTY: ReadonlyMap<string, Pending> = new Map();

let pending: ReadonlyMap<string, Pending> = EMPTY;
const listeners = new Set<() => void>();

/** Agents an event has already spoken for, so the first read cannot undo it. */
const fromEvent = new Set<string>();
let started = false;

function emit(next: ReadonlyMap<string, Pending>): void {
  pending = next;
  for (const listener of listeners) listener();
}

function onEvent(event: { agentId: string; pending: Pending | null }): void {
  if (!event || typeof event.agentId !== 'string') return;
  fromEvent.add(event.agentId);
  const next = new Map(pending);
  // `null` is how the main process says the restart happened or had nothing
  // left to do, so the entry goes.
  if (event.pending) next.set(event.agentId, event.pending);
  else next.delete(event.agentId);
  emit(next);
}

function start(): void {
  if (started) return;
  started = true;
  const agent = typeof window === 'undefined' ? undefined : window.electronAPI?.agent;
  if (!agent) return;
  agent.onRestartPending?.(onEvent);
  agent.pendingRestarts?.()
    .then(result => {
      if (!result?.success) return;
      const next = new Map(pending);
      for (const { agentId, ...rest } of result.pending) {
        if (!fromEvent.has(agentId)) next.set(agentId, rest);
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

/** The restart this agent waits to make, or undefined when none is pending. */
export function useRestartPending(agentId: string | undefined): Pending | undefined {
  const snapshot = useCallback(
    () => (agentId ? pending.get(agentId) : undefined),
    [agentId],
  );
  return useSyncExternalStore(subscribe, snapshot, onServer);
}

function onServer(): undefined {
  return undefined;
}
