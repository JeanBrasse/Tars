import { useMemo } from 'react';
import type { AgentStatus } from '@/types/electron';

/**
 * The first orchestrator of the fleet, or null.
 *
 * The role is the Orchestrator toggle, never the name, and a project has one,
 * so "the" super agent of the whole fleet is a choice only a caller can make.
 * The one caller left passes it to NewChatModal as `existingSuperAgent`, which
 * that dialog accepts and no longer reads.
 *
 * It used to hand out a click handler that checked the orchestrator's MCP
 * status and ran `orchestrator.setup()`, a shell command, before opening the
 * create dialog. Nothing called it, and the main process writes the MCP
 * configuration for every agent at boot.
 */
export function useSuperAgent({ agents }: { agents: AgentStatus[] }) {
  const superAgent = useMemo(() => agents.find(a => a.role === 'orchestrator') || null, [agents]);
  return { superAgent };
}
