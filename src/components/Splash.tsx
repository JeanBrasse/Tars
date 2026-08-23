'use client';

import { useEffect, useRef, useState } from 'react';
import { BRAND_NAME } from '@/components/Brand';
import type { ElectronAPI } from '@/types/electron';

/**
 * The launch sequence.
 *
 * The window used to appear as a bare shell while the main process detected
 * providers and reached the gateway, which reads as a hang. This says what it
 * is waiting for, in the app's own mark: the orange square, drawn as a grid
 * that fills itself in as each step lands.
 *
 * The steps used to be three fixed timers totalling 1.26s, which meant the
 * splash was pure theatre: it held the window back on a fast launch and lied
 * about a slow one. Each step is now the real call the app makes at startup,
 * so the square fills as the work actually lands and the splash leaves the
 * instant there is nothing left to wait for.
 */

/** A step settles when its signal answers. A signal that fails still settled. */
function signal(fn: (api: ElectronAPI) => unknown) {
  return async () => {
    const api = typeof window === 'undefined' ? undefined : window.electronAPI;
    if (!api) return;
    try {
      await fn(api);
    } catch {
      // A provider that cannot be detected is an answer, not a reason to wait.
    }
  };
}

const STEPS: { label: string; ready: () => Promise<void> }[] = [
  { label: 'reading your projects', ready: signal((api) => api.fs?.listProjects?.()) },
  { label: 'detecting providers', ready: signal((api) => api.cliPaths?.detect?.()) },
  { label: 'connecting to Hermes', ready: signal((api) => api.hermes?.getConnection?.()) },
];

/** Nothing may hold the window behind the splash longer than this. */
const MAX_WAIT_MS = 4000;
/** Under this, the launch was instant: leave without a fade rather than linger. */
const INSTANT_MS = 150;
const EXIT_MS = 260;

const GRID = 4;
const CELLS = GRID * GRID;

/**
 * The mark, assembling. `filled` cells are lit; the rest sit at the dim rest
 * state so the square keeps its silhouette the whole way through.
 */
export function SquareGrid({
  filled,
  size = 56,
  className = '',
}: {
  filled: number;
  size?: number;
  className?: string;
}) {
  const gap = Math.max(2, Math.round(size * 0.07));
  const cell = (size - gap * (GRID - 1)) / GRID;

  return (
    <div
      className={`grid ${className}`}
      style={{
        width: size,
        height: size,
        gap,
        gridTemplateColumns: `repeat(${GRID}, ${cell}px)`,
      }}
      aria-hidden
    >
      {Array.from({ length: CELLS }).map((_, i) => (
        <span
          key={i}
          className="bg-primary transition-opacity duration-300 ease-out"
          style={{ opacity: i < filled ? 1 : 0.16 }}
        />
      ))}
    </div>
  );
}

/** The same mark, waiting rather than progressing: a row of squares in turn. */
export function SquarePulse({ count = 5, size = 6 }: { count?: number; size?: number }) {
  return (
    <div className="flex" style={{ gap: size }} aria-hidden>
      {Array.from({ length: count }).map((_, i) => (
        <span
          key={i}
          className="bg-primary"
          style={{
            width: size,
            height: size,
            animation: `square-pulse 1.2s ease-in-out ${i * 0.12}s infinite`,
          }}
        />
      ))}
    </div>
  );
}

export function Splash({ onDone }: { onDone?: () => void }) {
  // Which steps have answered. Rendered identically on the server, so the
  // splash is part of the first paint instead of a node added after hydration.
  const [settled, setSettled] = useState<boolean[]>(() => STEPS.map(() => false));
  const [leaving, setLeaving] = useState(false);

  // ClientLayout passes an inline arrow, so onDone changes identity on every
  // parent render. Holding it in a ref keeps the launch sequence from
  // restarting each time something above it re-renders.
  const onDoneRef = useRef(onDone);
  useEffect(() => {
    onDoneRef.current = onDone;
  });

  useEffect(() => {
    const started = Date.now();
    let live = true;
    let exit: ReturnType<typeof setTimeout> | undefined;

    const leave = () => {
      if (!live) return;
      live = false;
      clearTimeout(cap);
      // Nothing left to wait for, so do not manufacture something. A launch
      // this fast just swaps to the app; a slower one gets its fade out.
      if (Date.now() - started < INSTANT_MS) {
        onDoneRef.current?.();
        return;
      }
      setLeaving(true);
      exit = setTimeout(() => onDoneRef.current?.(), EXIT_MS);
    };

    const cap = setTimeout(leave, MAX_WAIT_MS);

    let remaining = STEPS.length;
    STEPS.forEach((s, i) => {
      s.ready().then(() => {
        if (!live) return;
        setSettled((prev) => {
          const next = [...prev];
          next[i] = true;
          return next;
        });
        if (--remaining === 0) leave();
      });
    });

    return () => {
      live = false;
      clearTimeout(cap);
      clearTimeout(exit);
    };
  }, []);

  const done = settled.filter(Boolean).length;
  // The grid fills in step with the work, not on a timer of its own.
  const filled = Math.round((done / STEPS.length) * CELLS);
  const waitingOn = STEPS.find((_, i) => !settled[i]) ?? STEPS[STEPS.length - 1];

  return (
    <div
      className={`fixed inset-0 z-[200] flex flex-col items-center justify-center gap-6 bg-background transition-opacity duration-250 ${
        // Once it is on its way out it must not swallow the first click.
        leaving ? 'pointer-events-none opacity-0' : 'opacity-100'
      }`}
    >
      <SquareGrid filled={filled} size={56} />

      <span className="font-serif text-4xl text-foreground">{BRAND_NAME}</span>

      <span className="font-mono text-[11px] text-muted-foreground">
        {waitingOn.label}
      </span>
    </div>
  );
}
