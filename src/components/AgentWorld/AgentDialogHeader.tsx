import { memo } from 'react';
import type { AgentStatus } from '@/types/electron';
import { AgentMark, Button } from '@/components/ui';
import type { StatusTone } from '@/components/ui';
import { STATUS_COLORS } from '@/app/agents/constants';

interface AgentDialogHeaderProps {
  agent: AgentStatus;
  isSuperAgentMode: boolean;
  onClose: () => void;
  /** Row actions. Each renders disabled until the dialog wires a handler in. */
  onStop?: () => void;
  onRestart?: () => void;
  onEdit?: () => void;
  onOpenInReview?: () => void;
  /** @deprecated The design has no Finder button and no fullscreen toggle.
   *  Still accepted so the dialog keeps compiling while it is reworked. */
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
  // provider · model · branch · effort, as plain words: the facts the agent
  // cards write, and the effort only this window has room for.
  const model = agent.localModel || agent.model;
  const facts = [
    isSuperAgentMode ? 'orchestrator' : agent.provider || 'claude',
    model,
    agent.branchName,
    agent.effort,
  ].filter(Boolean).join(' · ');

  return (
    <div className="h-12 px-4 border-b border-border bg-card flex items-center justify-between gap-4">
      <div className="flex items-center gap-2.5 min-w-0">
        <AgentMark name={agent.name || agent.id} orchestrator={agent.role === 'orchestrator'} size={24} />
        <span className="text-[12.5px] font-semibold truncate">{agent.name || 'Agent'}</span>
        <span className="font-mono text-[11px] text-muted-foreground truncate" title={facts}>{facts}</span>
      </div>

      <div className="flex items-center gap-1 shrink-0">
        {/* The status as a word, in its colour, where the frame puts it:
            first of the row's actions. */}
        <span className={`font-mono text-[11px] mr-1.5 ${STATUS_COLORS[agent.status].text}`}>
          {TONE[agent.status]}
        </span>
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
