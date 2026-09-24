'use client';

import { useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import Link from 'next/link';
import { CircleAlert, FileText, Image as ImageIcon } from 'lucide-react';
import { BrandSpinner, Button, MetaChip, StatusSquare } from '@/components/ui';
import { RichText } from '@/components/Overseer/RichText';
import type { AgentStatus, OverseerAction, OverseerAttachment, OverseerMessage } from '@/types/electron';
import { NewBelowBand, Time } from './RoomRow';
import { shortModel } from './team-view';
import { useFollowBottom } from '@/hooks/useFollowBottom';

/**
 * Hermes, the global room: the same panel as a project's room, its own head,
 * and a write to an agent only after you confirm it. Frames: `Chat · A ·
 * Hermes`, `· answering`, `· paused, a write sent`, `· not connected`, and the
 * sheet `Chat · A · Hermes · states`, in design/chat-redesign-a.pen.
 *
 * The page keeps Hermes's state and its calls; this draws them. Every row sits
 * on the room's two columns: the time at 24 from the panel's edge, everything
 * else from 72.
 */

export type GatewayState = 'checking' | 'ok' | 'not_configured' | 'needs_sign_in' | 'unreachable';

/** What happened to a write Hermes proposed, as the page tracks it. */
export interface ActionState {
  sending: boolean;
  resolved: 'sent' | 'cancelled' | null;
  error: string | null;
  /** Which press the error answered: a failed send is `not written`, a failed
   *  cancel leaves the proposal standing with its error. */
  failedOn?: 'send' | 'cancel';
  /** When it was sent, cancelled or failed. */
  at?: string;
}

const hhmm = (iso: string): string => {
  const at = new Date(iso);
  return Number.isNaN(at.getTime()) ? '' : at.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false });
};

const GATEWAY: Record<Exclude<GatewayState, 'ok' | 'checking'>, { message: string; cta: string }> = {
  not_configured: {
    message: 'No Hermes gateway is configured yet, so Hermes cannot watch the fleet or answer here.',
    cta: 'Set up Hermes',
  },
  needs_sign_in: {
    message: 'Hermes needs you signed in before it can watch the fleet or answer here.',
    cta: 'Sign in to Hermes',
  },
  unreachable: {
    message: 'Hermes is not answering, so it cannot watch the fleet or answer here right now.',
    cta: 'Open Hermes settings',
  },
};

/**
 * Under the head when Hermes cannot answer, with the way out. Frame: the
 * sheet's `GATEWAY`: a band across the panel, its words in the body column.
 */
export function HermesBanner({ state, detail, onRetry }: { state: GatewayState; detail: string | null; onRetry: () => void }) {
  if (state === 'ok' || state === 'checking') return null;
  const { message, cta } = GATEWAY[state];
  return (
    <div role="alert" className="shrink-0 flex px-6 py-3 bg-secondary border-b border-border">
      <span className="w-12 h-5 shrink-0 flex items-center">
        <CircleAlert className="w-4 h-4 text-status-waiting" />
      </span>
      <span className="flex-1 min-w-0 flex flex-col gap-1">
        <span className="text-[13px] leading-5 text-foreground">{message}</span>
        {detail && <span className="font-mono text-[11px] leading-4 text-text-muted break-all">{detail}</span>}
      </span>
      {/* Centred on the words, one line or two, as the frame's 40 high box. */}
      <span className="shrink-0 flex items-center gap-2 pl-3 self-center">
        <Link
          href="/settings?section=hermes"
          className="inline-flex items-center justify-center h-[26px] px-2.5 text-[12px] font-medium border border-primary bg-primary text-primary-foreground hover:bg-primary/90"
        >
          {cta}
        </Link>
        <Button size="sm" onClick={onRetry}>retry</Button>
      </span>
    </div>
  );
}

function Field({ label, children, prose }: { label: string; children: ReactNode; prose?: boolean }) {
  return (
    <div className={`flex gap-3 ${prose ? '' : 'h-5 items-center'}`}>
      {/* 1px low: the 11px mono key sits on the 12px value's baseline. */}
      <span className="relative top-px w-14 shrink-0 font-mono text-[11px] leading-5 text-text-muted">{label}</span>
      <span className={prose
        ? 'flex-1 min-w-0 text-[14px] leading-5 text-foreground whitespace-pre-wrap break-words'
        : 'flex-1 min-w-0 font-mono text-[12px] leading-5 text-foreground whitespace-pre truncate'}
      >
        {children}
      </span>
    </div>
  );
}

function secondsAgo(iso: string): number {
  return Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 1000));
}

/**
 * The centre of the feature: before any write reaches an agent, the card names
 * it in full (agent and id, project, CLI and pane, the exact words), and
 * nothing is written until send. The main process resolves the target against
 * the live fleet again before it writes; this is the read side of that gate.
 * Frame: the sheet's `A WRITE TO ONE AGENT`, its five states. The frame's
 * cancel while writing is not drawn: nothing can stop a write once sent.
 */
