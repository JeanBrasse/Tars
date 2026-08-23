'use client';

import type { ReactNode } from 'react';
import { AlertCircle } from 'lucide-react';
import { Button } from './Button';

/**
 * A page that could not load what it needs.
 *
 * Five pages had this shape and only one of them, Schedules, offered a way out.
 * Settings, Projects, Usage and Extensions each printed a heading and a raw
 * error string, so the only recovery was to navigate away and come back, and a
 * gateway that was briefly down looked like a broken app. The retry is the whole
 * point: the operation that failed is nearly always worth trying again, and the
 * page already holds the function that does it.
 *
 * `detail` is for the machine's own words. It is rendered small and monospaced,
 * under the sentence rather than instead of it, because "ECONNREFUSED
 * 127.0.0.1:9119" tells an engineer everything and a user nothing. Where a
 * transport failure can be translated into a sentence first, do that: see
 * `KanbanBoard/hermes-error.ts`.
 */
export function ErrorState({
  title,
  detail,
  onRetry,
  retryLabel = 'Retry',
  action,
  className = '',
}: {
  /** One sentence, in plain words, saying what failed. */
  title: string;
  /** The underlying reason, if there is one worth showing. */
  detail?: string | null;
  /** Runs the same load the page would run on mount. */
  onRetry?: () => void;
  retryLabel?: string;
  /** Anything else worth offering, such as a link to the settings that fix it. */
  action?: ReactNode;
  className?: string;
}) {
  return (
    <div
      role="alert"
      className={`flex flex-col items-center justify-center gap-3 px-6 py-10 text-center ${className}`}
    >
      <AlertCircle className="h-6 w-6 text-warning" />
      <p className="max-w-md text-sm text-foreground">{title}</p>
      {detail && (
        <p className="max-w-md break-all font-mono text-[11px] text-muted-foreground">{detail}</p>
      )}
      {(action || onRetry) && (
        <div className="flex items-center gap-2">
          {action}
          {onRetry && (
            <Button size="md" onClick={onRetry}>
              {retryLabel}
            </Button>
          )}
        </div>
      )}
    </div>
  );
}
