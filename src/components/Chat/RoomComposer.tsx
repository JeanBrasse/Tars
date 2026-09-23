'use client';

import { useState } from 'react';
import { Users } from 'lucide-react';
import { Button, ComposerCard, MenuPicker, StatusSquare, notSentText } from '@/components/ui';
import type { ComposerNotice, MenuPickerOption, StatusTone } from '@/components/ui';

/**
 * The room's composer: one card, modeled on Claude's and ChatGPT's, the same
 * card as Hermes's. The recipient is picked in the row under the text, and a
 * strip across the top says what will happen to the message when that is not
 * simply "it arrives": it queues, it is held, nobody can receive it, or it was
 * not sent.
 *
 * Frames: `Chat · A · Composer · states` and its `· light`, in
 * `design/chat-redesign-a.pen`.
 */

/**
 * What pressing send will actually do. The tooltip and the strip are read from
 * this, so nothing decides anything by comparing words back to a string.
 */
export type SendMode = 'send' | 'queue' | 'hold';

export interface ComposerTarget {
  /** '' is the whole room. */
  id: string;
  label: string;
  /** Working right now: writing into its turn is the thing Tars will not do. */
  busy: boolean;
  /** Its CLI never reports a turn end, so nothing reaches it on its own. */
  noTurnSignal: boolean;
  /** Tars holds no live session for it: nothing reaches it until it starts.
   *  Not the same as at rest, which is where an idle agent waits between turns. */
  stopped: boolean;
  /** Its square in the picker, as the team shows it. `none` for an agent
   *  whose state Tars cannot vouch for. */
  tone: StatusTone | 'none';
  /** Its word in the picker: running, idle, stopped, no turn signal. */
  state: string;
  /** What it runs on, beside its name. */
  detail?: string;
}

/** Why the strip is red: the last send, or starting agents. */
export type ComposerFailure = { kind: 'send' | 'start'; message: string };

const STATE_INK: Record<StatusTone, string> = {
  running: 'text-status-running',
  waiting: 'text-status-waiting',
  error: 'text-status-error',
  idle: 'text-text-muted',
};

function square(target: ComposerTarget) {
  return target.tone === 'none' ? null : <StatusSquare tone={target.tone} hollow={target.stopped} />;
}