export function ApprovalCard({
  action,
  fleetIds,
  state,
  onCancel,
  onSend,
}: {
  action: OverseerAction;
  /** The ids of the fleet as the app knows it now; null while it is read. */
  fleetIds: ReadonlySet<string> | null;
  state?: ActionState;
  onCancel: () => void;
  onSend: () => void;
}) {
  const settled = !!state?.resolved;
  const [ago, setAgo] = useState(() => secondsAgo(action.resolvedAt));
  useEffect(() => {
    if (settled) return;
    const id = setInterval(() => setAgo(secondsAgo(action.resolvedAt)), 1000);
    return () => clearInterval(id);
  }, [action.resolvedAt, settled]);

  const stillInFleet = fleetIds ? fleetIds.has(action.agentId) : true;
  const failed = !!state?.error && state.failedOn !== 'cancel' && !state.sending;
  const phase = state?.sending ? 'writing'
    : state?.resolved === 'sent' ? 'sent'
      : state?.resolved === 'cancelled' ? 'cancelled'
        : failed ? 'failed'
          : 'pending';
  const at = state?.at ? hhmm(state.at) : '';
  const caption = phase === 'pending' ? 'about to write to one agent'
    : phase === 'writing' ? 'writing to one agent'
      : phase === 'sent' ? 'wrote to one agent'
        : 'not written';
  // `opus 5` rather than `claude-opus-5`, as the team names it. The provider is
  // only ever the fallback, and it is printed on its own before it.
  const model = action.model ? shortModel({ model: action.model, provider: action.provider as AgentStatus['provider'] }) : '';

  return (
    <div
      data-approval={phase}
      className={`flex flex-col border ${phase === 'pending' ? 'border-border-accent' : 'border-border'}`}
    >
      <div className="h-8 shrink-0 flex items-center gap-2 px-3 border-b border-border">
        <span className="relative top-px text-[10px] leading-4 uppercase tracking-[0.08em] text-text-secondary">{caption}</span>
        <span className="flex-1" />
        {phase !== 'pending' && (
          <span className="flex items-center gap-2">
            {phase === 'cancelled' ? <StatusSquare hollow /> : <StatusSquare tone={phase === 'failed' ? 'error' : 'running'} />}
            <span className={`text-[12px] leading-4 ${phase === 'failed' ? 'text-status-error' : 'text-text-secondary'}`}>{phase}</span>
          </span>
        )}
      </div>
      <div className="flex flex-col gap-1 p-3">
        <Field label="agent">{`${action.agentName}  (${action.agentId})`}</Field>
        <Field label="project">{action.projectPath}</Field>
        <Field label="cli">{[action.provider, model && model !== action.provider ? model : '', action.pane].filter(Boolean).join(' · ')}</Field>
        <Field label="message" prose>{action.text}</Field>
      </div>
      <div className="h-11 shrink-0 flex items-center gap-2 px-3 border-t border-border">
        {phase === 'pending' && !stillInFleet ? (
          <span className="flex-1 min-w-0 truncate text-[12px] leading-4 text-warning">
            This agent is no longer in the fleet listing, so there is nothing left to send this to.
          </span>
        ) : (
          <span className={`flex-1 min-w-0 truncate text-[12px] leading-4 ${phase === 'failed' || (phase === 'pending' && state?.error) ? 'text-status-error' : 'text-text-muted'}`}>
            {phase === 'pending' && (state?.error ?? `resolved from the fleet listing ${ago}s ago, not from memory`)}
            {phase === 'writing' && `typing it into ${action.agentName}’s session`}
            {phase === 'sent' && `written into ${action.agentName}’s session${at ? ` at ${at}` : ''}, after you confirmed`}
            {phase === 'cancelled' && `you cancelled${at ? ` at ${at}` : ''}: nothing was written`}
            {phase === 'failed' && state?.error}
          </span>
        )}
        {phase === 'pending' && (
          <>
            <Button size="sm" onClick={onCancel}>{stillInFleet ? 'cancel' : 'dismiss'}</Button>
            {stillInFleet && <Button size="sm" variant="primary" onClick={onSend}>send</Button>}
          </>
        )}
        {phase === 'failed' && <Button size="sm" onClick={onSend}>try again</Button>}
      </div>
    </div>
  );
}

/** A file a message carried, as the room's chips draw it. */
function AttachedChip({ file }: { file: OverseerAttachment }) {
  const Kind = file.isImage ? ImageIcon : FileText;
  return (
    <span title={file.path} className="inline-flex items-center gap-1.5 h-5 px-1.5 max-w-[320px] rounded border border-border bg-card">
      <Kind className="w-3 h-3 shrink-0 text-text-secondary" />
      <span className="text-[12px] leading-4 text-foreground truncate">{file.name}</span>
    </span>
  );
}

/**
 * One message: Hermes's with its name, yours as a band across the panel, as a
 * room's. A reply that came back as the format template is dimmed and says so,
 * and never carries a card that could send it.
 */
