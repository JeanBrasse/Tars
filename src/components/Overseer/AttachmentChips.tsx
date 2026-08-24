'use client';

import { Image as ImageIcon, FileText, X } from 'lucide-react';
import type { OverseerAttachment } from '@/types/electron';

/**
 * The files a message carried, under its text.
 *
 * A chip shows the name and holds the gateway path in its title: the path is
 * what Hermes was actually given, so it is worth being able to read, but it is
 * long and machine-shaped and does not belong in the bubble.
 *
 * Frame: `Chat · Overseer` > `composer` > `attachments`.
 */
export function AttachmentChips({
  attachments,
  className = '',
  onRemove,
  on = 'card',
}: {
  attachments?: OverseerAttachment[];
  className?: string;
  /** Only the composer passes this: a file already sent cannot be unsent. */
  onRemove?: (path: string) => void;
  /** The surface the chips sit on. A chip is one step off its background, so
   *  it has to know which background that is: on a card it is `secondary`, and
   *  in a user's bubble - which is itself `secondary` - it is `card`. */
  on?: 'card' | 'secondary';
}) {
  if (!attachments || attachments.length === 0) return null;
  const fill = on === 'secondary' ? 'bg-card' : 'bg-secondary';
  return (
    <div className={`flex flex-wrap items-center gap-2 ${className}`}>
      {attachments.map(a => (
        <span
          key={a.path}
          className={`inline-flex items-center gap-1.5 border border-border ${fill} px-2.5 h-6 max-w-[220px]`}
          title={a.path}
        >
          {a.isImage
            ? <ImageIcon className="w-3 h-3 text-muted-foreground shrink-0" />
            : <FileText className="w-3 h-3 text-muted-foreground shrink-0" />}
          <span className="text-[11px] text-foreground truncate">{a.name}</span>
          {onRemove && (
            <button
              type="button"
              onClick={() => onRemove(a.path)}
              className="text-muted-foreground hover:text-foreground shrink-0"
              aria-label={`Remove ${a.name}`}
            >
              <X className="w-3 h-3" />
            </button>
          )}
        </span>
      ))}
    </div>
  );
}
