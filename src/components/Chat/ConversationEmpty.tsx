'use client';

import type { ReactNode } from 'react';
import { Button, StatusSquare } from '@/components/ui';

/**
 * What a conversation shows when it has nothing to show, centred in its
 * panel: a title, one line, and the one action that changes that. Frames:
 * the thread of `Chat · A · Room · no agents yet`, `· nothing said yet, how
 * it runs open`, `Chat · A · Hermes · nothing said yet` and `Chat · A · first
 * run, nothing to watch`: 560 wide, gap 4, the title 14 on 20, the line 12 on
 * 20 in 540, the action 12 under it.
 *
 * With `error`, `Chat · A · Room · the bus does not answer`: 480 wide, the
 * title behind an error square, and the bus's own words under it in mono, as
 * a diagnostic rather than as the sentence.
 */
export function ConversationEmpty({
  title,
  line,
  detail,
  error = false,
  action,
}: {
  title: string;
  line?: ReactNode;
  /** A failure's own words, as they came. */
  detail?: string;
  error?: boolean;
  action?: { label: string; onClick: () => void };
}) {
  return (
    <div data-conversation-empty className={`max-w-full flex flex-col items-center gap-1 text-center ${error ? 'w-[480px]' : 'w-[560px]'}`}>
      {error ? (
        <span className="h-5 flex items-center gap-2">
          <StatusSquare tone="error" />
          <span className="text-[14px] leading-5 text-foreground">{title}</span>
        </span>
      ) : (
        <p className="text-[14px] leading-5 text-foreground">{title}</p>
      )}
      {line && <p className="w-[540px] max-w-full text-[12px] leading-5 text-text-secondary">{line}</p>}
      {detail && <p className="max-w-full font-mono text-[11px] leading-4 text-text-muted break-words">{detail}</p>}
      {action && (
        <span className="flex items-center gap-2 pt-3">
          <Button size="sm" onClick={action.onClick}>{action.label}</Button>
        </span>
      )}
    </div>
  );
}
