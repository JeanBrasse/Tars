'use client';

import { useEffect, useRef } from 'react';
import { Paperclip } from 'lucide-react';
import { Button } from '@/components/ui';
import { AttachmentChips } from './AttachmentChips';
import type { OverseerAttachment } from '@/types/electron';

/**
 * The composer pinned under the thread. Enter sends, Shift+Enter makes a new
 * line, the same convention as every other message box in the app.
 *
 * The text box takes the full width and send sits at the far right of the
 * control bar under it, rather than beside the text. That is the redesign: the
 * composer now carries attachments, a provider, a model, an effort and a watch
 * cadence, and a send button wedged against the text left the controls to
 * overflow a single cramped row. Attach is first in the bar because it acts on
 * the message; send is last because it ends it.
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
  attachments = [],
  onAttach,
  onRemoveAttachment,
  attaching = false,
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
  /** Files already on the gateway, waiting to be named by the next message.
   *  The row is absent entirely when nothing is staged, so the composer is
   *  unchanged at rest. */
  attachments?: OverseerAttachment[];
  onAttach?: () => void;
  onRemoveAttachment?: (path: string) => void;
  attaching?: boolean;
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
    <div className="shrink-0 border border-border bg-card flex flex-col gap-1.5 px-3 py-2.5 focus-within:border-primary">
      <AttachmentChips attachments={attachments} onRemove={onRemoveAttachment} />
      {/* No box of its own: the text sits directly on the composer, which is
          already a bordered surface. Two nested borders read as a field inside
          a field, and the outer one is the thing that takes focus. */}
      <div className="flex items-center px-0.5" style={{ minHeight: MIN_BOX_PX }}>
        <textarea
          ref={ref}
          rows={1}
          value={value}
          onChange={e => onChange(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder={placeholder}
          style={{ lineHeight: `${LINE_HEIGHT_PX}px`, maxHeight: MAX_LINES * LINE_HEIGHT_PX }}
          className="w-full bg-transparent text-[13px] text-foreground placeholder:text-text-muted outline-none resize-none overflow-y-auto"
        />
      </div>
      <div className="flex items-center justify-between gap-2.5 min-w-0">
        <div className="flex-1 min-w-0 flex items-center gap-2">
          {onAttach && (
            <button
              type="button"
              onClick={onAttach}
              disabled={disabled || attaching}
              // Borderless: it acts on the message rather than setting a
              // property of it, so it is not shaped like the pickers beside it.
              className="inline-flex items-center gap-1.5 h-[26px] px-2 rounded text-[11px] text-muted-foreground hover:text-foreground hover:bg-secondary disabled:opacity-50"
            >
              <Paperclip className="w-3 h-3 shrink-0" />
              {attaching ? 'uploading' : 'attach'}
            </button>
          )}
          {controls}
        </div>
        <Button
          // While a turn is in flight this queues rather than sends, so it
          // stops being the primary action and says so.
          variant={sendLabel === 'send' ? 'primary' : 'secondary'}
          className="font-mono shrink-0"
          onClick={onSend}
          disabled={disabled || (!value.trim() && attachments.length === 0)}
        >
          {sendLabel}
        </Button>
      </div>
    </div>
  );
}
