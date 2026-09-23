'use client';

import {
  FolderOpen,
  Clock,
  GitBranch,
  AlertTriangle,
  Square,
  Play,
  Trash2,
  Blocks,
  Terminal as TerminalIcon,
} from 'lucide-react';
import type { AgentStatus } from '@/types/electron';
import { TERMINAL_SURFACE_CLASS } from '@/lib/terminal-theme';
import { AgentMark, BrandSpinner } from '@/components/ui';

interface AgentDetailPanelProps {
  agent: AgentStatus;
  terminalRef: React.RefObject<HTMLDivElement | null>;
  terminalReady: boolean;
  onStop: () => void;
  onStart: () => void;
  onRemove: () => void;
}

export function AgentDetailPanel({
  agent,
  terminalRef,
  terminalReady,
  onStop,
  onStart,
  onRemove,
}: AgentDetailPanelProps) {
  return (
    <>
      {/* Agent Header */}
      <div className="px-3 lg:px-5 py-3 lg:py-4 border-b border-border-primary flex flex-col sm:flex-row sm:items-center justify-between gap-3 bg-bg-tertiary/30">
        <div className="flex items-center gap-3">
          <AgentMark name={agent.name || agent.id} orchestrator={agent.role === 'orchestrator'} size={24} />
          <div>
            <div className="flex items-center gap-2">
              <h3 className="font-semibold">{agent.name || agent.projectPath.split('/').pop()}</h3>
              {agent.provider && agent.provider !== 'claude' && agent.provider !== 'local' && (
                <span className="font-mono text-[10.5px] text-muted-foreground">{agent.provider}</span>
              )}
              {agent.branchName && (
                <span className="flex items-center gap-1 px-2 py-0.5 rounded-full bg-bg-tertiary text-text-muted text-xs">
                  <GitBranch className="w-3 h-3" />
                  {agent.branchName}
                </span>
              )}
            </div>
            <div className="flex items-center gap-3 text-xs text-text-muted mt-0.5">
              <span className="flex items-center gap-1">
                <FolderOpen className="w-3 h-3" />
                {agent.worktreePath || agent.projectPath}
              </span>
              {/* A wall clock: different on every run, so the visual test masks
                  it. The width is fixed because a mask covers the element's
                  box, and a box that changes size defeats the mask. */}
              <span data-volatile className="flex items-center gap-1 w-[92px] shrink-0">
                <Clock className="w-3 h-3" />
                {(() => {
                  try {
                    const date = new Date(agent.lastActivity);
                    if (isNaN(date.getTime())) return 'Just now';
                    return date.toLocaleTimeString();
                  } catch {
                    return 'Just now';
                  }
                })()}
              </span>
            </div>
          </div>
        </div>

        <div className="flex items-center gap-2 flex-wrap">
          {agent.pathMissing && (
            <div className="flex items-center gap-2 px-2 lg:px-3 py-1 lg:py-1.5 bg-accent-amber/20 text-accent-amber rounded-none text-xs lg:text-sm">
              <AlertTriangle className="w-3 h-3 lg:w-4 lg:h-4" />
              <span className="hidden sm:inline">Path not found</span>
            </div>
          )}
          {agent.status === 'running' ? (
            <button
              onClick={onStop}
              className="flex items-center gap-1.5 lg:gap-2 px-2 lg:px-3 py-1 lg:py-1.5 bg-accent-red/20 text-accent-red rounded-none hover:bg-accent-red/30 transition-colors text-xs lg:text-sm"
            >
              <Square className="w-3 h-3 lg:w-4 lg:h-4" />
              Stop
            </button>
          ) : (
            <button
              onClick={onStart}
              disabled={agent.pathMissing}
              className={`flex items-center gap-1.5 lg:gap-2 px-2 lg:px-3 py-1 lg:py-1.5 rounded-none transition-colors text-xs lg:text-sm ${
                agent.pathMissing
                  ? 'bg-bg-tertiary text-text-muted cursor-not-allowed'
                  : 'bg-accent-green/20 text-accent-green hover:bg-accent-green/30'
              }`}
            >
              <Play className="w-3 h-3 lg:w-4 lg:h-4" />
              Start
            </button>
          )}
          <button
            onClick={onRemove}
            className="flex items-center gap-1.5 lg:gap-2 px-2 lg:px-3 py-1 lg:py-1.5 bg-bg-tertiary text-text-muted rounded-none hover:text-accent-red transition-colors"
          >
            <Trash2 className="w-3 h-3 lg:w-4 lg:h-4" />
          </button>
        </div>
      </div>

      {/* Skills Bar */}
      {agent.skills.length > 0 && (
        <div className="px-5 py-2 border-b border-border-primary bg-bg-tertiary/50 flex items-center gap-2 overflow-x-auto">
          <Blocks className="w-4 h-4 text-text-muted shrink-0" />
          <span className="text-xs text-text-muted shrink-0">Skills:</span>
          {agent.skills.map((skill) => (
            <span
              key={skill}
              className="px-2 py-0.5 rounded-full bg-bg-tertiary text-text-muted text-xs shrink-0"
            >
              {skill}
            </span>
          ))}
        </div>
      )}

      {/* Live Terminal Output with xterm */}
      <div className="flex-1 min-h-0 relative overflow-hidden">
        <div
          ref={terminalRef}
          className={`absolute inset-0 ${TERMINAL_SURFACE_CLASS} p-2`}
          style={{ cursor: 'text' }}
        />
        {!terminalReady && (
          <div className={`absolute inset-0 flex items-center justify-center ${TERMINAL_SURFACE_CLASS}`}>
            <div className="flex items-center gap-2 text-text-muted">
              <BrandSpinner size={30} label="Initializing terminal" />
              <span>Initializing terminal</span>
            </div>
          </div>
        )}
      </div>

      {/* Status Bar */}
      <div className="px-4 py-2 border-t border-border-primary bg-bg-tertiary flex items-center justify-between text-xs">
        <div className="flex items-center gap-4">
          <div className="flex items-center gap-2">
            <TerminalIcon className="w-4 h-4 text-primary" />
            <span className="text-text-muted">Interactive Terminal</span>
          </div>
          {agent.status === 'running' && (
            <span className="flex items-center gap-1 text-primary">
              <span className="w-2 h-2 rounded-full bg-primary animate-pulse" />
              Agent is running
            </span>
          )}
          {agent.status === 'waiting' && (
            <span className="flex items-center gap-1 text-accent-amber">
              <span className="w-2 h-2 rounded-full bg-accent-amber animate-pulse" />
              Waiting for input
            </span>
          )}
        </div>
        <span className="text-text-muted">
          Type directly in terminal to interact
        </span>
      </div>
    </>
  );
}
