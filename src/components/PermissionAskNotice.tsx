'use client';

import { useState } from 'react';
import type { KeyboardEvent } from 'react';
import { Button, Input, StatusSquare } from '@/components/ui';
import type { AgentStatus } from '@/types/electron';
import { permissionAskLine } from '@/lib/permission-ask';
import { TERMINAL_SURFACE_CLASS } from '@/lib/terminal-theme';

const ACTION = 'font-mono lowercase';

/** What main keeps of a reason (permission-asks.ts); the field takes no more. */
const MAX_REASON = 200;

const LATE_WHO = 'Tars no longer holds this question:';
const LATE_REST = 'if its terminal asks, answer there.';

type Decision = 'allow' | 'deny' | 'ask';
/** answers: the three; reason: deny's field; sending and sent: off until the agent's next state; late: Tars held nothing. */
type Phase = 'answers' | 'reason' | 'sending' | 'sent' | 'late';
interface State { of: string | undefined; phase: Phase; reason: string }

/**
 * A permission question the state mod asked Tars instead of Claude Code's
 * dialog (the state mod, PR 318), and its three answers: allow runs the call, deny refuses it
 * with a reason the agent reads if one is given, ask in terminal puts it to
 * the terminal's dialog, as before the mod. Nothing is typed into the
 * terminal. Frame: `Permission asked of Tars`.
 *
 * `panel`: the row of MessageWaitingNotice, 26 high under a panel's header,
 * the sentence cut first and the answers kept. `window`: the top of the agent
 * window's terminal column, the call in full with when it was asked.
 *
 * The state belongs to one question: the next call's (another askedAt) starts
 * afresh, whatever the last one left open.
 */
export default function PermissionAskNotice({ agent, layout }: {
  agent: Pick<AgentStatus, 'id' | 'status' | 'permissionAsk' | 'waitingOn'>;
  layout: 'panel' | 'window';
}) {
  const askedAt = agent.permissionAsk?.askedAt;
  const [kept, setKept] = useState<State>({ of: askedAt, phase: 'answers', reason: '' });
  const state: State = kept.of === askedAt ? kept : { of: askedAt, phase: 'answers', reason: '' };
  const line = permissionAskLine(agent);
  if (!line) return null;

  const set = (next: Partial<State>) => setKept({ ...state, ...next });
  const busy = state.phase === 'sending' || state.phase === 'sent';

  const answer = async (decision: Decision, reason?: string) => {
    if (busy) return;
    set({ phase: 'sending' });
    let taken = false;
    try {
      const result = await window.electronAPI?.agent?.answerPermission?.(agent.id, decision, reason);
      taken = result?.success === true;
    } catch {
      taken = false;
    }
    // Taken: off until the agent's next state takes the line away. Not taken:
    // the time ran out, the turn ended, or another window answered first.
    setKept(prev => (prev.of === askedAt ? { ...prev, phase: taken ? 'sent' : 'late' } : prev));
  };
  const deny = () => answer('deny', state.reason.trim() || undefined);
  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      deny();
    } else if (e.key === 'Escape') {
      // Back to the three, and no further: the agent window closes on Esc,
      // and a fullscreen panel leaves fullscreen.
      e.preventDefault();
      e.stopPropagation();
      set({ phase: 'answers', reason: '' });
    }
  };

  const late = state.phase === 'late';
  const reasonField = (
    <Input
      compact
      autoFocus
      aria-label="Why, for the agent"
      placeholder="why, optional: the agent reads it"
      value={state.reason}
      maxLength={MAX_REASON}
      onChange={e => set({ reason: e.target.value })}
      onKeyDown={onKeyDown}
    />
  );
  const lateLine = (
    <p className="min-w-0 truncate text-[11px] leading-tight text-muted-foreground">
      <span className="text-foreground">{LATE_WHO}</span> {LATE_REST}
    </p>
  );

  if (layout === 'panel') {
    return (
      <div
        role="status"
        data-permission-ask={agent.id}
        title={late ? `${LATE_WHO} ${LATE_REST}` : line.title}
        className={`shrink-0 flex items-center gap-2 pl-3 pr-1 bg-secondary border-b border-border select-none ${state.phase === 'reason' ? 'py-1' : 'h-[26px]'}`}
      >
        <StatusSquare tone="waiting" />
        {state.phase === 'reason' ? (
          <>
            {reasonField}
            <div className="shrink-0 flex items-center">
              <Button variant="ghost" size="sm" className={ACTION} onClick={deny}>deny</Button>
              <Button variant="ghost" size="sm" className={ACTION} onClick={() => set({ phase: 'answers', reason: '' })}>back</Button>
            </div>
          </>
        ) : late ? lateLine : (
          <>
            <p className="min-w-0 flex-1 truncate text-[11px] leading-tight text-muted-foreground">
              <span className="text-foreground">{line.who}</span> <span className="font-mono">{line.subject}</span>
            </p>
            <div className="shrink-0 flex items-center">
              <Button variant="ghost" size="sm" className={ACTION} disabled={busy} onClick={() => answer('allow')}>allow</Button>
              <Button variant="ghost" size="sm" className={ACTION} disabled={busy} onClick={() => set({ phase: 'reason' })}>deny</Button>
              <Button variant="ghost" size="sm" className={ACTION} disabled={busy} onClick={() => answer('ask')} title="Put it to the terminal's dialog, as before">ask in terminal</Button>
            </div>
          </>
        )}
      </div>
    );
  }

  return (
    <div role="status" data-permission-ask={agent.id} className="shrink-0 flex flex-col gap-2 px-3 py-2.5 bg-secondary border-b border-border">
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0 flex items-center gap-2">
          <StatusSquare tone="waiting" />
          <span className="text-xs text-foreground truncate" title={line.title}>{line.who.replace(/:$/, '')}</span>
        </div>
        {line.at && <span className="shrink-0 font-mono text-[11px] text-muted-foreground">{line.at}</span>}
      </div>
      {line.subject && (
        <p className={`px-2.5 py-[7px] border border-border ${TERMINAL_SURFACE_CLASS} font-mono text-xs leading-[18px] text-foreground break-all select-text`}>
          {line.subject}
        </p>
      )}
      {state.phase === 'reason' ? (
        <div className="flex items-center gap-1.5">
          {reasonField}
          <Button size="sm" className={`shrink-0 ${ACTION}`} onClick={deny}>deny</Button>
          <Button size="sm" className={`shrink-0 ${ACTION}`} onClick={() => set({ phase: 'answers', reason: '' })}>back</Button>
        </div>
      ) : late ? lateLine : (
        <div className="flex items-center gap-1.5">
          <Button size="sm" className={ACTION} disabled={busy} onClick={() => answer('allow')}>allow</Button>
          <Button size="sm" className={ACTION} disabled={busy} onClick={() => set({ phase: 'reason' })}>deny</Button>
          <Button size="sm" className={ACTION} disabled={busy} onClick={() => answer('ask')} title="Put it to the terminal's dialog, as before">ask in terminal</Button>
        </div>
      )}
    </div>
  );
}
