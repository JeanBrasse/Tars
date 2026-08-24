'use client';

import { useEffect, useRef } from 'react';
import { Button } from '@/components/ui';

/**
 * The composer pinned under the thread. Enter sends, Shift+Enter makes a new
 * line, the same convention as every other message box in the app.
 *
 * The box grows with what you are writing and stops at eight lines, after
 * which it scrolls. It used to be a fixed two lines whatever you typed, which
 * made anything longer than a sentence a two-line window onto your own message.
 *
 * The controls under the text are deliberately quieter than the send button.
 * They describe what the next message runs on, so they read as plain labels,
 * and send stays the only accented thing here.
 */

/** Beyond this the box stops growing and scrolls instead. */
const MAX_LINES = 8;
const LINE_HEIGHT_PX = 18;

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

  // Measured rather than counted: a long line that wraps takes two rows on
  // screen and one newline in the value, and only the browser knows which.
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    // An empty box is exactly one line, stated rather than measured: the
    // measured height of an empty textarea moves by a pixel or two with font
    // loading, and that pixel shifts the whole card and everything above it.
    if (!value) {
      el.style.height = `${LINE_HEIGHT_PX}px`;
      return;
    }
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, MAX_LINES * LINE_HEIGHT_PX)}px`;
  }, [value]);

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      if (!disabled && value.trim()) onSend();
    }
  };

  return (
    <div className="shrink-0 border border-border bg-secondary flex flex-col gap-2 px-4 py-3.5">
      <textarea
        ref={ref}
        rows={1}
        value={value}
        onChange={e => onChange(e.target.value)}
        onKeyDown={handleKeyDown}
        disabled={disabled}
        placeholder={placeholder}
        style={{ lineHeight: `${LINE_HEIGHT_PX}px`, maxHeight: MAX_LINES * LINE_HEIGHT_PX }}
        className="w-full bg-transparent text-[12.5px] text-foreground placeholder:text-muted-foreground outline-none resize-none overflow-y-auto disabled:opacity-60"
      />
      {/* No rule between the two. The controls are already quieter than
          everything around them, and a line across the card only cut it in
          half without separating anything that needed separating. */}
      <div className="h-[26px] shrink-0 flex items-center justify-between gap-2">
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
