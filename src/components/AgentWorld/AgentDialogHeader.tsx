import { memo } from 'react';
import type { AgentStatus } from '@/types/electron';
import { Button, MetaChip, StatusSquare } from '@/components/ui';
import type { StatusTone } from '@/components/ui';

interface AgentDialogHeaderProps {
  agent: AgentStatus;
  isSuperAgentMode: boolean;
  onClose: () => void;
  /** Row actions. Each renders disabled until the dialog wires a handler in. */
  onStop?: () => void;
  onRestart?: () => void;
  onEdit?: () => void;
  onOpenInReview?: () => void;
  /** @deprecated The design has no avatar, no Finder button and no fullscreen
   *  toggle. Still accepted so the dialog keeps compiling while it is reworked. */
  character?: string;
  isFullscreen?: boolean;
  hasSecondaryProject?: boolean;
  onOpenInFinder?: () => void;
  onToggleFullscreen?: () => void;
}

/** `completed` and `waiting` are agent-side words; the mark only knows four tones. */
const TONE: Record<AgentStatus['status'], StatusTone> = {
  running: 'running',
  waiting: 'waiting',
  error: 'error',
  idle: 'idle',
  completed: 'idle',
};

export const AgentDialogHeader = memo(function AgentDialogHeader({
  agent,
  isSuperAgentMode,
  onClose,
  onStop,
  onRestart,
  onEdit,
  onOpenInReview,
}: AgentDialogHeaderProps) {
  // provider · model · branch · effort - the same four facts the agent cards show.
  const model = agent.localModel || agent.model;
  const meta = [
    isSuperAgentMode ? 'orchestrator' : agent.provider || 'claude',
    model,
    agent.branchName,
    agent.effort,
  ].filter(Boolean) as string[];

  return (
    <div className="h-12 px-4 border-b border-border bg-card flex items-center justify-between gap-4">
      <div className="flex items-center gap-2.5 min-w-0">
        <StatusSquare tone={TONE[agent.status]} />
        <span className="text-[12.5px] font-semibold truncate">{agent.name || 'Agent'}</span>
        <div className="flex items-center gap-1.5 min-w-0">
          {meta.map((value) => (
            <MetaChip key={value} className="max-w-[160px] truncate">{value}</MetaChip>
          ))}
        </div>
      </div>

      <div className="flex items-center gap-1 shrink-0">
        <Button
          variant="ghost"
          size="sm"
          className="font-mono font-normal"
          onClick={onStop}
          disabled={!onStop}
          title={onStop ? undefined : 'Not wired yet'}
        >
          stop
        </Button>
        <Button
          variant="ghost"
          size="sm"
          className="font-mono font-normal"
          onClick={onRestart}
          disabled={!onRestart}
          title={onRestart ? undefined : 'Not wired yet'}
        >
          restart
        </Button>
        <Button
          variant="ghost"
          size="sm"
          className="font-mono font-normal"
          onClick={onEdit}
          disabled={!onEdit}
          title={onEdit ? undefined : 'Not wired yet'}
        >
          edit
        </Button>
        <Button
          variant="ghost"
          size="sm"
          className="font-mono font-normal"
          onClick={onOpenInReview}
          disabled={!onOpenInReview}
          title={onOpenInReview ? undefined : 'Not wired yet'}
        >
          open in Review
        </Button>
        <Button variant="ghost" size="sm" className="font-mono font-normal" onClick={onClose}>
          close
        </Button>
      </div>
    </div>
  );
});
