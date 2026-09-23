'use client';

import { Button, StatusSquare } from '@/components/ui';

const ACTION = 'font-mono lowercase';

/**
 * The line a panel shows when its claude left fullscreen. Frame:
 * `Left fullscreen · notice`.
 *
 * Claude Code can leave fullscreen without telling the terminal (2.1.280 did,
 * with no ?1049l), so the panel keeps the fullscreen screen and the wheel's
 * reports go to a claude that no longer reads them. The main process sees it
 * in the way claude repaints (`leftFullscreen`, from #127), and useMultiTerminal
 * stops forwarding the wheel while it lasts. What is left is to say so, and to
 * offer the two ways back: the conversation read from its transcript, or the
 * same conversation in a new session (`agent.restart`, #138), which opens
 * fullscreen.
 *
 * The row of MessageWaitingNotice, 26 high under the header: the sentence is
 * cut first, the two actions stay.
 */
export default function LeftFullscreenNotice({ onHistory, onRestart }: {
  /** Opens the panel's history view; absent while it is already open. */
  onHistory?: () => void;
  onRestart: () => void;
}) {
  const who = 'Claude left fullscreen:';
  const rest = 'the wheel cannot scroll this terminal.';
  return (
    <div
      role="status"
      title={`${who} ${rest}`}
      className="h-[26px] shrink-0 flex items-center gap-2 pl-3 pr-1 bg-secondary border-b border-border select-none"
    >
      <StatusSquare tone="waiting" />
      <p className="min-w-0 flex-1 truncate text-[11px] leading-tight text-muted-foreground">
        <span className="text-foreground">{who}</span> {rest}
      </p>
      <div className="shrink-0 flex items-center">
        {onHistory && (
          <Button variant="ghost" size="sm" className={ACTION} onClick={onHistory} title="The conversation, read from the transcript">
            read history
          </Button>
        )}
        <Button variant="ghost" size="sm" className={ACTION} onClick={onRestart} title="Restart its CLI on the same conversation: it opens fullscreen">
          restart
        </Button>
      </div>
    </div>
  );
}
