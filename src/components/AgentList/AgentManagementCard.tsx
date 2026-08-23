'use client';

import type { AgentStatus } from '@/types/electron';
import { Button, MetaChip, StatusSquare } from '@/components/ui';
import { STATUS_COLORS, PROVIDER_LABELS, statusTone } from '@/app/agents/constants';

// Row actions are words, not glyphs (R7): one 26px bordered lowercase-mono
// button each, sitting inside the card padding - the card has no footer band.
const ROW_ACTION = 'font-mono lowercase';

interface AgentManagementCardProps {
  agent: AgentStatus;
  onClick: () => void;
  onEdit: () => void;
  onStart: () => void;
  onStop: () => void;
  /** @deprecated No longer reachable from the card - the design keeps three actions. */
  onRemove?: () => void;
  /** @deprecated No longer reachable from the card - the design keeps three actions. */
  onSaveAsTemplate?: () => void;
}

export function AgentManagementCard({ agent, onClick, onEdit, onStart, onStop }: AgentManagementCardProps) {
  const statusConfig = STATUS_COLORS[agent.status];
  const tone = statusTone(agent.status);
  const isRunning = agent.status === 'running' || agent.status === 'waiting';

  // Show the user's last prompt, not terminal output
  const lastPrompt = agent.currentTask || null;
  const provider = agent.provider || 'claude';
  const model = provider === 'local' ? agent.localModel : agent.model;

  return (
    <div
      onClick={onClick}
      className="cursor-pointer transition-colors border border-border bg-card hover:bg-secondary"
    >
      <div className="p-3 flex flex-col gap-2">
        {/* Row 1: status mark + name, raw status word right-aligned (R6) */}
        <div className="flex items-center gap-2">
          <StatusSquare tone={tone} />
          <span className="flex-1 min-w-0 truncate text-xs font-semibold text-foreground">
            {agent.name || 'Unnamed Agent'}
          </span>
          <span className={`text-[11px] font-mono shrink-0 ${statusConfig.text}`}>
            {tone}
          </span>
        </div>

        {/* Row 2: one description line - the last prompt, or why there is none */}
        {agent.pathMissing ? (
          <p className="text-[11px] text-status-error truncate">Path not found</p>
        ) : lastPrompt ? (
          <p className="text-[11px] text-text-secondary truncate" title={lastPrompt}>
            {lastPrompt}
          </p>
        ) : (
          <p className="text-[11px] text-muted-foreground">No task assigned</p>
        )}

        {/* Row 3: provider, model, branch */}
        <div className="flex flex-wrap items-center gap-1.5">
          <MetaChip>{PROVIDER_LABELS[provider] || provider}</MetaChip>
          {model && <MetaChip className="max-w-[140px] truncate">{model}</MetaChip>}
          {agent.branchName && <MetaChip className="max-w-[140px] truncate">{agent.branchName}</MetaChip>}
        </div>

        <div className="flex items-center gap-2 pt-0.5" onClick={(e) => e.stopPropagation()}>
          <Button size="sm" className={ROW_ACTION} onClick={onClick}>
            open
          </Button>
          {isRunning ? (
            <Button size="sm" className={ROW_ACTION} onClick={onStop}>
              stop
            </Button>
          ) : (
            <Button size="sm" className={ROW_ACTION} onClick={onStart} disabled={agent.pathMissing}>
              start
            </Button>
          )}
          <Button size="sm" className={ROW_ACTION} onClick={onEdit}>
            edit
          </Button>
        </div>
      </div>
    </div>
  );
}
