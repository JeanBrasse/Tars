'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { BrandSpinner } from '@/components/ui';
import type { BusDelivery, BusMessage, BusRoom, BusThread } from '@/types/electron';
import type { RoomAgent } from '@/hooks/useRoomAgents';
import { RoomRow, RoomNotice } from './RoomRow';
import { RoomComposer } from './RoomComposer';
import type { ComposerFailure, ComposerTarget } from './RoomComposer';
import { agentStatusLabel, agentTone } from './TeamRail';
import { currentThread, summarise, threadNotice, toRows } from './bus-view';

/**
 * One project's room: the log, what is still waiting under it, and the
 * composer. Frames: `Chat · Room · agents at work`, `· you step in`,
 * `· limit reached`, `· all stopped`, `· no agents`, `· at rest or stopped`.
 */

function MetaBar({ room, thread }: { room: BusRoom; thread: BusThread | null }) {
  // The anchor's own counters, not a tally of the log: the bound is per anchor
  // and the log holds every anchor the room has had.
  const count = thread
    ? thread.state === 'bounded'
      ? `${thread.agentMessageCount} of 10 · paused`
      : `${thread.agentMessageCount} of 10 agent messages since you spoke`
    : 'nothing said yet';

  return (
    <div className="flex items-center gap-2 h-8 px-3 border-b border-border shrink-0">
      <span className="text-[12.5px] font-medium text-foreground truncate">{room.title}</span>
      {room.projectPath && (
        <span className="font-mono text-[10.5px] text-muted-foreground truncate">{room.projectPath}</span>
      )}
      <span className="flex-1" />
      <span className="font-mono text-[10.5px] text-muted-foreground shrink-0">{count}</span>
    </div>
  );
}

/** What is waiting, above the composer. A queue nobody can see is the silent
 *  failure this page had once already. */
function QueueBand({
  queued,
  queuedItems,
  notSent,
  notSentItems,
}: ReturnType<typeof summarise>) {
  if (!queued && !notSent) return null;
  return (
    <div className="flex items-center gap-2.5 h-8 px-3 border border-border bg-card shrink-0 overflow-hidden">
      {queued > 0 && (
        <>
          <span className="text-[10px] uppercase tracking-[0.06em] text-text-secondary shrink-0">
            queued · {queued}
          </span>
          <span className="font-mono text-[10.5px] text-muted-foreground truncate">{queuedItems.join(' · ')}</span>
        </>
      )}
      {notSent > 0 && (
        <>
          <span className="flex-1" />
          <span className="text-[10px] uppercase tracking-[0.06em] text-text-secondary shrink-0">
            not sent · {notSent}
          </span>
          <span className="font-mono text-[10.5px] text-muted-foreground truncate shrink-0">
            {notSentItems.join(' · ')}
          </span>
        </>
      )}
    </div>
  );
}

