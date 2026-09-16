'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { isElectron } from '@/hooks/useElectron';
import type { AgentStatus, BusMember } from '@/types/electron';

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
        return agent ? { ...agent, hasEndOfTurn: m.hasEndOfTurn } : null;
      })
      .filter((a): a is RoomAgent => !!a);
    return joined.length ? joined : NONE;
  }, [members, agents]);
}
