'use client';

import { useState } from 'react';
import type { ReactNode } from 'react';
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
  /** Tars can interrupt its turn: what send now needs (PR 169). */
  canInterrupt: boolean;
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

/** Why the strip is red: the last send, starting agents, or files the room refused. */
export type ComposerFailure = { kind: 'send' | 'start' | 'attach'; message: string };

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
  attachments,
  hasFiles = false,
  onAttach,
  attaching = false,
  onPasteFiles,
  notInterrupted,
  unreachable = false,
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
  /** Interrupts a busy agent's turn and delivers the message at once. Offered
   *  only for an agent whose turn Tars can interrupt. */
  onSendNow?: () => void;
  /** The staged files' tiles, above the text. */
  attachments?: ReactNode;
  /** A file alone is a message: send is on without words. */
  hasFiles?: boolean;
  /** Opens the file picker. */
  onAttach?: () => void;
  /** Files on their way to the room: + is off until they are staged. */
  attaching?: boolean;
  onPasteFiles?: (files: File[]) => void;
  /** Send now went through without interrupting this agent's turn: the
   *  message waits in its queue, and the strip says so until you move on. */
  notInterrupted?: string | null;
  /** The bus could not read the room: nothing written here could reach it.
   *  Frame: `Chat · A · Room · the bus does not answer`. */
  unreachable?: boolean;
}) {
  const target = targetId ? targets.find(t => t.id === targetId) : undefined;
  const noAgents = targets.length === 0;
  const everyoneStopped = !noAgents && targets.every(t => t.stopped);
  const targetStopped = !!target?.stopped;
  // Nobody would receive it: the field is off rather than letting a message be
  // written, recorded and delivered to nobody.
  const blocked = unreachable || noAgents || everyoneStopped || targetStopped;
  const mode: SendMode = target?.noTurnSignal ? 'hold' : target?.busy ? 'queue' : 'send';
  const hasText = value.trim().length > 0;
  const hasContent = hasText || hasFiles;
  const canSendNow = !!onSendNow && !!target?.canInterrupt;

  // Send now asks once: it stops the agent mid-turn. The question is about one
  // recipient in one state, so it lapses by itself when either changes, or
  // when the text it would send is gone.
  const [confirmFor, setConfirmFor] = useState<string | null>(null);
  const confirmKey = `${targetId}|${mode}`;
  const confirming = confirmFor === confirmKey && hasContent;

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
      // The room's own words, the frame's: the main process's sentence is not
      // relayed, as nowhere else on this page (bus-view.ts).
      text: failure.kind === 'send' ? notSentText('the room did not accept the message')
        : failure.kind === 'attach' ? `Not attached: ${failure.message.replace(/[.\s]+$/, '')}.`
          : failure.message,
    };
  } else if (unreachable) {
    // The panel above says what failed and offers retry: nothing to add here.
    notice = null;
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
  } else if (notInterrupted) {
    notice = {
      tone: 'running',
      text: `${notInterrupted}’s turn was not interrupted, so this message went into its queue instead.`,
    };
  } else if (target && mode === 'hold') {
    notice = {
      text: `${target.label} never says when its turn ends, so this message is held until you send it on.`,
    };
  } else if (target && mode === 'queue') {
    notice = {
      tone: 'running',
      // Send now only where Tars can interrupt the turn: a CLI that cannot be
      // interrupted gets the queue and no button that could never work.
      text: canSendNow
        ? `${target.label} is working, so this message will wait in its queue until the turn ends. Send now interrupts that turn.`
        : `${target.label} is working, so this message will wait in its queue until the turn ends.`,
      actions: canSendNow ? (
        <Button
          size="sm"
          disabled={!hasContent || sending}
          title={`Interrupt ${target.label}'s turn and deliver this now. You are asked once first.`}
          onClick={() => setConfirmFor(confirmKey)}
        >
          send now
        </Button>
      ) : undefined,
    };
  }

  const placeholder = unreachable ? 'Tars cannot reach this room right now'
    : noAgents ? 'Add an agent to write here'
      : everyoneStopped ? 'Start an agent to write here'
        : target && targetStopped ? `Start ${target.label} to write to it`
          : target ? `Write to ${target.label}`
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
      canSubmit={!blocked && hasContent && !sending && !confirming && !attaching}
      submitLabel={submitLabel}
      notice={notice}
      attachments={attachments}
      onAttach={!blocked && !attaching ? onAttach : undefined}
      onPasteFiles={!blocked ? onPasteFiles : undefined}
      attachLabel={blocked ? 'Files reach an agent only once one here can read them'
        : attaching ? 'Staging the files for this room' : 'Attach files'}
      controls={
        <MenuPicker
          value={targetId}
          options={options}
          onChange={onTargetChange}
          ariaLabel="Who this message is for"
          disabled={unreachable || noAgents || everyoneStopped}
          label={target ? target.label : 'Everyone'}
          leading={target ? square(target) ?? undefined : <Users className="w-3.5 h-3.5 text-muted-foreground" />}
        />
      }
    />
  );
}
