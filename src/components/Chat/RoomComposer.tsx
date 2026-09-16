'use client';

import { useEffect, useRef } from 'react';
import { Paperclip } from 'lucide-react';
import { Button, Dropdown } from '@/components/ui';
import type { DropdownOption } from '@/components/ui';

/**
 * The room's composer. Frame: `Chat · Room · agents at work` > `composer`,
 * and `Chat · Room · you step in` for the focused state with `send now`.
 *
 * The box is 44 at rest and grows to eight lines, the same as the Hermes
 * composer, so the two levels of the page type the same way.
 */

const MAX_LINES = 8;
const LINE_HEIGHT_PX = 22;
const MIN_BOX_PX = 44;

export interface ComposerTarget {
  /** '' is the whole room. */
  id: string;
  label: string;
  /** Working right now: writing into its turn is the thing Tars will not do. */
  busy: boolean;
  /** Its CLI never reports a turn end, so nothing reaches it on its own. */
  noTurnSignal: boolean;
}

export function RoomComposer({
  value,
  onChange,
  onSend,
  targets,
  targetId,
  onTargetChange,
  disabled = false,
  placeholder,
  sendLabel = 'send',
  hint,
}: {
  value: string;
  onChange: (v: string) => void;
  onSend: () => void;
  targets: ComposerTarget[];
  targetId: string;
  onTargetChange: (id: string) => void;
  disabled?: boolean;
  placeholder: string;
  sendLabel?: string;
  hint?: string;
}) {
  const ref = useRef<HTMLTextAreaElement>(null);
  const target = targets.find(t => t.id === targetId);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (!value) { el.style.height = `${LINE_HEIGHT_PX}px`; return; }
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, MAX_LINES * LINE_HEIGHT_PX)}px`;
  }, [value]);

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      if (value.trim()) onSend();
    }
  };

  const options: DropdownOption[] = [
    { value: '', label: 'all' },
    ...targets.filter(t => t.id).map(t => ({
      value: t.id,
      label: t.label,
      hint: t.noTurnSignal ? 'no turn signal' : t.busy ? 'mid-turn' : undefined,
    })),
  ];

  // Only where it means something: a button that exists solely for an agent
  // that is working has no business in a composer aimed at the whole room or
  // at a stopped one. It would teach an action that is absent most of the time.
  const showSendNow = !!target?.busy;

  return (
    <div
      className={`shrink-0 border bg-secondary flex flex-col gap-2.5 p-3 focus-within:border-primary ${
        disabled ? 'border-border opacity-50' : 'border-border'
      }`}
    >
      <div className="flex items-center px-0.5" style={{ minHeight: MIN_BOX_PX }}>
        <textarea
          ref={ref}
          rows={1}
          value={value}
          disabled={disabled}
          onChange={e => onChange(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder={placeholder}
          style={{ lineHeight: `${LINE_HEIGHT_PX}px`, maxHeight: MAX_LINES * LINE_HEIGHT_PX }}
          className="w-full bg-transparent text-[13px] text-foreground placeholder:text-text-muted outline-none resize-none overflow-y-auto"
        />
      </div>

      <div className="flex items-center justify-between gap-2.5 min-w-0">
        <div className="flex-1 min-w-0 flex items-center gap-2">
          <button
            type="button"
            disabled
            title="Attachments are not in this version."
            className="inline-flex items-center gap-1.5 h-[26px] px-2 text-[11px] text-muted-foreground disabled:opacity-50"
          >
            <Paperclip className="w-3 h-3 shrink-0" />
            attach
          </button>
          <Dropdown
            value={targetId}
            options={options}
            onChange={onTargetChange}
            size="sm"
            ariaLabel="Who this message is for"
          />
          {hint && <span className="font-mono text-[10px] text-muted-foreground truncate">{hint}</span>}
        </div>

        <div className="flex items-center gap-2 shrink-0">
          {showSendNow && (
            <Button
              // Disabled, and it stays disabled until Noah rules on it: Tars
              // never writes into a turn that is running, so the only honest
              // thing this button can do today is say why. The day that call is
              // made, this button turns on and nothing else moves.
              disabled
              title="Not in this version. Tars never writes into a turn in progress: the queue delivers this when the turn ends."
              className="font-mono"
            >
              send now
            </Button>
          )}
          <Button
            variant={sendLabel === 'send' || sendLabel === 'start and send' ? 'primary' : 'secondary'}
            className="font-mono"
            onClick={onSend}
            disabled={disabled || !value.trim()}
            // A disabled control says why it is disabled, always: an unexplained
            // dead button is the thing this page exists to stop doing.
            title={
              disabled
                ? 'Add an agent to this room before you write here.'
                : !value.trim()
                  ? 'Write something first.'
                  : sendLabel === 'queue'
                    ? 'Queued now, delivered when that turn ends.'
                    : sendLabel === 'hold'
                      ? 'Held for you: this CLI never reports a turn end.'
                      : 'Send to the room.'
            }
          >
            {sendLabel}
          </Button>
        </div>
      </div>
    </div>
  );
}
