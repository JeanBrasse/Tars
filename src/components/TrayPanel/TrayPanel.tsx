'use client';

import { useEffect, useState, useCallback, useMemo } from 'react';
import type { AgentTickItem } from '@/types/electron';
import { Brand } from '@/components/Brand';
import { Button } from '@/components/ui';
import TrayAgentItem from './TrayAgentItem';

export default function TrayPanel() {
  const [agents, setAgents] = useState<AgentTickItem[]>([]);
  const [expandedId, setExpandedId] = useState<string | null>(null);

  useEffect(() => {
    document.body.style.overflow = 'hidden';
    document.body.style.margin = '0';
  }, []);

  // Initial load from agent.list(), then tick takes over
  const fetchAgents = useCallback(async () => {
    if (!window.electronAPI?.agent?.list) return;
    try {
      const list = await window.electronAPI.agent.list();
      const mapped: AgentTickItem[] = list.map(a => ({
        id: a.id,
        name: a.name || `Agent ${a.id.slice(0, 6)}`,
        character: a.character || 'robot',
        status: a.status,
        displayStatus: deriveDisplayStatus(a),
        statusLine: a.statusLine || '',
        currentTask: a.currentTask || '',
        projectName: a.projectPath ? a.projectPath.split('/').pop() || '' : '',
        lastActivity: a.lastActivity,
        provider: a.provider || 'claude',
      }));
      setAgents(mapped);
    } catch (err) {
      console.error('Failed to fetch agents:', err);
    }
  }, []);

  useEffect(() => {
    fetchAgents();
  }, [fetchAgents]);

  // Subscribe to agents:tick for live updates
  useEffect(() => {
    const api = window.electronAPI;
    if (!api?.agent?.onTick) return;

    const unsub = api.agent.onTick((tickAgents) => {
      setAgents(tickAgents);
    });

    return () => unsub();
  }, []);

  // The only count the header carries. Every agent is listed once below, so
  // there is nothing to filter and nothing to narrow.
  const runningCount = useMemo(
    () => agents.filter(a => a.displayStatus === 'working').length,
    [agents],
  );

  // Stable alphabetical sort.
  const sortedAgents = useMemo(
    () => [...agents].sort((a, b) => a.name.localeCompare(b.name)),
    [agents],
  );

  const handleToggle = (id: string) => {
    setExpandedId(prev => (prev === id ? null : id));
  };

  return (
    <div className="app-shell flex flex-col h-screen select-none bg-background">
      {/* Header - brand mark on the left, running count on the right */}
      <div className="px-4 py-3 border-b border-border flex items-center justify-between gap-3 flex-shrink-0">
        <Brand
          markClassName="w-2.5 h-2.5"
          wordmarkClassName="font-serif text-base text-foreground"
          gapClassName="gap-2"
        />
        {runningCount > 0 && (
          <span className="font-mono text-[11px] text-status-running">
            {runningCount} running
          </span>
        )}
      </div>

      {/* Agent list */}
      <div className="flex-1 overflow-y-auto min-h-0">
        {sortedAgents.length === 0 ? (
          <div className="p-4 text-center text-xs text-muted-foreground">
            No agents configured
          </div>
        ) : (
          sortedAgents.map(agent => (
            <TrayAgentItem
              key={agent.id}
              agent={agent}
              expanded={expandedId === agent.id}
              onToggle={() => handleToggle(agent.id)}
            />
          ))
        )}
      </div>

      {/* Footer */}
      <div className="px-4 py-2.5 border-t border-border flex items-center justify-end gap-2 flex-shrink-0">
        <Button
          size="sm"
          onClick={() => window.electronAPI?.tray?.showMainWindow()}
        >
          open
        </Button>
        <Button
          size="sm"
          onClick={() => window.electronAPI?.tray?.quit()}
        >
          quit
        </Button>
      </div>
    </div>
  );
}

function deriveDisplayStatus(a: { status: string; ptyId?: string }): AgentTickItem['displayStatus'] {
  if (a.status === 'running') return 'working';
  if (a.status === 'waiting') return 'waiting';
  if (a.status === 'completed') return 'done';
  if (a.status === 'error') return 'error';
  if (a.status === 'idle' && a.ptyId) return 'ready';
  return 'stopped';
}