export function RoomComposer({
  value,
  onChange,
  onSend,
  targets,
  targetId,
  onTargetChange,
  roomTitle,
  sending = false,
  failure,
  onStart,
  starting = false,
  onSendNow,
}: {
  value: string;
  onChange: (v: string) => void;
  onSend: () => void;
  targets: ComposerTarget[];
  targetId: string;
  onTargetChange: (id: string) => void;
  roomTitle: string;
  /** A send in flight: send is off until it answers. */
  sending?: boolean;
  failure?: ComposerFailure | null;
  /** Starts the named agents, the way the Dashboard's start does. */
  onStart?: (ids: string[]) => void;
  starting?: boolean;
  /** Interrupts a busy agent's turn and delivers the message at once. Absent
   *  until the bus can do it, which leaves send now drawn and off. */
  onSendNow?: () => void;
}) {
  const target = targetId ? targets.find(t => t.id === targetId) : undefined;
  const noAgents = targets.length === 0;
  const everyoneStopped = !noAgents && targets.every(t => t.stopped);
  const targetStopped = !!target?.stopped;
  // Nobody would receive it: the field is off rather than letting a message be
  // written, recorded and delivered to nobody.
  const blocked = noAgents || everyoneStopped || targetStopped;
  const mode: SendMode = target?.noTurnSignal ? 'hold' : target?.busy ? 'queue' : 'send';
  const hasText = value.trim().length > 0;

  // Send now asks once: it stops the agent mid-turn. The question is about one
  // recipient in one state, so it lapses by itself when either changes, or
  // when the text it would send is gone.
  const [confirmFor, setConfirmFor] = useState<string | null>(null);
  const confirmKey = `${targetId}|${mode}`;
  const confirming = confirmFor === confirmKey && hasText;

  const stoppedIds = targets.filter(t => t.stopped).map(t => t.id);
  const startButton = (ids: string[], label: string) => (
    <Button
      size="sm"
      disabled={!onStart || starting}
      title={ids.length === 1 ? 'Start it, resuming its last session.' : 'Start every stopped agent here, each resuming its last session.'}
      onClick={() => onStart?.(ids)}
    >
      {starting ? 'starting' : label}
    </Button>
  );

  let notice: ComposerNotice | null = null;
  if (failure) {
    notice = {
      tone: 'error',
      emphasis: 'error',
      text: failure.kind === 'send' ? notSentText(failure.message) : failure.message,
    };
  } else if (everyoneStopped) {
    notice = {
      tone: 'idle',
      hollow: true,
      text: `Everyone in ${roomTitle} is stopped. Nothing you write reaches an agent until one starts.`,
      actions: startButton(stoppedIds, 'start all'),
    };
  } else if (target && targetStopped) {
    notice = {
      tone: 'idle',
      hollow: true,
      text: `${target.label} is stopped. Nothing you write reaches it until it starts.`,
      actions: startButton([target.id], 'start'),
    };
  } else if (target && confirming) {
    notice = {
      tone: 'running',
      emphasis: 'question',
      text: `Interrupt ${target.label}'s turn and send this now? What it is doing stops where it is.`,
      actions: (
        <>
          <Button size="sm" variant="ghost" onClick={() => setConfirmFor(null)}>cancel</Button>
          <Button
            size="sm"
            variant="danger"
            onClick={() => { setConfirmFor(null); onSendNow?.(); }}
          >
            interrupt and send
          </Button>
        </>
      ),
    };
  } else if (target && mode === 'hold') {
    notice = {
      text: `${target.label} never says when its turn ends, so this message is held until you send it on.`,
    };
  } else if (target && mode === 'queue') {
    notice = {
      tone: 'running',
      text: onSendNow
        ? `${target.label} is working, so this message will wait in its queue until the turn ends. Send now interrupts that turn.`
        : `${target.label} is working, so this message will wait in its queue until the turn ends.`,
      actions: (
        <Button
          size="sm"
          disabled={!onSendNow || !hasText || sending}
          title={onSendNow
            ? `Interrupt ${target.label}'s turn and deliver this now. You are asked once first.`
            : `Send now would interrupt ${target.label}'s turn and deliver this at once. Tars cannot interrupt a turn yet, so it stays off until it can.`}
          onClick={() => setConfirmFor(confirmKey)}
        >
          send now
        </Button>
      ),
    };
  }

  const placeholder = noAgents
    ? 'Add an agent before you write here.'
    : everyoneStopped
      ? 'Start an agent to write here'
      : target && targetStopped
        ? `Start ${target.label} to write to it`
        : target
          ? `Write to ${target.label}`
          : `Write to everyone in ${roomTitle}`;

  const submitLabel = !target
    ? `Send to everyone in ${roomTitle}`
    : mode === 'queue'
      ? `Queue for ${target.label}: it gets this when its turn ends`
      : mode === 'hold'
        ? `Hold for ${target.label}: you send it on when it can take it`
        : `Send to ${target.label}`;

  const options: MenuPickerOption[] = [
    {
      value: '',
      label: `Everyone in ${roomTitle}`,
      leading: <Users className="w-3.5 h-3.5 text-muted-foreground" />,
      state: `${targets.length} ${targets.length === 1 ? 'agent' : 'agents'}`,
    },
    ...targets.map((t, i) => ({
      value: t.id,
      label: t.label,
      detail: t.detail,
      leading: square(t),
      state: t.state,
      stateClass: t.tone === 'none' || t.stopped ? undefined : STATE_INK[t.tone],
      dim: t.stopped,
      dividerBefore: i === 0,
    })),
  ];

  return (
    <ComposerCard
      value={value}
      onChange={onChange}
      onSubmit={onSend}
      placeholder={placeholder}
      disabled={blocked}
      canSubmit={!blocked && hasText && !sending && !confirming}
      submitLabel={submitLabel}
      notice={notice}
      // No file reaches an agent in a room yet: the bus carries text. Drawn,
      // and off until it can.
      attachLabel="Files cannot reach agents in a room yet"
      controls={
        <MenuPicker
          value={targetId}
          options={options}
          onChange={onTargetChange}
          ariaLabel="Who this message is for"
          disabled={noAgents || everyoneStopped}
          label={target ? target.label : 'Everyone'}
          leading={target ? square(target) ?? undefined : <Users className="w-3.5 h-3.5 text-muted-foreground" />}
        />
      }
    />
  );
}
