'use client';

import { ApprovalBlock } from './ApprovalBlock';
import type { OverseerFleetSnapshot, OverseerMessage } from '@/types/electron';
import { RichText } from './RichText';

function formatTime(iso: string): string {
  try {
    return new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  } catch {
    return '';
  }
}

/**
 * One card per message. The overseer's cards sit on `bg-card` ($surface in
 * the frame), Noah's own on `bg-secondary` ($surface-raised) - the same
 * lift a control gets, so a reply from the fleet and a line typed by hand
 * never read as the same kind of object.
 */
export function MessageCard({
  message,
  fleet,
  actionState,
  onCancelAction,
  onSendAction,
}: {
  message: OverseerMessage;
  fleet: OverseerFleetSnapshot | null;
  actionState?: { sending: boolean; resolved: 'sent' | 'cancelled' | null; error: string | null };
  onCancelAction: (actionId: string) => void;
  onSendAction: (actionId: string) => void;
}) {
  const isOverseer = message.role === 'overseer';
  const speaker = isOverseer ? 'Hermes' : 'You';

  return (
    <div
      className={`border border-border px-3.5 py-3 flex flex-col gap-1.5 ${
        isOverseer ? 'bg-card' : 'bg-secondary'
      }`}
    >
      <div className="flex items-center gap-2">
        <span className={`w-1.5 h-1.5 shrink-0 ${isOverseer ? 'bg-primary' : 'bg-status-idle'}`} />
        <span className={`font-mono text-[10.5px] ${isOverseer ? 'text-primary' : 'text-muted-foreground'}`}>
          {speaker}
        </span>
        <span className="flex-1 border-t border-border" />
        <span className="font-mono text-[10px] text-muted-foreground shrink-0">{formatTime(message.timestamp)}</span>
      </div>

      {message.isBriefing && (
        <span className="inline-flex self-start items-center h-[18px] px-1.5 border border-primary bg-accent-dim font-mono text-[9.5px] uppercase tracking-[0.06em] text-primary">
          briefing
        </span>
      )}

      {/* The reply is written by a model, so it arrives with Markdown emphasis
          in it. RichText renders the handful of forms that actually appear and
          builds React nodes rather than HTML, because this text quotes agent
          output. */}
      <div className="text-[12.5px] leading-relaxed text-foreground break-words">
        <RichText text={message.text} />
      </div>

      {message.action && (
        <ApprovalBlock
          action={message.action}
          fleet={fleet}
          sending={actionState?.sending ?? false}
          resolved={actionState?.resolved ?? null}
          error={actionState?.error ?? null}
          onCancel={() => onCancelAction(message.action!.actionId)}
          onSend={() => onSendAction(message.action!.actionId)}
        />
      )}
    </div>
  );
}
