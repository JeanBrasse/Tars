'use client';

import { Play, Square } from 'lucide-react';
import type { AgentStatus } from '@/types/electron';
import { STATUS_COLORS } from '../constants';
import { AgentMark } from '@/components/ui';

interface SidebarAgentListProps {
  agents: AgentStatus[];
  focusedPanelId: string | null;
  onFocusPanel: (agentId: string) => void;
  onStartAgent: (agentId: string) => void;
  onStopAgent: (agentId: string) => void;
}

export default function SidebarAgentList({
  agents,
  focusedPanelId,
  onFocusPanel,
  onStartAgent,
  onStopAgent,
}: SidebarAgentListProps) {
  if (agents.length === 0) {
    return (
      <div className="p-4 text-center text-muted-foreground text-xs">
        No agents created yet
      </div>
    );
  }

  return (
    <div className="p-2 space-y-0.5">
      {agents.map((agent, index) => {
        const name = agent.name || `Agent ${agent.id.slice(0, 6)}`;
        const projectName = agent.projectPath.split('/').pop() || '';
        const status = STATUS_COLORS[agent.status] || STATUS_COLORS.idle;
        const isFocused = focusedPanelId === agent.id;
        const isRunning = agent.status === 'running' || agent.status === 'waiting';

        return (
          <div
            key={agent.id}
            onClick={() => onFocusPanel(agent.id)}
            className={`
              flex items-center gap-2 px-2.5 py-2 cursor-pointer transition-colors group
              ${isFocused
                ? 'bg-primary/10 border-l border-primary/60'
                : 'hover:bg-primary/5 border-l border-transparent'
              }
            `}
          >
            {/* Index number */}
            <span className="text-[10px] text-muted-foreground w-3 text-right font-mono">
              {index + 1}
            </span>

            {/* Avatar */}
            <div className="relative">
              <AgentMark name={agent.name || agent.id} orchestrator={agent.role === 'orchestrator'} />
              {agent.status === 'running' ? (
                <span className="absolute -bottom-0.5 -right-0.5 w-2 h-2">
                  <span className=" absolute inline-flex h-full w-full rounded-full bg-success opacity-75" />
                  <span className="relative inline-flex rounded-full h-2 w-2 bg-success" />
                </span>
              ) : (
                <span className={`absolute -bottom-0.5 -right-0.5 w-2 h-2 rounded-full ${status.dot}`} />
              )}
            </div>

            {/* Info */}
            <div className="flex-1 min-w-0">
              <p className="text-xs font-medium text-foreground truncate">{name}</p>
              <p className="text-[10px] text-muted-foreground truncate">{projectName}</p>
            </div>

            {/* Quick action */}
            <button
              onClick={e => {
                e.stopPropagation();
                isRunning ? onStopAgent(agent.id) : onStartAgent(agent.id);
              }}
              className={`
                p-1 opacity-0 group-hover:opacity-100 transition-all
                ${isRunning
                  ? 'text-danger hover:bg-danger/10'
                  : 'text-success hover:bg-success/10'
                }
              `}
            >
              {isRunning ? <Square className="w-3 h-3" /> : <Play className="w-3 h-3" />}
            </button>
          </div>
        );
      })}
    </div>
  );
}