export function HermesMessageRow({
  message,
  fleetIds,
  actionState,
  onCancelAction,
  onSendAction,
  queued,
}: {
  message: Pick<OverseerMessage, 'role' | 'text' | 'timestamp' | 'attachments'> & Partial<Pick<OverseerMessage, 'action' | 'isBriefing' | 'templateEcho'>>;
  fleetIds: ReadonlySet<string> | null;
  actionState?: ActionState;
  onCancelAction?: (actionId: string) => void;
  onSendAction?: (actionId: string) => void;
  /** Written while Hermes was answering: it reads it once this answer is done. */
  queued?: boolean;
}) {
  const you = message.role === 'user';
  const echo = !you && !!message.templateEcho;
  return (
    <div
      data-row-kind={you ? 'you' : 'hermes'}
      className={`flex gap-3 px-6 ${you ? 'bg-secondary border-y border-border py-[7px]' : 'py-2'} ${echo ? 'opacity-60' : ''}`}
    >
      <Time>{hhmm(message.timestamp)}</Time>
      <div className="flex-1 min-w-0 flex flex-col">
        <div className="h-5 flex items-center gap-2">
          <span className="text-[13px] leading-5 font-medium text-foreground">{you ? 'you' : 'Hermes'}</span>
          {echo ? <MetaChip>empty reply</MetaChip> : message.isBriefing && <MetaChip>briefing</MetaChip>}
        </div>
        {message.text && (
          <div className="max-w-[720px] text-[14px] leading-5 text-foreground break-words">
            <RichText text={message.text} />
          </div>
        )}
        {!!message.attachments?.length && (
          <div className="flex flex-wrap items-center gap-x-1.5 gap-y-1 pt-1">
            {message.attachments.map(file => <AttachedChip key={file.path} file={file} />)}
          </div>
        )}
        {queued && (
          <div className="flex items-center gap-2 pt-1 min-w-0">
            <MetaChip raised>queued</MetaChip>
            <span className="text-[12px] leading-5 text-text-muted truncate">Hermes reads it once this answer is done</span>
          </div>
        )}
        {message.action && !echo && onCancelAction && onSendAction && (
          <div className="pt-2">
            <ApprovalCard
              action={message.action}
              fleetIds={fleetIds}
              state={actionState}
              onCancel={() => onCancelAction(message.action!.actionId)}
              onSend={() => onSendAction(message.action!.actionId)}
            />
          </div>
        )}
      </div>
    </div>
  );
}

/** While a turn is in flight: the mark, and how long it has taken so far. */
export function PendingTurnRow({ startedAt }: { startedAt: number }) {
  const [seconds, setSeconds] = useState(() => Math.round((Date.now() - startedAt) / 1000));
  useEffect(() => {
    const id = setInterval(() => setSeconds(Math.round((Date.now() - startedAt) / 1000)), 1000);
    return () => clearInterval(id);
  }, [startedAt]);
  return (
    <div data-row-kind="pending" className="py-2 pr-6 pl-[72px]">
      <div className="h-12 flex items-center gap-3 px-3 bg-secondary border border-border">
        <BrandSpinner size={26} label="Hermes is checking the fleet and composing a reply" />
        <span className="text-[12px] leading-4 text-text-secondary">
          Hermes is checking the fleet and composing a reply. This usually takes about 30 seconds{seconds > 0 && ` · ${seconds}s`}.
        </span>
      </div>
    </div>
  );
}

/**
 * A run of replies where Hermes wrote out its own format example instead of an
 * answer, folded to one line in the place they happened, and opening onto the
 * replies themselves: the flag is worked out on read, so nothing is hidden.
 */
export function EchoRunRow({ count, open, onToggle, children }: { count: number; open: boolean; onToggle: () => void; children: ReactNode }) {
  return (
    <>
      <div data-row-kind="echo" className="h-9 flex items-center gap-3 px-6">
        <span className="flex-1 border-t border-border" />
        <span className="font-mono text-[11px] leading-4 text-text-muted">
          {count === 1 ? '1 reply came back empty' : `${count} replies came back empty`}
        </span>
        <Button size="sm" active={open} aria-expanded={open} onClick={onToggle}>{open ? 'hide' : 'show'}</Button>
        <span className="flex-1 border-t border-border" />
      </div>
      {open && children}
    </>
  );
}

/**
 * The panel: the head, the gateway's band when Hermes cannot answer, and the
 * thread, anchored at the top and following the newest message.
 */
export function HermesView({
  head,
  banner,
  messageCount,
  rowCount,
  children,
}: {
  head: ReactNode;
  banner: ReactNode;
  /** What arrived, for the band that counts it while you read above. */
  messageCount: number;
  /** Every row drawn, so the thread follows a row that is not a message. */
  rowCount: number;
  children: ReactNode;
}) {
  const { box, content, onScroll, unseen, jumpToLatest } = useFollowBottom(messageCount, rowCount);
  return (
    <div data-room-panel className="flex-1 min-h-0 flex flex-col border border-border bg-card">
      {head}
      {banner}
      <div ref={box} data-thread onScroll={onScroll} className="flex-1 min-h-0 overflow-y-auto flex flex-col">
        <div ref={content} className="flex-1 flex flex-col pt-2 pb-3">
          {children}
        </div>
      </div>
      <NewBelowBand count={unseen} onJump={jumpToLatest} />
    </div>
  );
}
