import { memo } from 'react';
import { AlertTriangle } from 'lucide-react';
import type { AgentStatus } from '@/types/electron';
import { TERMINAL_SURFACE_CLASS } from '@/lib/terminal-theme';

interface AgentDialogFooterProps {
  agent: AgentStatus;
  prompt: string;
  onPromptChange: (value: string) => void;
  onStart: () => void;
  /** Kept on the contract for the dialog's call site — stop now lives in AgentDialogHeader. */
  onStop: () => void;
}

export const AgentDialogFooter = memo(function AgentDialogFooter({
  agent,
  prompt,
  onPromptChange,
  onStart,
}: AgentDialogFooterProps) {
  return (
    <div className={`px-5 py-2 border-t border-border ${TERMINAL_SURFACE_CLASS}`}>
      {agent.pathMissing && (
        <div className="flex items-center gap-2 px-3 py-2 mb-2 bg-warning/10 border border-warning/30 text-warning text-sm">
          <AlertTriangle className="w-4 h-4 shrink-0" />
          <span>
            Project path no longer exists: <code className="font-mono text-xs">{agent.projectPath}</code>
          </span>
        </div>
      )}
      {/* One prompt line on the terminal surface. No submit button — Enter sends. */}
      <div className="flex items-start gap-2">
        <span className="shrink-0 py-[7px] font-mono text-[12.5px] leading-[18px] text-primary select-none">
          ❯
        </span>
        <textarea
          rows={1}
          value={prompt}
          onChange={(e) => onPromptChange(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              if (!agent.pathMissing) onStart();
            }
          }}
          placeholder={
            agent.pathMissing ? 'cannot start — project path not found' : 'type to the agent, or paste a task'
          }
          disabled={agent.pathMissing}
          className={`flex-1 min-h-8 max-h-32 py-[7px] bg-transparent border-0 outline-none resize-none overflow-y-auto font-mono text-[12.5px] leading-[18px] text-foreground placeholder:text-muted-foreground [field-sizing:content] ${
            agent.pathMissing ? 'opacity-50 cursor-not-allowed' : ''
          }`}
          autoFocus={!agent.pathMissing}
        />
        <span className="shrink-0 py-[7px] font-mono text-[11px] leading-[18px] text-muted-foreground whitespace-nowrap select-none">
          ⏎ send&nbsp;&nbsp;&nbsp;⇧⏎ newline
        </span>
      </div>
    </div>
  );
});
