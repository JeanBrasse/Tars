'use client';

import type { ReactNode } from 'react';

export interface SegmentedOption<T extends string = string> {
  value: T;
  label: ReactNode;
  /** Native tooltip - use it for the long form of a short label. */
  title?: string;
  disabled?: boolean;
}

/**
 * A row of choices - Hermes/Local, Manual|Auto|Bypass, the effort ladder,
 * Dark|Light|System.
 *
 * Not a joined box. The design draws each option as its own 26px bordered
 * square with 8px of air between them, and marks the selected one with a box
 * (R2b: `bg-secondary` + `border-border-accent`) rather than an orange fill.
 * The accent is reserved for actions, never for "you are here".
 */
export function SegmentedControl<T extends string>({
  options,
  value,
  onChange,
  ariaLabel,
  className = '',
}: {
  options: readonly SegmentedOption<T>[];
  value: T;
  onChange: (value: T) => void;
  ariaLabel?: string;
  className?: string;
}) {
  return (
    <div role="radiogroup" aria-label={ariaLabel} className={`inline-flex items-center gap-2 ${className}`}>
      {options.map((option) => {
        const active = option.value === value;
        return (
          <button
            key={option.value}
            type="button"
            role="radio"
            aria-checked={active}
            title={option.title}
            disabled={option.disabled}
            onClick={() => onChange(option.value)}
            className={`inline-flex items-center justify-center h-[26px] px-2.5 text-xs border transition-colors cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed ${
              active
                ? 'bg-secondary border-border-accent text-foreground'
                : 'border-border text-muted-foreground hover:text-foreground hover:bg-secondary'
            }`}
          >
            {option.label}
          </button>
        );
      })}
    </div>
  );
}
