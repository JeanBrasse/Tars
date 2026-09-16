'use client';

import { useCallback, useEffect, useState } from 'react';
import { isElectron } from '@/hooks/useElectron';
import type { AgentStatus, BusRoom } from '@/types/electron';

/**
 * The agents a room is made of.
 *
 * A room's membership is `memberIds` on the room itself, and the agents' own
 * state comes from the agent list the rest of the app already reads. The tick
 * the main process broadcasts keeps it current, so the rail never polls on its
 * own timer beside the one Tars already runs.
 */
export function useRoomAgents(room: BusRoom | null) {
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

  if (!room) return [];

  // Members first, in the room's own order. A member that no longer exists is
  // dropped rather than drawn as a ghost row.
  const byId = new Map(agents.map(a => [a.id, a]));
  const members = room.memberIds.map(id => byId.get(id)).filter((a): a is AgentStatus => !!a);
  if (members.length) return members;

  // A room with no membership recorded yet still has the project's agents:
  // showing them is what makes an empty room readable the first time.
  return room.projectPath ? agents.filter(a => a.projectPath === room.projectPath) : [];
}
