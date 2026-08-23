'use client';

import { useEffect, useState } from 'react';
import { Button } from '@/components/ui';
import type { OverseerAction, OverseerFleetSnapshot } from '@/types/electron';

/**
 * The centre of the whole feature: before any write reaches an agent, this
 * panel names it in full - agent name AND id, the full project path, the
 * provider/model/pane, and the exact text - and nothing is sent until the
 * send button is pressed.
 *
 * The footer's "resolved Ns ago" line is not decoration: it ticks live from
 * `action.resolvedAt` so approving something that was resolved minutes ago is
 * a visible choice, never a silent one. The main process re-resolves the
 * target against the live fleet a second time immediately before writing
 * regardless of what this panel shows - this is the read side of that gate,
 * not a replacement for it.
 */

function secondsAgo(iso: string): number {
  const ms = Date.now() - new Date(iso).getTime();
  return Math.max(0, Math.round(ms / 1000));
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-start gap-2">
      <span className="w-16 shrink-0 font-mono text-[10px] text-muted-foreground pt-px">{label}</span>
      <span className="flex-1 min-w-0 font-mono text-[11px] text-foreground whitespace-pre-wrap break-words">
        {children}
      </span>
    </div>
  );
}

export function ApprovalBlock({
  action,
  fleet,
  sending,
  resolved,
  error,
  onCancel,
  onSend,
}: {
  action: OverseerAction;
  /** The most recently fetched fleet listing, used only to say up front
   *  whether this agent still looks reachable - the real check happens on
   *  the backend at send time regardless. */
  fleet: OverseerFleetSnapshot | null;
  sending: boolean;
  /** Set once Noah has resolved this proposal one way or the other. */
  resolved: 'sent' | 'cancelled' | null;
  error: string | null;
  onCancel: () => void;
  onSend: () => void;
}) {
  const [ago, setAgo] = useState(() => secondsAgo(action.resolvedAt));

  useEffect(() => {
    if (resolved) return;
    const id = setInterval(() => setAgo(secondsAgo(action.resolvedAt)), 1000);
    return () => clearInterval(id);
  }, [action.resolvedAt, resolved]);

  const stillInFleet = fleet ? fleet.agents.some(a => a.id === action.agentId) : true;

  return (
    <div className="border border-border-accent bg-background flex flex-col">
      <div className="flex items-center gap-2 px-3 py-2 border-b border-border">
        <span className="w-1 h-1 shrink-0 bg-primary" />
        <span className="font-mono text-[9.5px] uppercase tracking-[0.08em] text-muted-foreground">
          about to write to one agent
        </span>
      </div>

      <div className="flex flex-col gap-1.5 px-3 py-2.5">
        <Row label="agent">{action.agentName} (id {action.agentId})</Row>
        <Row label="project">{action.projectPath}</Row>
        <Row label="cli">{action.provider}{action.model ? ` · ${action.model}` : ''} · {action.pane}</Row>
        <Row label="message">{action.text}</Row>
      </div>

      {!stillInFleet && !resolved && (
        <div className="px-3 py-2 border-t border-border">
          <p className="text-[11px] text-warning">
            This agent no longer appears in the fleet listing, so there is nothing left to send this to. It
            may have finished, been removed, or moved project since this was proposed.
          </p>
        </div>
      )}

      {error && (
        <div className="px-3 py-2 border-t border-border">
          <p className="text-[11px] text-danger">{error}</p>
        </div>
      )}

      <div className="flex items-center justify-between gap-2 px-3 py-2 border-t border-border">
        <span className="font-mono text-[10px] text-muted-foreground">
          {resolved === 'sent' && 'sent'}
          {resolved === 'cancelled' && 'cancelled, nothing was sent'}
          {!resolved && `resolved from the fleet listing ${ago}s ago, not from memory`}
        </span>
        {!resolved && (
          <div className="flex items-center gap-2">
            <Button size="sm" variant="secondary" className="font-mono" onClick={onCancel} disabled={sending}>
              {stillInFleet ? 'cancel' : 'dismiss'}
            </Button>
            {stillInFleet && (
              <Button size="sm" variant="primary" className="font-mono" onClick={onSend} disabled={sending}>
                {sending ? 'sending' : 'send'}
              </Button>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
