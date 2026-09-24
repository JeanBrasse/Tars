'use client';

import type { ReactNode } from 'react';

/** Raw status vocabulary - no friendly strings ("working", "ready to work", "done"). */
export type StatusTone = 'running' | 'waiting' | 'error' | 'idle';

/** Semantic aliases kept so older callers keep compiling; they fold onto the four above. */
export type Tone = 'success' | 'warning' | 'danger' | 'info' | 'neutral';

export type AnyTone = StatusTone | Tone;

/** One tone table - ink for the word, fill for the square, and the word itself. */
const TONES: Record<AnyTone, { text: string; fill: string; word: StatusTone }> = {
  running: { text: 'text-status-running', fill: 'bg-status-running', word: 'running' },
  waiting: { text: 'text-status-waiting', fill: 'bg-status-waiting', word: 'waiting' },
  error: { text: 'text-status-error', fill: 'bg-status-error', word: 'error' },
  idle: { text: 'text-status-idle', fill: 'bg-status-idle', word: 'idle' },
  success: { text: 'text-status-running', fill: 'bg-status-running', word: 'running' },
  warning: { text: 'text-status-waiting', fill: 'bg-status-waiting', word: 'waiting' },
  danger: { text: 'text-status-error', fill: 'bg-status-error', word: 'error' },
  info: { text: 'text-primary', fill: 'bg-primary', word: 'running' },
  neutral: { text: 'text-status-idle', fill: 'bg-status-idle', word: 'idle' },
};

/**
 * The status mark: a 6px solid square, no radius. Replaces emoji tiles, pulsing
 * dots and `rounded-full` status pills everywhere a status is shown.
 *
 * `hollow` is the same square in outline, in the muted ink: an agent Tars holds
 * no live session for. It reads as a state that is absent rather than as one
 * more colour. Frames: `Chat · Room · all stopped`, `· at rest or stopped`.
 */
export function StatusSquare({ tone = 'idle', hollow = false, size = 6, className = '' }: {
  tone?: AnyTone;
  hollow?: boolean;
  /** 6 in a row, 8 in a strip across a card, as the composer's notice draws it. */
  size?: 6 | 8;
  className?: string;
}) {
  const ink = hollow ? 'border border-text-muted' : TONES[tone].fill;
  return <span className={`inline-block ${size === 8 ? 'w-2 h-2' : 'w-1.5 h-1.5'} shrink-0 ${ink} ${className}`} />;
}

/**
 * The status word itself, coloured by the status token - no background fill, no
 * radius, no border. Defaults to the raw word for the tone; pass children only to
 * print something else. Callers that sit in a mono column add `font-mono` themselves.
 */
export function StatusBadge({ tone = 'neutral', children, className = '' }: {
  tone?: AnyTone;
  children?: ReactNode;
  className?: string;
}) {
  return (
    <span className={`inline-flex items-center gap-1.5 text-xs ${TONES[tone].text} ${className}`}>
      {children ?? TONES[tone].word}
    </span>
  );
}

/** @deprecated Round dot - use `<StatusSquare>`; the design marks status with a 6px square. */
export function StatusDot({ tone = 'neutral', className = '' }: { tone?: AnyTone; className?: string }) {
  return <span className={`inline-block w-1.5 h-1.5 rounded-full shrink-0 ${TONES[tone].fill} ${className}`} />;
}
