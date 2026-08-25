'use client';

import { useState } from 'react';
import type { OverseerFleetSnapshot, OverseerMessage } from '@/types/electron';
import { Button } from '@/components/ui';
import { MessageCard } from './MessageCard';

/**
 * A run of replies where Hermes wrote out its own format example instead of an
 * answer. Nineteen of them landed in one conversation before the loop was cut,
 * five minutes apart and again on every message sent in between.
 *
 * Folded rather than dropped. The flag is a heuristic worked out at read time
 * and the messages are still on disk, so hiding them outright would put
 * unexplained gaps in the thread and leave no way to check what was actually
 * received. The line says how many there were, in the place they happened, and
 * opens onto the replies themselves.
 */
export function EchoRun({
  messages,
  fleet,
  actionStates,
  onCancelAction,
  onSendAction,
}: {
  messages: OverseerMessage[];
  fleet: OverseerFleetSnapshot | null;
  actionStates: Record<string, { sending: boolean; resolved: 'sent' | 'cancelled' | null; error: string | null }>;
  onCancelAction: (actionId: string) => void;
  onSendAction: (actionId: string) => void;
}) {
  const [open, setOpen] = useState(false);

  return (
    <div className="flex flex-col gap-2.5">
      <div className="flex items-center gap-2.5">
        <span className="flex-1 border-t border-border" />
        <span className="font-mono text-[10.5px] text-muted-foreground shrink-0">
          {messages.length === 1 ? '1 reply came back empty' : `${messages.length} replies came back empty`}
        </span>
        {/* Open is a box, not a rule: `active` swaps the button's fill and
            border rather than underlining anything. */}
        <Button
          size="sm"
          active={open}
          aria-expanded={open}
          className="font-mono lowercase shrink-0"
          onClick={() => setOpen(v => !v)}
        >
          {open ? 'hide' : 'show'}
        </Button>
        <span className="flex-1 border-t border-border" />
      </div>

      {open && messages.map(m => (
        <MessageCard
          key={m.id}
          message={m}
          fleet={fleet}
          actionState={m.action ? actionStates[m.action.actionId] : undefined}
          onCancelAction={onCancelAction}
          onSendAction={onSendAction}
        />
      ))}
    </div>
  );
}
