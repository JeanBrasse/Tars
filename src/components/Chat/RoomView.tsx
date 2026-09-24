'use client';

import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { ArrowDown, Paperclip } from 'lucide-react';
import { AttachmentTile, BrandSpinner, Button, ImageTile } from '@/components/ui';
import type { BusAttachment, BusDelivery, BusMessage, BusRoom, BusThread } from '@/types/electron';
import type { RoomAgent } from '@/hooks/useRoomAgents';
import { DayRow, MessageRow, NoticeRow, SystemRow } from './RoomRow';
import { NeedsStrip } from './NeedsStrip';
import { RoomComposer } from './RoomComposer';
import type { ComposerFailure, ComposerTarget } from './RoomComposer';
import { agentStatusLabel, agentTone, needsRows } from './team-view';
import type { NeedAction } from './team-view';
import { currentThread, fileSize, threadItems } from './bus-view';
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
  onStage,
  onSendNow,
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
  onPost: (text: string, mentions: string[], attachments?: string[]) => Promise<{ success: boolean; error?: string }>;
  /** Puts files where the room's agents can read them, for the message being
   *  written. What the room refused is named in `error`, the rest staged. */
  onStage?: (files: File[]) => Promise<{ success: boolean; attachments: BusAttachment[]; error?: string }>;
  /** Send now to one agent: its turn interrupted first when it is busy and
   *  Tars can interrupt it. */
  onSendNow?: (agentId: string, text: string, attachments?: string[]) => Promise<{ success: boolean; interrupted: boolean; error?: string }>;
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
}) {
  const [draft, setDraft] = useState('');
  const [ownTarget, setOwnTarget] = useState('');
  const targetId = controlledTarget ?? ownTarget;
  const setTargetId = onTargetChange ?? setOwnTarget;
  const [sending, setSending] = useState(false);
  const [starting, setStarting] = useState(false);
  const [failure, setFailure] = useState<ComposerFailure | null>(null);
  /** Files staged for the message being written; an image keeps a local URL
   *  of the bytes it was picked with, for its tile. */
  const [staged, setStaged] = useState<Array<{ file: BusAttachment; preview?: string }>>([]);
  const [attaching, setAttaching] = useState(false);
  const [dragging, setDragging] = useState(false);
  const dragDepth = useRef(0);
  const picker = useRef<HTMLInputElement>(null);
  const previews = useRef<string[]>([]);

  const logRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const stickToBottom = useRef(true);
  /** Where the last scroll left the view, to tell a move up from a resize. */
  const lastTop = useRef(0);
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
  //
  // A layout effect, before the browser paints and scrolls: a thread that
  // first spans two days gains a day line at its top, the browser's scroll
  // anchoring moves the view to keep its place, and the scroll event that
  // follows used to find the view off the bottom and stop following it.
  useLayoutEffect(() => {
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

  // A new message is not the only thing that moves the bottom. A receipt
  // arrives under your line after the line itself, the strip above gains a
  // row, the window is resized: while you are at the bottom, any change to
  // the thread's height or to its content's keeps you there.
  useEffect(() => {
    const el = logRef.current;
    const content = contentRef.current;
    if (!el || !content || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(() => {
      if (stickToBottom.current) el.scrollTop = el.scrollHeight;
    });
    observer.observe(el);
    observer.observe(content);
    return () => observer.disconnect();
  }, []);

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
    const r = await onSendNow(target.id, text, files);
    setSending(false);
    if (r.success) { setDraft(''); clearStaged(); }
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
            ref={logRef}
            data-thread
            // The hook e2e/chat-rooms-behaviour.spec.ts finds the thread by
            // (QA's test of #180).
            data-room-thread
            onScroll={() => {
              const el = logRef.current;
              if (!el) return;
              // Only you moving the view up stops the following. The view also
              // scrolls when the thread changes size under it, and a scroll
              // event that lands after the next change of size finds it off the
              // bottom through no move of yours.
              if (el.scrollHeight - el.scrollTop - el.clientHeight < 48) stickToBottom.current = true;
              else if (el.scrollTop < lastTop.current) stickToBottom.current = false;
              lastTop.current = el.scrollTop;
              if (stickToBottom.current && unseen) setUnseen(0);
            }}
            className="flex-1 min-h-0 overflow-y-auto flex flex-col"
          >
            {/* The content in a box of its own, so its growth can be observed:
                the scrolling box above keeps its own size whatever it holds. */}
            <div ref={contentRef} className="flex-1 flex flex-col pt-2 pb-3">
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

/** A file's kind in its tile, as the frame writes it: its extension. */
function kindOf(name: string): string {
  const dot = name.lastIndexOf('.');
  return dot > 0 && dot < name.length - 1 ? name.slice(dot + 1).toLowerCase() : 'file';
}
