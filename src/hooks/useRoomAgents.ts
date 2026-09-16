'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { isElectron } from '@/hooks/useElectron';
import type { AgentStatus, AgentTickItem, BusMember } from '@/types/electron';

/** One empty array for every empty answer. A fresh `[]` per call is a new
 *  dependency per render for anyone who watches the result. */
const NONE: RoomAgent[] = [];

/**
 * A room member with the state the rest of the app already knows about it.
 *
 * `hasEndOfTurn` comes from the room, not from here: the main process derives
 * it from the provider's hook configuration. The renderer used to keep its own
 * list of the CLIs that report nothing, which is a copy of a derived value and
 * goes stale in silence the day a CLI gains hooks. There is no default: an
 * agent the fleet does not know is dropped rather than guessed at.
 */
export interface RoomAgent extends AgentStatus {
  hasEndOfTurn: boolean;
  /**
   * Tars holds no live session for it, so nothing reaches it until it starts.
   *
   * Not `idle`. Claude Code reports idle at the end of every turn and keeps its
   * session, and the room once called a whole team stopped while its agents
   * were answering each other. True only on evidence, see `isStopped`.
   * Frame: `Chat · Room · at rest or stopped`.
   */
  stopped: boolean;
}

type Liveness = AgentTickItem['displayStatus'];

/**
 * Whether an agent has no live session, from what the renderer can know.
 *
 * The tick is computed in the main process against the terminals that are
 * actually alive, so `stopped`, or a state only a live session can be in,
 * settles it. For `done` and `error` it does not look, and a record can keep
 * the id of a pty that has exited, so there the only proof of absence is an id
 * that was cleared: stopping, a restart and a provider change all clear it.
 * Unproven is not stopped.
 */
function isStopped(agent: AgentStatus, liveness: Liveness | undefined): boolean {
  if (liveness === 'stopped') return true;
  if (liveness === 'working' || liveness === 'waiting' || liveness === 'ready') return false;
  return !agent.ptyId;
}

/**
 * The agents a room is made of.
 *
 * Membership is the room's own `members`, in its order, and the agents' state
 * comes from the agent list the rest of the app already reads. The tick the
 * main process broadcasts keeps it current, so the rail never polls on its own
 * timer beside the one Tars already runs.
 */
export function useRoomAgents(members: BusMember[]): RoomAgent[] {
  const [agents, setAgents] = useState<AgentStatus[]>([]);

  const load = useCallback(async () => {
    if (!isElectron() || !window.electronAPI?.agent?.list) return;
    const all = await window.electronAPI.agent.list();
    setAgents(all ?? []);
  }, []);

  useEffect(() => { void load(); }, [load]);

  // `agents:tick` carries the whole fleet on a timer the main process owns;
  // `agent:status` fires on a transition. Reading the list again on a status
  // change keeps one source of truth rather than patching a second copy.
  useEffect(() => {
    if (!isElectron()) return;
    const offStatus = window.electronAPI?.agent?.onStatus?.(() => { void load(); });
    return () => { offStatus?.(); };
  }, [load]);

  // Only one thing is taken from the tick, because only the tick has it: whether
  // the main process still holds a live terminal for each agent. The status
  // stays the list's. Replaced only when an entry changes, since the tick comes
  // twice a second while anything is printing.
  const [liveness, setLiveness] = useState<Record<string, Liveness>>({});
  useEffect(() => {
    if (!isElectron()) return;
    const offTick = window.electronAPI?.agent?.onTick?.(items => {
      setLiveness(prev => {
        const same = items.length === Object.keys(prev).length
          && items.every(t => prev[t.id] === t.displayStatus);
        return same ? prev : Object.fromEntries(items.map(t => [t.id, t.displayStatus]));
      });
    });
    return () => { offTick?.(); };
  }, []);

  // Memoised because the result is a dependency, not just a value: an effect
  // that publishes the room header watches this array, and a new array on every
  // render is a changed dependency on every render. Unmemoised, that effect set
  // state in the parent, the parent re-rendered, and the array was new again:
  // 50 rounds, a React warning, and away it went for as long as the room stayed
  // open, with the screen perfectly still the whole time.
  return useMemo(() => {
    if (!members.length) return NONE;

    // Members first, in the room's own order. A member that no longer exists in
    // the fleet is dropped rather than drawn as a ghost row.
    const byId = new Map(agents.map(a => [a.id, a]));
    const joined = members
      .map(m => {
        const agent = byId.get(m.id);
        return agent
          ? { ...agent, hasEndOfTurn: m.hasEndOfTurn, stopped: isStopped(agent, liveness[m.id]) }
          : null;
      })
      .filter((a): a is RoomAgent => !!a);
    return joined.length ? joined : NONE;
  }, [members, agents, liveness]);
}
