'use client';

import { Fragment, useCallback, useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { Check, ChevronDown } from 'lucide-react';
import { initialIndex, stepIndex } from './dropdown-logic';

export interface MenuPickerOption<T extends string = string> {
  value: T;
  label: string;
  /** Beside the label, in mono: what the option runs on. */
  detail?: string;
  /** At the right edge: what the option is doing now. */
  state?: string;
  /** Ink for `state`, a status token class. Muted when absent. */
  stateClass?: string;
  /** Before the label, in a 14px box: a status square or an icon. */
  leading?: ReactNode;
  /** A muted label: an option that is there but will not act on its own. */
  dim?: boolean;
  disabled?: boolean;
  /** A rule above this option, between the whole and its parts. */
  dividerBefore?: boolean;
}

/**
 * The trigger of a picker that sits in a row of controls, such as the Chat
 * composer's. Exported so a picker with its own panel reads the same.
 *
 * Borderless at rest, like the model picker in Claude's composer: it names a
 * property of the message rather than acting on it, so it does not carry the
 * weight of the button beside it. Open is a box, a lifted surface with a
 * darker border, and never the accent: in the composer, orange is send.
 */
export function pickerTriggerClass(open: boolean): string {
  return `inline-flex items-center gap-1.5 h-8 px-2 max-w-[260px] shrink-0 border text-xs font-medium text-foreground transition-colors cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed ${
    open ? 'bg-secondary border-border-accent' : 'border-transparent hover:bg-secondary'
  }`;
}

/**
 * A picker for a row of controls: a quiet trigger, and a panel that opens
 * upward over whatever is above it, with the current choice checked.
 *
 * Not `Dropdown`, whose selection is an accent square on an accent tint, which
 * is right for a form and wrong beside a send button that is the only orange
 * thing in its card. The keyboard is the same one: Up/Down move, Enter or
 * Space pick, Escape closes, Home/End jump, and the trigger keeps focus.
 * Frames: `Chat · A · Composer · states` > `RECIPIENT PICKER OPEN`.
 */
export function MenuPicker<T extends string = string>({
  value,
  options,
  onChange,
  ariaLabel,
  title,
  disabled = false,
  leading,
  label,
  mono = false,
}: {
  value: T;
  options: MenuPickerOption<T>[];
  onChange: (value: T) => void;
  ariaLabel: string;
  title?: string;
  disabled?: boolean;
  /** On the trigger, before its label. The current option's own when absent. */
  leading?: ReactNode;
  /** The trigger's words. The current option's label when absent. */
  label?: string;
  mono?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(-1);
  const ref = useRef<HTMLDivElement>(null);
  const current = options.find(o => o.value === value);

  // Where the pointer last was, as the rows heard it: null until they hear of
  // it. A row takes the highlight from the pointer only once the pointer has
  // really moved. Chromium sends a mouseenter and a mousemove at the same spot
  // when the panel opens under a pointer at rest, and the panel opens over the
  // message field, which is where the pointer rests after a click in it. The
  // row under it took the highlight with no movement at all, the arrows then
  // stepped from that row, and Enter picked one the keys never chose (QA's
  // gate of #124: 4 runs in 4).
  const pointer = useRef<{ x: number; y: number } | null>(null);
  const pointerMoved = (e: React.MouseEvent) => {
    const last = pointer.current;
    pointer.current = { x: e.screenX, y: e.screenY };
    return last !== null && (last.x !== e.screenX || last.y !== e.screenY);
  };

  const close = useCallback(() => {
    setOpen(false);
    setActive(-1);
  }, []);

  const commit = useCallback((option: MenuPickerOption<T>) => {
    if (option.disabled) return;
    onChange(option.value);
    close();
  }, [onChange, close]);

  // Opening starts on the current choice, so the arrows move from there. Set
  // in the same step that opens it, not in an effect after: an arrow pressed
  // at once would otherwise step from nowhere and land on the first row, and
  // the Enter after it would pick that row instead of the one highlighted.
  const openMenu = useCallback(() => {
    pointer.current = null;
    setActive(initialIndex(options, value));
    setOpen(true);
  }, [options, value]);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) close();
    };
    window.addEventListener('mousedown', onDown);
    return () => window.removeEventListener('mousedown', onDown);
  }, [open, close]);

  // A picker that turns disabled while open (the room stopped under it) closes.
  useEffect(() => { if (disabled) close(); }, [disabled, close]);

  function onKeyDown(e: React.KeyboardEvent) {
    if (!open) {
      if (e.key === 'Enter' || e.key === ' ' || e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        openMenu();
      }
      return;
    }
    switch (e.key) {
      case 'Escape':
        // Kept here: the composer around it would read Escape too.
        e.preventDefault();
        e.stopPropagation();
        close();
        break;
      case 'ArrowDown': {
        e.preventDefault();
        const next = stepIndex(options, active, 1);
        if (next >= 0) setActive(next);
        break;
      }
      case 'ArrowUp': {
        e.preventDefault();
        const next = stepIndex(options, active, -1);
        if (next >= 0) setActive(next);
        break;
      }
      case 'Home':
        e.preventDefault();
        setActive(initialIndex(options, ''));
        break;
      case 'End':
        e.preventDefault();
        setActive(stepIndex(options, 0, -1));
        break;
      case 'Enter':
      case ' ':
        e.preventDefault();
        if (active >= 0 && options[active]) commit(options[active]);
        break;
      case 'Tab':
        close();
        break;
    }
  }

  return (
    <div ref={ref} className="relative shrink-0 min-w-0" onKeyDown={onKeyDown}>
      <button
        type="button"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={ariaLabel}
        title={title}
        disabled={disabled}
        onClick={e => {
          // Take the caret out of the message box: typing after opening the
          // picker would otherwise go into the message.
          if (open) { close(); return; }
          (e.currentTarget as HTMLButtonElement).focus();
          openMenu();
        }}
        className={`${pickerTriggerClass(open)} ${mono ? 'font-mono' : ''}`}
      >
        {(leading ?? current?.leading) && (
          <span className="w-3.5 h-3.5 shrink-0 flex items-center justify-center">{leading ?? current?.leading}</span>
        )}
        <span className="truncate">{label ?? current?.label ?? ''}</span>
        <ChevronDown
          className={`w-3.5 h-3.5 text-muted-foreground shrink-0 transition-transform ${open ? 'rotate-180' : ''}`}
        />
      </button>

      {open && (
        <div
          role="listbox"
          aria-label={ariaLabel}
          className="absolute z-[90] bottom-full mb-1.5 left-0 w-max min-w-[220px] max-w-[min(24rem,calc(100vw-2rem))] max-h-[320px] overflow-y-auto border border-border bg-card p-1"
        >
          {options.map((o, i) => (
            <Fragment key={o.value}>
              {o.dividerBefore && i > 0 && <div className="my-1 h-px bg-border" />}
              <button
                type="button"
                role="option"
                aria-selected={o.value === value}
                data-index={i}
                disabled={o.disabled}
                onMouseEnter={e => { if (!pointer.current) pointer.current = { x: e.screenX, y: e.screenY }; }}
                onMouseMove={e => { if (pointerMoved(e) && !o.disabled && i !== active) setActive(i); }}
                onClick={() => commit(o)}
                // One fill, the row Enter picks. The current choice is marked by
                // its check, as the frame draws it: when both carried the fill,
                // two rows looked highlighted and the keys could not tell which
                // one Enter would take.
                className={`w-full h-8 pl-2.5 pr-2 flex items-center gap-2 text-left transition-colors cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed ${
                  i === active ? 'bg-secondary' : ''
                }`}
              >
                <span className="w-3.5 h-3.5 shrink-0 flex items-center justify-center">{o.leading}</span>
                <span className={`text-xs font-medium truncate ${o.dim ? 'text-text-muted' : 'text-foreground'} ${mono ? 'font-mono' : ''}`}>
                  {o.label}
                </span>
                {o.detail && <span className="font-mono text-[10.5px] text-text-muted truncate">{o.detail}</span>}
                <span className="flex-1 min-w-3" />
                {o.state && <span className={`text-[11px] shrink-0 ${o.stateClass ?? 'text-text-muted'}`}>{o.state}</span>}
                <span className="w-3.5 h-3.5 shrink-0 flex items-center justify-center">
                  {o.value === value && <Check className="w-3.5 h-3.5 text-foreground" />}
                </span>
              </button>
            </Fragment>
          ))}
        </div>
      )}
    </div>
  );
}
