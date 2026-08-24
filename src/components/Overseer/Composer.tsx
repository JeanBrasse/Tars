'use client';

import { useEffect, useRef } from 'react';
import { Button } from '@/components/ui';

/**
 * The composer pinned under the thread. Enter sends, Shift+Enter makes a new
 * line, the same convention as every other message box in the app.
 *
 * The text sits in its own bordered box with room in it, and send is a button
 * beside it rather than under it. What was here before put 13px text on a 19px
 * line inside a bare card, so the placeholder was tight against its own edges
 * and the whole thing read as small. The shape follows Hermes Desktop's chat
 * input, which is what Noah pointed at, in Tars's own tokens: square corners,
 * the app's borders, no rounding.
 *
 * The box is 44 tall at rest and grows to eight lines before it scrolls.
 * Frame: `Chat · Overseer` > `composer`.
 */

/** Beyond this the box stops growing and scrolls instead. */
const MAX_LINES = 8;
const LINE_HEIGHT_PX = 22;
/** At rest: one line, centred in a box tall enough to be a target. */
const MIN_BOX_PX = 44;

export function Composer({
  value,
  onChange,
  onSend,
  disabled,
  placeholder,
  controls,
  sendLabel = 'send',
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
  /** `queue` while Hermes is mid-reply, so the button says what pressing it
   *  will actually do. */
  sendLabel?: string;
}) {
  const ref = useRef<HTMLTextAreaElement>(null);

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
    // Measured rather than counted: a long line that wraps takes two rows on
    // screen and one newline in the value, and only the browser knows which.
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, MAX_LINES * LINE_HEIGHT_PX)}px`;
  }, [value]);

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      if (value.trim()) onSend();
    }
  };

  return (
    <div className="shrink-0 border border-border bg-card flex flex-col gap-2.5 p-3">
      <div className="flex items-end gap-2.5">
        <div
          className="flex-1 min-w-0 flex items-center border border-border bg-secondary px-3.5 py-3"
          style={{ minHeight: MIN_BOX_PX }}
        >
          <textarea
            ref={ref}
            rows={1}
            value={value}
            onChange={e => onChange(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder={placeholder}
            style={{ lineHeight: `${LINE_HEIGHT_PX}px`, maxHeight: MAX_LINES * LINE_HEIGHT_PX }}
            className="w-full bg-transparent text-[13.5px] text-foreground placeholder:text-muted-foreground outline-none resize-none overflow-y-auto"
          />
        </div>
        <Button
          variant="primary"
          className="font-mono shrink-0"
          style={{ height: MIN_BOX_PX }}
          onClick={onSend}
          disabled={disabled || !value.trim()}
        >
          {sendLabel}
        </Button>
      </div>
      <div className="flex items-center gap-2.5 min-w-0">{controls}</div>
    </div>
  );
}