export function RoomView({
  room,
  threads,
  messages,
  deliveries,
  agents,
  loading,
  onPost,
  onStart,
}: {
  room: BusRoom;
  threads: BusThread[];
  messages: BusMessage[];
  deliveries: BusDelivery[];
  agents: RoomAgent[];
  loading: boolean;
  onPost: (text: string, mentions: string[]) => Promise<{ success: boolean; error?: string }>;
  /** Starts agents the way the Dashboard's start does, and names the ones
   *  that did not start. */
  onStart?: (ids: string[]) => Promise<Array<{ id: string; error: string }>>;
}) {
  const [draft, setDraft] = useState('');
  const [targetId, setTargetId] = useState('');
  const [sending, setSending] = useState(false);
  const [starting, setStarting] = useState(false);
  const [failure, setFailure] = useState<ComposerFailure | null>(null);

  const logRef = useRef<HTMLDivElement>(null);
  const stickToBottom = useRef(true);

  const rows = useMemo(() => toRows(messages, deliveries, agents), [messages, deliveries, agents]);
  const thread = useMemo(() => currentThread(threads), [threads]);
  const notice = useMemo(() => threadNotice(thread), [thread]);
  const pending = useMemo(() => summarise(deliveries, agents), [deliveries, agents]);

  useEffect(() => {
    if (!logRef.current || !stickToBottom.current) return;
    logRef.current.scrollTop = logRef.current.scrollHeight;
  }, [rows.length, notice]);

  const targets: ComposerTarget[] = useMemo(() => agents.map(a => ({
    id: a.id,
    label: a.name ?? a.id.slice(0, 8),
    busy: a.status === 'running' && !a.stopped,
    noTurnSignal: !a.hasEndOfTurn,
    stopped: a.stopped,
    tone: agentTone(a),
    state: agentStatusLabel(a),
    detail: a.provider ?? 'claude',
  })), [agents]);

  // Nothing here writes into a turn that is running: a message for a busy
  // agent is queued, and one for an agent whose CLI reports no turn end is
  // held until you send it on. The composer says which, before you send.
  const send = async () => {
    const text = draft.trim();
    if (!text || sending) return;
    setSending(true);
    setFailure(null);
    // An agent that has left the room since it was picked is shown as
    // Everyone, so the message goes to everyone rather than to a name that is
    // no longer here.
    const mentions = targetId && targets.some(t => t.id === targetId) ? [targetId] : [];
    const r = await onPost(text, mentions);
    setSending(false);
    // On a failure the words stay where they were typed, which is what the
    // strip tells you: send again to retry.
    if (r.success) setDraft('');
    else setFailure({ kind: 'send', message: r.error ?? '' });
  };

  const start = async (ids: string[]) => {
    if (!onStart || starting) return;
    setStarting(true);
    setFailure(null);
    const failed = await onStart(ids);
    setStarting(false);
    if (failed.length) {
      const names = failed.map(f => targets.find(t => t.id === f.id)?.label ?? f.id);
      setFailure({ kind: 'start', message: `Could not start ${names.join(', ')}: ${failed[0].error}` });
    }
  };

  return (
    <div className="flex-1 min-w-0 flex flex-col gap-2.5 min-h-0">
      <div className="flex-1 min-h-0 flex flex-col border border-border bg-card">
        <MetaBar room={room} thread={thread} />
        <div
          ref={logRef}
          onScroll={() => {
            const el = logRef.current;
            if (el) stickToBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 48;
          }}
          className="flex-1 min-h-0 overflow-y-auto flex flex-col justify-end gap-[3px] px-3 py-2.5"
        >
          {loading ? (
            <div className="flex-1 flex items-center justify-center">
              <BrandSpinner size={26} label="Reading the room" />
            </div>
          ) : rows.length === 0 ? (
            <div className="flex-1 flex flex-col items-center justify-center gap-1.5 text-center px-6">
              <p className="text-sm text-foreground">
                {agents.length === 0 ? 'Nobody in this room yet' : 'Nothing said yet'}
              </p>
              <p className="max-w-[440px] text-xs leading-[1.5] text-text-secondary">
                {agents.length === 0
                  ? 'A room is the agents of one project talking to each other and to you. Add one and it joins the moment it starts.'
                  : 'Agents speak when they are named or when they hand back a job. Write to the room to start one.'}
              </p>
            </div>
          ) : (
            <>
              {rows.map(row => <RoomRow key={row.id} row={row} />)}
              {notice && <RoomNotice caption={notice.caption} lines={notice.lines} />}
            </>
          )}
        </div>
      </div>

      <QueueBand {...pending} />

      <RoomComposer
        value={draft}
        onChange={setDraft}
        onSend={send}
        targets={targets}
        targetId={targetId}
        onTargetChange={setTargetId}
        roomTitle={room.title}
        sending={sending}
        failure={failure}
        onStart={onStart ? ids => { void start(ids); } : undefined}
        starting={starting}
      />
    </div>
  );
}
