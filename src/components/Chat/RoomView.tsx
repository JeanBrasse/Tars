'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { ArrowDown } from 'lucide-react';
import { BrandSpinner, Button } from '@/components/ui';
import type { BusDelivery, BusMessage, BusRoom, BusThread } from '@/types/electron';
import type { RoomAgent } from '@/hooks/useRoomAgents';
import { DayRow, MessageRow, NoticeRow, SystemRow } from './RoomRow';
import { NeedsStrip } from './NeedsStrip';
import { RoomComposer } from './RoomComposer';
import type { ComposerFailure, ComposerTarget } from './RoomComposer';
import { agentStatusLabel, agentTone, needsRows } from './team-view';
import type { NeedAction } from './team-view';
import { currentThread, threadItems } from './bus-view';
import type { ThreadItem } from './bus-view';

/**
 * One project's room: the log, what is still waiting under it, and the
 * composer. Frames: `Chat · Room · agents at work`, `· you step in`,
 * `· limit reached`, `· all stopped`, `· no agents`, `· at rest or stopped`.
 */

export function RoomView({
  room,
  threads,
  messages,
  deliveries,
  agents,
  loading,
  onPost,
  onStart,
  head,
  targetId: controlledTarget,
  onTargetChange,
  onRelease,
  onOpenTerminal,
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
  /** The room's head, drawn across the top of the panel. Frame: the room head
   *  of every `Chat · A · Room` page. */
  head?: React.ReactNode;
  /** Who the composer writes to, when the page owns it: a team row's `write`
   *  picks its agent here. Uncontrolled when absent. */
  targetId?: string;
  onTargetChange?: (id: string) => void;
  /** Sends what is held for an agent with no turn signal, oldest first. */
  onRelease?: (agentId: string) => void;
  /** Where an agent's terminal is: the Dashboard's panel. */
  onOpenTerminal?: (agentId: string) => void;
}) {
  const [draft, setDraft] = useState('');
  const [ownTarget, setOwnTarget] = useState('');
  const targetId = controlledTarget ?? ownTarget;
  const setTargetId = onTargetChange ?? setOwnTarget;
  const [sending, setSending] = useState(false);
  const [starting, setStarting] = useState(false);
  const [failure, setFailure] = useState<ComposerFailure | null>(null);

  const logRef = useRef<HTMLDivElement>(null);
  const stickToBottom = useRef(true);
  const seenCount = useRef(0);
  const [unseen, setUnseen] = useState(0);

  const thread = useMemo(() => currentThread(threads), [threads]);
  const items = useMemo(
    () => threadItems(messages, deliveries, agents, thread),
    [messages, deliveries, agents, thread],
  );
  const needs = useMemo(() => needsRows(agents, deliveries), [agents, deliveries]);
  const messageCount = messages.length;

  // The thread starts under the head; once it is longer than the panel, the
  // view follows the newest message, unless you scrolled up to read, in which
  // case what arrived is counted in a band under the thread instead.
  useEffect(() => {
    const el = logRef.current;
    const added = messageCount - seenCount.current;
    seenCount.current = messageCount;
    if (!el) return;
    if (stickToBottom.current) {
      el.scrollTop = el.scrollHeight;
    } else if (added > 0) {
      setUnseen(n => n + added);
    }
  }, [messageCount, items.length]);

  const jumpToLatest = () => {
    const el = logRef.current;
    if (el) el.scrollTop = el.scrollHeight;
    stickToBottom.current = true;
    setUnseen(0);
  };

  const onNeed = (action: NeedAction, agentId: string) => {
    if (action === 'send it') onRelease?.(agentId);
    else if (action === 'start') void start([agentId]);
    else onOpenTerminal?.(agentId);
  };

  const renderItem = (item: ThreadItem) => {
    switch (item.kind) {
      case 'message': return <MessageRow key={item.id} item={item} />;
      case 'system': return <SystemRow key={item.id} item={item} />;
      case 'day': return <DayRow key={item.id} item={item} />;
      case 'notice': return <NoticeRow key={item.id} item={item} />;
    }
  };

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
        {head}
        <NeedsStrip rows={needs} onAction={onNeed} />
        <div
          ref={logRef}
          data-thread
          onScroll={() => {
            const el = logRef.current;
            if (!el) return;
            stickToBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 48;
            if (stickToBottom.current && unseen) setUnseen(0);
          }}
          className="flex-1 min-h-0 overflow-y-auto flex flex-col pt-2 pb-3"
        >
          {loading ? (
            <div className="flex-1 flex items-center justify-center">
              <BrandSpinner size={26} label="Reading the room" />
            </div>
          ) : items.length === 0 ? (
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
          ) : items.map(renderItem)}
        </div>
        {unseen > 0 && (
          <div className="h-10 shrink-0 flex items-center px-6 bg-secondary border-t border-border">
            <span className="w-12 shrink-0 flex items-center"><ArrowDown className="w-3 h-3 text-foreground" /></span>
            <span className="flex-1 min-w-0 text-[12px] leading-4 text-foreground">
              {unseen} new message{unseen === 1 ? '' : 's'} below
            </span>
            <Button size="sm" onClick={jumpToLatest}>jump to latest</Button>
          </div>
        )}
      </div>

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
