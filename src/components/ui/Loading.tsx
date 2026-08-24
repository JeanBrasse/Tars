'use client';

import { useEffect, useState } from 'react';

/**
 * Loading, in three stages.
 *
 * A spinner that appears for 200ms is a flash, and one that spins for eight
 * seconds says nothing about what is slow. So: nothing at all under 400ms, a
 * skeleton in the shape of the content that is coming, and past three seconds
 * a line naming the operation with a way out.
 */

const SKELETON_AFTER_MS = 400;
const EXPLAIN_AFTER_MS = 3000;

export function useLoadingStage(loading: boolean): 'idle' | 'quiet' | 'skeleton' | 'explain' {
  const [elapsed, setElapsed] = useState<'quiet' | 'skeleton' | 'explain'>('quiet');

  useEffect(() => {
    if (!loading) {
      // Reset on the next tick: resetting during the effect would cascade.
      const reset = setTimeout(() => setElapsed('quiet'), 0);
      return () => clearTimeout(reset);
    }
    const toSkeleton = setTimeout(() => setElapsed('skeleton'), SKELETON_AFTER_MS);
    const toExplain = setTimeout(() => setElapsed('explain'), EXPLAIN_AFTER_MS);
    return () => {
      clearTimeout(toSkeleton);
      clearTimeout(toExplain);
    };
  }, [loading]);

  return loading ? elapsed : 'idle';
}

/** Rows shaped like the list that is loading, so the layout does not jump. */
export function SkeletonRows({ rows = 4, className = '' }: { rows?: number; className?: string }) {
  return (
    <div className={`space-y-1.5 ${className}`} aria-hidden>
      {Array.from({ length: rows }).map((_, i) => (
        <div key={i} className="flex items-center gap-3 border border-border bg-card px-3.5 py-3">
          <span className="w-1.5 h-1.5 bg-secondary shrink-0" />
          <div className="flex-1 space-y-1.5">
            <div className="h-2 bg-secondary" style={{ width: `${52 - i * 6}%` }} />
            <div className="h-1.5 bg-secondary" style={{ width: `${30 - i * 3}%` }} />
          </div>
        </div>
      ))}
    </div>
  );
}

/**
 * The mark, waiting.
 *
 * This replaces `<Loader2 className="animate-spin" />`, which was on 47 call
 * sites. A rotating ring is the same ring every other application uses; it says
 * nothing about whose wait this is. The 4x4 grid is the app icon, the sidebar
 * mark and the launch screen already, so a wait that shows it is recognisably
 * Tars working rather than a generic pause.
 *
 * One light travels the grid in reading order: the top-left cell, then along
 * that row, then back to the left of the row below, and so on. Each cell runs
 * the `square-sweep` keyframes delayed by its own index, so all sixteen are
 * distinct. It used to be `(col + row) mod 4`, which gives only four delays
 * and lights a whole diagonal at a time. Unlit cells rest at 0.16 rather than
 * disappearing, which is what keeps the silhouette readable.
 * Frame: `Loading · brand mark`.
 */
/** One pass of the light over all sixteen cells. */
const CYCLE_S = 2;

export function BrandSpinner({
  size = 30,
  className = '',
  label,
}: {
  /** Outer edge in px. 56 on the splash, 30 on a page, 14 inside a control. */
  size?: number;
  className?: string;
  /** Announced to screen readers. The animation itself is decorative. */
  label?: string;
}) {
  // 4 cells and 3 gaps, gap a quarter of a cell, so the mark keeps its
  // proportions at every size instead of the gaps swallowing a small one.
  const cell = size / 4.75;
  const gap = cell / 4;

  return (
    <span
      role={label ? 'status' : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : true}
      className={`relative inline-block shrink-0 ${className}`}
      style={{ width: size, height: size }}
    >
      {Array.from({ length: 16 }).map((_, i) => {
        const col = i % 4;
        const row = Math.floor(i / 4);
        return (
          <span
            key={i}
            className="square-sweep-cell absolute bg-primary"
            style={{
              left: col * (cell + gap),
              top: row * (cell + gap),
              width: cell,
              height: cell,
              // One cell at a time, in reading order: across the top row, then
              // back to the left of the next one down. The delay is the cell's
              // own index, so all sixteen are distinct; it used to be
              // `(col + row) % 4`, which gives only four delays and lights a
              // whole diagonal at once.
              animation: `square-sweep ${CYCLE_S}s linear ${(i * CYCLE_S) / 16}s infinite`,
            }}
          />
        );
      })}
    </span>
  );
}

/**
 * A whole panel given over to waiting: the mark, centred, over one line saying
 * what is being waited on. For the case where there is no content shape to put
 * a skeleton in, such as a terminal grid or a canvas.
 */
export function LoadingPanel({
  what,
  size = 30,
  className = '',
}: {
  what: string;
  size?: number;
  className?: string;
}) {
  return (
    <div className={`flex h-full flex-col items-center justify-center gap-3 ${className}`}>
      <BrandSpinner size={size} label={what} />
      <p className="text-xs text-muted-foreground">{what}</p>
    </div>
  );
}

/** Past three seconds: name what is slow, and offer a way out. */
export function SlowOperation({
  what,
  detail,
  onCancel,
}: {
  what: string;
  detail?: string;
  onCancel?: () => void;
}) {
  const [seconds, setSeconds] = useState(3);

  useEffect(() => {
    const id = setInterval(() => setSeconds(s => s + 1), 1000);
    return () => clearInterval(id);
  }, []);

  return (
    <div className="flex flex-col items-center justify-center gap-2.5 border border-border bg-card px-4 py-6 text-center">
      <BrandSpinner size={24} label={what} />
      <p className="text-xs text-foreground">{what}</p>
      {detail && (
        <p className="text-[10.5px] font-mono text-muted-foreground">
          {detail} ·{' '}
          {/* Counts up for as long as the wait lasts, so a page that is slow to
              load could never be screenshotted: the frame never repeats. */}
          <span data-volatile className="inline-block w-[34px] text-left">{seconds}s</span>
        </p>
      )}
      {onCancel && (
        <button
          onClick={onCancel}
          className="px-2.5 py-1 text-[11px] border border-border text-muted-foreground hover:text-foreground"
        >
          Cancel
        </button>
      )}
    </div>
  );
}

/**
 * The whole ladder in one component, for the common case.
 *
 * `variant` picks what the middle stage looks like. Skeleton rows are right
 * when a list is coming and wrong everywhere else: on a settings form they are
 * grey bars in the shape of nothing, and the page was the only one in the app
 * that did not show the mark while it waited. `mark` is the same ladder with
 * the animated mark in the middle instead.
 */
export function LoadingState({
  loading,
  rows,
  what,
  detail,
  onCancel,
  variant = 'skeleton',
  children,
}: {
  loading: boolean;
  rows?: number;
  what: string;
  detail?: string;
  onCancel?: () => void;
  variant?: 'skeleton' | 'mark';
  children?: React.ReactNode;
}) {
  const stage = useLoadingStage(loading);

  if (!loading) return <>{children}</>;
  if (stage === 'quiet') return null;
  if (stage === 'explain') return <SlowOperation what={what} detail={detail} onCancel={onCancel} />;
  if (variant === 'mark') {
    return (
      <div className="flex flex-col items-center justify-center gap-3 py-10">
        <BrandSpinner size={30} label={what} />
        <p className="text-xs text-muted-foreground">{what}</p>
      </div>
    );
  }
  return <SkeletonRows rows={rows} />;
}
