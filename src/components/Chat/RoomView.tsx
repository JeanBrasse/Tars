'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { Paperclip } from 'lucide-react';
import { AttachmentTile, BrandSpinner, ImageTile } from '@/components/ui';
import type { BusAttachment, BusDelivery, BusMessage, BusRoom, BusThread } from '@/types/electron';
import type { RoomAgent } from '@/hooks/useRoomAgents';
import { DayRow, MessageRow, NewBelowBand, NoticeRow, SystemRow } from './RoomRow';
import { ConversationEmpty } from './ConversationEmpty';
import { useFollowBottom } from '@/hooks/useFollowBottom';
import { NeedsStrip } from './NeedsStrip';
import { RoomComposer } from './RoomComposer';
import type { ComposerFailure, ComposerTarget } from './RoomComposer';
import { agentStatusLabel, agentTone, needsRows } from './team-view';
import type { NeedAction } from './team-view';
import { currentThread, fileSize, threadItems } from './bus-view';
import type { ThreadAgent, ThreadItem } from './bus-view';

/**
 * One project's room: the log, what is still waiting under it, and the
 * composer. Frames: every `Chat · A · Room · *` page, down to the room with no
 * agents, the room where nothing is said yet, and the room the bus does not
 * answer for.
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
  onStage,
  onSendNow,
  head,
  targetId: controlledTarget,
  onTargetChange,
  onRelease,
  onOpenTerminal,
  onNewAgent,
  error,
  onRetry,
  rowFailure,
  onClearRowFailure,
}: {
  room: BusRoom;
  threads: BusThread[];
  messages: BusMessage[];
  deliveries: BusDelivery[];
  agents: RoomAgent[];
  loading: boolean;
  onPost: (text: string, mentions: string[], attachments?: string[]) => Promise<{ success: boolean; error?: string }>;
  /** Puts files where the room's agents can read them, for the message being
   *  written. What the room refused is named in `error`, the rest staged. */
  onStage?: (files: File[]) => Promise<{ success: boolean; attachments: BusAttachment[]; error?: string }>;
  /** Send now to one agent: its turn interrupted first when it is busy and
   *  Tars can interrupt it. */
  onSendNow?: (agentId: string, text: string, attachments?: string[]) => Promise<{ success: boolean; interrupted: boolean; messageId?: string; deliveries?: BusDelivery[]; error?: string }>;
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
  /** Sends what an agent holds unsent, oldest first, whatever it was refused for. */
  onRelease?: (agentId: string) => void;
  /** Where an agent's terminal is: the Dashboard's panel. */
  onOpenTerminal?: (agentId: string) => void;
  /** Where a new agent is made, from the room with none. */
  onNewAgent?: () => void;
  /** The room could not be read: what the bus said, and a way to try again. */
  error?: string | null;
  onRetry?: () => void;
  /** An action taken from a team row that failed: said on the line a failed
   *  start from here uses, until you act here again. */
  rowFailure?: ComposerFailure | null;
  onClearRowFailure?: () => void;
}) {
  const [draft, setDraft] = useState('');
  const [ownTarget, setOwnTarget] = useState('');
  const targetId = controlledTarget ?? ownTarget;
  const setTargetId = onTargetChange ?? setOwnTarget;
  const [sending, setSending] = useState(false);
  const [starting, setStarting] = useState(false);
  const [failure, setFailure] = useState<ComposerFailure | null>(null);
  /** Who send now went to without interrupting, until the next word or pick. */
  const [notInterrupted, setNotInterrupted] = useState<string | null>(null);
  /** Files staged for the message being written; an image keeps a local URL
   *  of the bytes it was picked with, for its tile. */
  const [staged, setStaged] = useState<Array<{ file: BusAttachment; preview?: string }>>([]);
  const [attaching, setAttaching] = useState(false);
  const [dragging, setDragging] = useState(false);
  const dragDepth = useRef(0);
  const picker = useRef<HTMLInputElement>(null);
  const previews = useRef<string[]>([]);


  const thread = useMemo(() => currentThread(threads), [threads]);
  // What the thread reads of the agents: their names, and what a queue for
  // each waits on. Keyed on those alone, so a tick that moved nothing the
  // thread shows builds no thread again (the Audit's early look at #165).
  const who = JSON.stringify(agents.map(a => [a.id, a.name ?? null, waitsOn(a) ?? null]));
  const threadAgents = useMemo<ThreadAgent[]>(
    () => (JSON.parse(who) as Array<[string, string | null, ThreadAgent['waitsOn'] | null]>).map(([id, name, on]) => ({
      id,
      name: name ?? undefined,
      ...(on ? { waitsOn: on } : {}),
    })),
    [who],
  );
  const items = useMemo(
    () => threadItems(messages, deliveries, threadAgents, thread),
    [messages, deliveries, threadAgents, thread],
  );
  const needs = useMemo(() => needsRows(agents, deliveries), [agents, deliveries]);
  const messageCount = messages.length;

  // The thread starts under the head and follows the newest message once it
  // is longer than the panel, unless you scrolled up to read.
  const { box, content, onScroll, unseen, jumpToLatest } = useFollowBottom(messageCount, items.length);

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
    canInterrupt: a.canInterrupt && !a.stopped,
    stopped: a.stopped,
    tone: agentTone(a),
    state: agentStatusLabel(a),
    detail: a.provider ?? 'claude',
  })), [agents]);

  // The local URLs die with the view, whatever was still staged in it.
  useEffect(() => () => { for (const url of previews.current) URL.revokeObjectURL(url); }, []);

  const clearStaged = () => {
    for (const { preview } of staged) if (preview) URL.revokeObjectURL(preview);
    setStaged([]);
  };

  const removeStaged = (id: string) => {
    const gone = staged.find(s => s.file.id === id);
    if (gone?.preview) URL.revokeObjectURL(gone.preview);
    setStaged(prev => prev.filter(s => s.file.id !== id));
  };

  const target = targetId ? targets.find(t => t.id === targetId) : undefined;
  // Files go where a message could: not into a room nobody here can read.
  const canAttach = !!onStage && targets.length > 0 && !targets.every(t => t.stopped) && !target?.stopped;

  const addFiles = async (files: File[]) => {
    if (!onStage || !canAttach || files.length === 0 || attaching) return;
    setAttaching(true);
    setFailure(f => (f?.kind === 'attach' ? null : f));
    const r = await onStage(files);
    setAttaching(false);
    // Each staged file finds the file it came from, by name and then by
    // order, for an image's tile: the bus makes a name safe to write, which
    // can change it.
    const unused = [...files];
    const added = r.attachments.map(file => {
      const at = unused.findIndex(f => f.name === file.name);
      const source = unused.splice(at >= 0 ? at : 0, 1)[0];
      const preview = file.isImage && source ? URL.createObjectURL(source) : undefined;
      if (preview) previews.current.push(preview);
      return { file, preview };
    });
    if (added.length) setStaged(prev => [...prev, ...added]);
    if (r.error) setFailure({ kind: 'attach', message: r.error });
  };

  const hasFiles = (e: React.DragEvent) => Array.from(e.dataTransfer.types).includes('Files');

  // Nothing here writes into a turn that is running: a message for a busy
  // agent is queued, and one for an agent whose CLI reports no turn end is
  // held until you send it on. The composer says which, before you send.
  const send = async () => {
    const text = draft.trim();
    const files = staged.map(s => s.file.id);
    if ((!text && !files.length) || sending) return;
    setSending(true);
    setFailure(null);
    onClearRowFailure?.();
    // An agent that has left the room since it was picked is shown as
    // Everyone, so the message goes to everyone rather than to a name that is
    // no longer here.
    const mentions = targetId && targets.some(t => t.id === targetId) ? [targetId] : [];
    const r = await onPost(text, mentions, files);
    setSending(false);
    // On a failure the words and the files stay where they were, which is
    // what the strip tells you: send again to retry.
    if (r.success) { setDraft(''); clearStaged(); }
    else setFailure({ kind: 'send', message: r.error ?? '' });
  };

  // Asked once in the strip before it is called: it stops the agent's turn.
  const sendNow = async () => {
    const text = draft.trim();
    const files = staged.map(s => s.file.id);
    if (!onSendNow || !target || (!text && !files.length) || sending) return;
    setSending(true);
    setFailure(null);
    onClearRowFailure?.();
    const r = await onSendNow(target.id, text, files);
    setSending(false);
    if (!r.success) { setFailure({ kind: 'send', message: r.error ?? '' }); return; }
    setDraft('');
    clearStaged();
    // Sent, but the turn went on: the message is in its queue like any other,
    // which the strip says rather than leaving it to look interrupted. A turn
    // that ended first took it at once, and its receipt says so.
    const row = r.deliveries?.find(d => d.messageId === r.messageId && d.targetAgentId === target.id);
    if (!r.interrupted && row?.state === 'queued') setNotInterrupted(target.label);
  };

  const start = async (ids: string[]) => {
    if (!onStart || starting) return;
    setStarting(true);
    setFailure(null);
    onClearRowFailure?.();
    const failed = await onStart(ids);
    setStarting(false);
    if (failed.length) {
      const names = failed.map(f => targets.find(t => t.id === f.id)?.label ?? f.id);
      setFailure({ kind: 'start', message: `Could not start ${names.join(', ')}: ${failed[0].error}` });
    }
  };

  return (
    // Files dropped anywhere in the room join the message being written: the
    // thread shows where they will land while they are over it.
    <div
      className="flex-1 min-w-0 flex flex-col gap-2.5 min-h-0"
      onDragEnter={e => {
        if (!hasFiles(e) || !canAttach) return;
        e.preventDefault();
        dragDepth.current += 1;
        setDragging(true);
      }}
      onDragOver={e => {
        if (!hasFiles(e) || !canAttach) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = 'copy';
      }}
      onDragLeave={e => {
        if (!hasFiles(e)) return;
        dragDepth.current = Math.max(0, dragDepth.current - 1);
        if (dragDepth.current === 0) setDragging(false);
      }}
      onDrop={e => {
        if (!hasFiles(e)) return;
        e.preventDefault();
        dragDepth.current = 0;
        setDragging(false);
        void addFiles(Array.from(e.dataTransfer.files));
      }}
    >
      <div data-room-panel className="flex-1 min-h-0 flex flex-col border border-border bg-card">
        {head}
        <NeedsStrip rows={needs} onAction={onNeed} />
        <div className="relative flex-1 min-h-0 flex flex-col">
          <div
            ref={box}
            data-thread
            // The hook e2e/chat-rooms-behaviour.spec.ts finds the thread by
            // (QA's test of #180).
            data-room-thread
            onScroll={onScroll}
            className="flex-1 min-h-0 overflow-y-auto flex flex-col"
          >
            {/* The content in a box of its own, so its growth can be observed:
                the scrolling box above keeps its own size whatever it holds. */}
            <div ref={content} className="flex-1 flex flex-col pt-2 pb-3">
              {loading ? (
                <div className="flex-1 flex items-center justify-center">
                  <BrandSpinner size={26} label="Reading the room" />
                </div>
              ) : error || items.length === 0 ? (
                <div className="flex-1 flex flex-col items-center justify-center px-6">
                  {error ? (
                    // A room that could not be read is not a room that is
                    // empty: the refusal is the one thing to say.
                    <ConversationEmpty
                      error
                      title="Tars could not read this room."
                      detail={error}
                      action={onRetry ? { label: 'retry', onClick: onRetry } : undefined}
                    />
                  ) : agents.length === 0 ? (
                    <ConversationEmpty
                      title="Nobody in this room yet"
                      line="A room is the agents of one project talking to each other and to you. Add one and it joins the moment it starts."
                      action={onNewAgent ? { label: 'new agent', onClick: onNewAgent } : undefined}
                    />
                  ) : (
                    <ConversationEmpty
                      title="Nothing said yet"
                      line="Agents speak when they are named or when they hand back a job. Write to the room to start one."
                    />
                  )}
                </div>
              ) : items.map(renderItem)}
            </div>
          </div>
          {dragging && (
            // Frame: `Chat · A · Composer · states` > `FILES OVER THE THREAD`.
            <div className="absolute inset-0 p-3 pointer-events-none">
              <div className="h-full flex flex-col items-center justify-center gap-2 rounded border border-border-accent bg-secondary">
                <Paperclip className="w-5 h-5 text-foreground" />
                <p className="text-[14px] leading-5 text-foreground">Drop to attach to your message</p>
                <p className="text-[12px] leading-4 text-text-secondary">images and files, anywhere on the thread</p>
              </div>
            </div>
          )}
        </div>
        <NewBelowBand count={unseen} onJump={jumpToLatest} />
      </div>

      <RoomComposer
        value={draft}
        onChange={v => { setDraft(v); setNotInterrupted(null); }}
        onSend={() => { setNotInterrupted(null); void send(); }}
        targets={targets}
        targetId={targetId}
        onTargetChange={id => { setTargetId(id); setNotInterrupted(null); }}
        notInterrupted={notInterrupted}
        roomTitle={room.title}
        sending={sending}
        failure={failure ?? rowFailure ?? null}
        unreachable={!!error}
        onStart={onStart ? ids => { void start(ids); } : undefined}
        starting={starting}
        onSendNow={onSendNow ? () => { void sendNow(); } : undefined}
        hasFiles={staged.length > 0}
        attaching={attaching}
        onAttach={onStage ? () => picker.current?.click() : undefined}
        onPasteFiles={onStage ? files => { void addFiles(files); } : undefined}
        attachments={staged.length ? (
          <div className="flex flex-wrap gap-2">
            {staged.map(({ file, preview }) => preview ? (
              <ImageTile key={file.id} src={preview} name={file.name} title={file.path} onRemove={() => removeStaged(file.id)} />
            ) : (
              <AttachmentTile
                key={file.id}
                name={file.name}
                meta={`${kindOf(file.name)} · ${fileSize(file.bytes)}`}
                isImage={file.isImage}
                // Where the agents will read it: worth reading, too long for the tile.
                title={file.path}
                onRemove={() => removeStaged(file.id)}
              />
            ))}
          </div>
        ) : undefined}
      />
      <input
        ref={picker}
        type="file"
        multiple
        hidden
        onChange={e => {
          const files = Array.from(e.target.files ?? []);
          // Cleared, so picking the same file again is a change.
          e.target.value = '';
          void addFiles(files);
        }}
      />
    </div>
  );
}

/** What a message queued for an agent waits on, when not the end of a turn:
 *  a launch on its way, or a dialog only a person answers (#172). */
function waitsOn(agent: RoomAgent): ThreadAgent['waitsOn'] {
  if (agent.launching) return 'start';
  return agent.status === 'waiting' && agent.waitingOn ? 'dialog' : undefined;
}

/** A file's kind in its tile, as the frame writes it: its extension. */
function kindOf(name: string): string {
  const dot = name.lastIndexOf('.');
  return dot > 0 && dot < name.length - 1 ? name.slice(dot + 1).toLowerCase() : 'file';
}
