'use client';

import { useRef } from 'react';
import { Button } from '@/components/ui';

/**
 * The composer pinned under the thread. Enter sends, Shift+Enter makes a new
 * line, the same convention as every other message box in the app.
 *
 * The controls under the text area are deliberately quieter than the send
 * button. They were three bordered boxes of the same weight, which made the
 * row read as four equal controls competing with each other; they describe
 * what the next message runs on, so they sit on a hairline below the text as
 * plain text and a chevron, and send stays the only accented thing here.
 */
export function Composer({
  value,
  onChange,
  onSend,
  disabled,
  placeholder,
  controls,
}: {
  value: string;
  onChange: (v: string) => void;
  onSend: () => void;
  disabled: boolean;
  placeholder: string;
  /** What the next message runs on, beside the message. They were in the page
   *  header, which crowded the title row and put a property of the message
   *  three inches from where you type it. */
  controls?: React.ReactNode;
}) {
  const ref = useRef<HTMLTextAreaElement>(null);

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      if (!disabled && value.trim()) onSend();
    }
  };

  return (
    <div className="h-[98px] shrink-0 border border-border bg-secondary flex flex-col gap-2 px-3 py-2.5">
      <textarea
        ref={ref}
        value={value}
        onChange={e => onChange(e.target.value)}
        onKeyDown={handleKeyDown}
        disabled={disabled}
        placeholder={placeholder}
        // content-center puts the text in the middle of the box rather than at
        // the top of it: with room for two lines, a one-line placeholder sat
        // against the ceiling with a gap underneath.
        className="flex-1 min-h-0 w-full content-center bg-transparent text-[12.5px] text-foreground placeholder:text-muted-foreground outline-none resize-none disabled:opacity-60"
      />
      <div className="h-[26px] shrink-0 flex items-center justify-between gap-2 border-t border-border pt-2 box-content">
        <div className="flex items-center gap-1 min-w-0">{controls}</div>
        <Button
          size="sm"
          variant="primary"
          className="font-mono shrink-0"
          onClick={onSend}
          disabled={disabled || !value.trim()}
        >
          send
        </Button>
      </div>
    </div>
  );
}
