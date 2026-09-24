'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { AlertCircle } from 'lucide-react';
import { BrandSpinner, PageHeader } from '@/components/ui';
import { ChatSidebar, ReachSection, TeamSection } from '@/components/Chat/ChatSidebar';
import type { ConversationItem } from '@/components/Chat/ChatSidebar';
import { RoomHead } from '@/components/Chat/RoomHead';
import { RoomView } from '@/components/Chat/RoomView';
import { EchoRunRow, HermesBanner, HermesMessageRow, HermesView, PendingTurnRow } from '@/components/Chat/HermesView';
import type { ActionState, GatewayState } from '@/components/Chat/HermesView';
import { currentThread } from '@/components/Chat/bus-view';
import { lastSpoke, needsRows, roomCounts, roomState, timeLabel } from '@/components/Chat/team-view';
import type { RoomState, RowActionId } from '@/components/Chat/team-view';
import { useBusRoom, useBusRooms } from '@/hooks/useBus';
import { useRoomAgents } from '@/hooks/useRoomAgents';
import type { RoomAgent } from '@/hooks/useRoomAgents';
import { useElectronAgents } from '@/hooks/useElectron';
import { useDesktopApi } from '@/hooks/useDesktopApi';
import { groupThread } from '@/components/Overseer/echo-runs';
import { Composer } from '@/components/Overseer/Composer';
import { WatchControls } from '@/components/Overseer/WatchControls';
import { describeHermesFailure } from '@/components/KanbanBoard/hermes-error';
import type { OverseerAction, OverseerAttachment, OverseerFleetSnapshot, OverseerMessage, OverseerSettings } from '@/types/electron';

/** A message on its way: typed, with whatever was staged beside it. Held
 *  together so a queued message keeps its own files. */
interface PendingMessage {
  text: string;
  attachments: OverseerAttachment[];
  /** When it was written, for its row's time. */
  at: string;
}

/**
 * Chat · Overseer.
 *
 * Hermes here is a client of Tars, not a Tars agent: it never touches a CLI
 * directly. `overseer.send()` drives one full round trip through Hermes and
 * takes on the order of 30 seconds (a prompt push, a trigger, then polling
 * for the run) - see electron/services/overseer.ts. The composer stays
 * disabled and says so for the whole wait, rather than spinning silently.
 *
 * The one thing this page must never do is let an approval reach a CLI on
 * its own: `ApprovalBlock` only ever calls back up here, and this page only
 * ever calls `overseer.confirmAction` with the exact action object handed
 * back by the backend - never a reconstructed one.
 */

/** The room id the contract gives the super chat. */
const GLOBAL_ID = 'global';


/** The composer's start and start all: the Dashboard's start, an empty prompt
 *  resuming the last session, one agent after another as that button runs one
 *  per click. A CLI still running in the terminal counts as started: nothing
 *  was typed into it, and nothing needed to be. */
async function startAgents(ids: string[]): Promise<Array<{ id: string; error: string }>> {
  const failed: Array<{ id: string; error: string }> = [];
  for (const id of ids) {
    try {
      const r = await window.electronAPI?.agent?.start({ id, prompt: '', options: { resume: true } });
      if (!r) failed.push({ id, error: 'the app did not answer' });
      else if (!r.success && !r.cliRunning) failed.push({ id, error: r.error ?? 'it did not start' });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      // IPC wraps the main-process message; keep only the part worth reading.
      failed.push({ id, error: message.replace(/^Error invoking remote method '[^']+':\s*(Error:\s*)?/, '') });
    }
  }
  return failed;
}

/**
 * The open room, right of the left column: its panel under its head, then the
 * composer. Frames: `Chat · A · Room · *`. The room's snapshot and agents come
 * from the page, which also draws the team in the left column from them.
 */
function ChatRoom({
  bus,
  agents,
  recipient,
  onRecipient,
  onOpenTerminal,
}: {
  bus: ReturnType<typeof useBusRoom>;
  agents: RoomAgent[];
  recipient: string;
  onRecipient: (id: string) => void;
  onOpenTerminal: () => void;
}) {
  const { snapshot, loading, error, post, stopThread, releaseHeld, stageFiles, sendNow } = bus;
  const thread = useMemo(() => currentThread(snapshot.threads), [snapshot.threads]);
  const state = useMemo(() => roomState(agents, thread, snapshot.messages), [agents, thread, snapshot.messages]);
  // The open anchor is what stop stops.
  const open = snapshot.threads.find(t => t.state === 'open') ?? null;

  if (!snapshot.room) {
    return (
      <div className="flex-1 min-w-0 flex items-center justify-center px-6">
        {loading ? (
          <BrandSpinner size={30} label="Opening the room" />
        ) : error ? (
          // A room that could not be read is not a room that is empty. Saying
          // "not available" for a bus that refused hides the refusal, which is
          // the one thing this page exists to stop doing.
          <p className="max-w-[440px] border border-danger/40 px-3 py-2 text-[11.5px] leading-[1.5] text-danger">
            This room could not be read. {error}
          </p>
        ) : (
          <p className="text-sm text-muted-foreground">This room is not available.</p>
        )}
      </div>
    );
  }

  const room = snapshot.room;
  return (
    <RoomView
      // One view per room: a draft, an unread count, or a view scrolled up in
      // one room is not carried into the next.
      key={room.id}
      room={room}
      threads={snapshot.threads}
      messages={snapshot.messages}
      deliveries={snapshot.deliveries}
      agents={agents}
      loading={loading}
      onPost={post}
      onStart={startAgents}
      onStage={stageFiles}
      onSendNow={sendNow}
      targetId={recipient}
      onTargetChange={onRecipient}
      onRelease={id => { void releaseHeld(id); }}
      onOpenTerminal={onOpenTerminal}
      head={(
        <RoomHead
          title={room.title}
          path={room.projectPath ? room.projectPath.replace(/^\/Users\/[^/]+/, '~') : undefined}
          state={state}
          onStop={open ? () => { void stopThread(open.id); } : undefined}
          stopTitle="Stop this exchange. Anything queued for it is cancelled."
        />
      )}
    />
  );
}

export default function ChatPage() {
  const [messages, setMessages] = useState<OverseerMessage[]>([]);
  const [historyLoading, setHistoryLoading] = useState(true);
  const [fleet, setFleet] = useState<OverseerFleetSnapshot | null>(null);
  const [paused, setPaused] = useState(false);
  const [pauseBusy, setPauseBusy] = useState(false);
  const [settings, setSettings] = useState<OverseerSettings | null>(null);
  const [settingsError, setSettingsError] = useState<string | null>(null);
  /** What you just sent, until the backend's own copy of it arrives. */
  const [pendingSend, setPendingSend] = useState<PendingMessage | null>(null);
  /** Written while a turn was in flight, waiting their turn. A queued message
   *  keeps its own files: they were staged for that message, not for whichever
   *  one happens to go next. */
  const [queued, setQueued] = useState<PendingMessage[]>([]);
  /** Uploaded and waiting to be named by the next message. */
  const [attachments, setAttachments] = useState<OverseerAttachment[]>([]);
  const [attaching, setAttaching] = useState(false);

  const [gatewayState, setGatewayState] = useState<GatewayState>('checking');
  const [gatewayDetail, setGatewayDetail] = useState<string | null>(null);

  const [draft, setDraft] = useState('');
  const [sending, setSending] = useState(false);
  const [sendStartedAt, setSendStartedAt] = useState<number | null>(null);
  const [sendError, setSendError] = useState<{ message: string; detail: string | null } | null>(null);
  /** Files that could not be picked or uploaded. Not a failed send: the
   *  message was never sent, so it has its own words in the composer. */
  const [attachError, setAttachError] = useState<string | null>(null);

  const [actionStates, setActionStates] = useState<Record<string, ActionState>>({});
  /** The runs of empty replies opened, by their key. */
  const [openEchoes, setOpenEchoes] = useState<Set<string>>(() => new Set());

  /** The global room is Hermes: the super chat that watches every project and
   *  is already what this page was. A project room is the other level. */
  const [selectedId, setSelectedId] = useState<string>(GLOBAL_ID);
  const { rooms, error: roomsError } = useBusRooms();
  const router = useRouter();

  // The open room's hooks live here, not in the room: the left column draws
  // its team from them. A null room reads as empty, so Hermes costs nothing.
  const roomId = selectedId !== GLOBAL_ID ? selectedId : null;
  const bus = useBusRoom(roomId);
  const roomAgents = useRoomAgents(bus.snapshot.members);
  const { agents: fleetAgents } = useElectronAgents();
  const [recipient, setRecipient] = useState('');
  useEffect(() => { setRecipient(''); }, [roomId]);

  const pending = useMemo(() => {
    const per: Record<string, { queued: number; held: number; notSent: number }> = {};
    for (const d of bus.snapshot.deliveries) {
      const row = per[d.targetAgentId] ?? { queued: 0, held: 0, notSent: 0 };
      if (d.state === 'queued') row.queued += 1;
      if (d.state === 'held') row.held += 1;
      if (d.state === 'not_sent') row.notSent += 1;
      per[d.targetAgentId] = row;
    }
    return per;
  }, [bus.snapshot.deliveries]);
  // What the open room's strip lists: its line in the list counts the same rows.
  const needs = useMemo(() => needsRows(roomAgents, bus.snapshot.deliveries), [roomAgents, bus.snapshot.deliveries]);
  const spoke = useMemo(() => lastSpoke(bus.snapshot.messages), [bus.snapshot.messages]);


  // False for the pre-render and for the hydration pass, true right after: see useDesktopApi.
  const hasApi = useDesktopApi(api => api.overseer);

  const loadHistory = useCallback(async () => {
    const r = await window.electronAPI?.overseer?.history();
    setMessages(r?.messages ?? []);
    setHistoryLoading(false);
    // The turn runs in the main process, so leaving this page does not stop
    // it and coming back should not pretend nothing is happening.
    if (r?.busy) {
      setSending(true);
      setSendStartedAt(prev => prev ?? Date.now());
    }
  }, []);

  const loadFleet = useCallback(async () => {
    const r = await window.electronAPI?.overseer?.fleet();
    if (r) setFleet(r);
  }, []);

  const checkGateway = useCallback(async () => {
    setGatewayState('checking');
    setGatewayDetail(null);
    try {
      const info = await window.electronAPI?.hermes?.getConnection();
      if (!info?.baseUrl) {
        setGatewayState('not_configured');
        return;
      }
      const test = await window.electronAPI?.hermes?.testConnection(info.connection);
      if (!test) { setGatewayState('unreachable'); return; }
      if (test.needsSignIn) { setGatewayState('needs_sign_in'); return; }
      if (!test.success) {
        setGatewayState('unreachable');
        setGatewayDetail(test.error ?? null);
        return;
      }
      setGatewayState('ok');
    } catch (err) {
      setGatewayState('unreachable');
      setGatewayDetail(err instanceof Error ? err.message : String(err));
    }
  }, []);

  const loadWatchStatus = useCallback(async () => {
    const r = await window.electronAPI?.overseer?.watchStatus();
    if (r) setPaused(r.paused);
  }, []);

  const loadSettings = useCallback(async () => {
    const r = await window.electronAPI?.overseer?.settings();
    if (r) setSettings(r);
  }, []);

  /** The main process clamps and returns the settings it actually stored, so
   *  the control shows what was saved rather than what was asked for. */
  const handleSettingsChange = useCallback(async (patch: Partial<OverseerSettings>) => {
    const r = await window.electronAPI?.overseer?.setSettings(patch);
    // The settings come back either way: the cadence is Tars's own and always
    // takes, while the model has to be accepted by the gateway. Showing the
    // stored value with the error is more honest than reverting the control.
    if (r) setSettings(r.settings);
    setSettingsError(r && !r.success ? (r.error ?? 'The gateway refused that model.') : null);
  }, []);

  useEffect(() => {
    if (!hasApi) return;
    void loadHistory();
    void loadFleet();
    void loadWatchStatus();
    void loadSettings();
    void checkGateway();
  }, [hasApi, loadHistory, loadFleet, loadWatchStatus, loadSettings, checkGateway]);

  const cadenceLabel = settings
    ? (settings.watchIntervalMs >= 3600000
        ? `every ${Math.round(settings.watchIntervalMs / 3600000)}h`
        : `every ${Math.round(settings.watchIntervalMs / 60000)} min`)
    : 'periodically';

  // Hermes's head says its watch, as a room's says the room's state. Frame:
  // `Chat · A · Hermes · states` > `THE WATCH`.
  const lastAnswer = useMemo(() => {
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i].role === 'overseer') return timeLabel(messages[i].timestamp);
    }
    return '';
  }, [messages]);
  const hermesHead: RoomState = gatewayState === 'ok' || gatewayState === 'checking'
    ? (paused
        ? { tone: 'hollow', word: 'paused', detail: 'no check-ins until you resume', relaying: false }
        : { tone: 'running', word: 'watching', detail: `checks in ${cadenceLabel}`, relaying: false })
    : { tone: 'error', word: 'not connected', detail: lastAnswer ? `last answer at ${lastAnswer}` : undefined, relaying: false };

  /**
   * The list on the left. A room's line is counted from the fleet the app
   * already reads (who needs you, who works, who is stopped) and its time is
   * the room's last message. What waits in a room you are not in needs the
   * bus's per-room figures, so queued and not sent are only given for the
   * open room.
   */
  const lastHermes = messages.length ? messages[messages.length - 1].timestamp : undefined;
  const hermesItem: ConversationItem = {
    id: GLOBAL_ID,
    name: 'Hermes',
    sub: 'overseer',
    tone: gatewayState === 'ok' || gatewayState === 'checking' ? (paused ? 'hollow' : 'running') : 'error',
    time: timeLabel(lastHermes),
    counts: [{
      label: gatewayState !== 'ok' && gatewayState !== 'checking'
        ? 'not connected'
        : sending ? 'answering you' : paused ? 'paused' : `watching, ${cadenceLabel}`,
      tone: gatewayState !== 'ok' && gatewayState !== 'checking' ? 'error' : undefined,
    }],
  };

  const roomItems: ConversationItem[] = useMemo(
    () => rooms
      .filter(room => room.kind !== 'global')
      .map(room => {
        const members = new Set(room.memberIds);
        const agentsHere = fleetAgents.filter(a => members.has(a.id));
        const open = room.id === roomId
          ? {
              queued: Object.values(pending).reduce((sum, p) => sum + p.queued, 0),
              needYou: needs.filter(n => n.tone !== 'error').length,
            }
          : undefined;
        // A room you are not in has the bus's own count of what is queued in
        // it (PR 169); who needs you there waits for its strip, when it opens.
        const { tone, counts } = roomCounts(agentsHere, open, room.pending?.queued ?? 0);
        const parts = (room.projectPath ?? '').split('/').filter(Boolean);
        return {
          id: room.id,
          name: room.title || parts[parts.length - 1] || room.id,
          tone,
          time: timeLabel(room.lastMessageAt),
          counts,
        };
      }),
    [rooms, fleetAgents, roomId, pending, needs],
  );

  const openRoom = bus.snapshot.room;
  const candidates = useMemo(
    () => (openRoom?.projectPath
      ? fleetAgents.filter(a => a.projectPath === openRoom.projectPath && !openRoom.memberIds.includes(a.id))
      : []),
    [fleetAgents, openRoom],
  );

  const onTeamAction = useCallback((action: RowActionId, agent: RoomAgent) => {
    switch (action) {
      // The terminal an agent lives in is the Dashboard's, so it opens there
      // rather than as a second one here.
      case 'open terminal': router.push('/'); break;
      case 'start': void startAgents([agent.id]); break;
      case 'write': setRecipient(agent.id); break;
      case 'send it': void bus.releaseHeld(agent.id); break;
      case 'stop': void window.electronAPI?.agent?.stop?.(agent.id); break;
      case 'remove from room':
        if (openRoom) void bus.setMembers(openRoom.memberIds.filter(id => id !== agent.id));
        break;
    }
  }, [router, bus, openRoom]);

  // The fleet listing is what the approval block's "still reachable" check
  // and the rail both read - keep it fresh while the page is open.
  useEffect(() => {
    if (!hasApi) return;
    const id = setInterval(() => {
      if (document.visibilityState === 'visible') void loadFleet();
    }, 15_000);
    return () => clearInterval(id);
  }, [hasApi, loadFleet]);

  // Unprompted briefings land here the moment the watch timer produces one.
  useEffect(() => {
    if (!hasApi || !window.electronAPI?.overseer?.onBriefing) return;
    return window.electronAPI.overseer.onBriefing((message) => {
      setMessages(prev => (prev.some(m => m.id === message.id) ? prev : [...prev, message]));
    });
  }, [hasApi]);

  const togglePause = async () => {
    setPauseBusy(true);
    try {
      const r = paused
        ? await window.electronAPI?.overseer?.resume()
        : await window.electronAPI?.overseer?.pause();
      if (r) setPaused(r.paused);
    } finally {
      setPauseBusy(false);
    }
  };

  /** Picks, uploads, and stages. All three happen in the main process, which
   *  is the only side with the file: the renderer never sees its bytes. */
  const handleAttach = async () => {
    setAttaching(true);
    setAttachError(null);
    try {
      const r = await window.electronAPI?.overseer?.attachFiles();
      if (!r) return;
      if (r.attachments.length) {
        // Keyed by path so picking the same file twice stages it once.
        setAttachments(prev => {
          const seen = new Set(prev.map(a => a.path));
          return [...prev, ...r.attachments.filter(a => !seen.has(a.path))];
        });
      }
      // An error alongside successful uploads is the partial case: some landed,
      // some did not, and the ones that did not are named.
      if (r.error) setAttachError(r.error);
    } catch (err) {
      setAttachError(err instanceof Error ? err.message : String(err));
    } finally {
      setAttaching(false);
    }
  };

  const handleSend = async () => {
    const text = draft.trim();
    const staged = attachments;
    // Files on their own are a message: "look at this" with the file attached.
    if (!text && staged.length === 0) return;
    // Typing while Hermes is answering used to be impossible: the box was
    // disabled for the whole thirty seconds. It queues instead, and the queue
    // drains as soon as the turn in flight finishes.
    if (sending) {
      setQueued(q => [...q, { text, attachments: staged, at: new Date().toISOString() }]);
      setDraft('');
      setAttachments([]);
      return;
    }
    setDraft('');
    setAttachments([]);
    setSendError(null);
    setAttachError(null);
    setSending(true);
    setSendStartedAt(Date.now());
    // Shown straight away. The backend only records the user's turn once the
    // whole round trip finishes, which takes about thirty seconds, so what you
    // had just typed simply was not on screen until Hermes answered.
    setPendingSend({ text, attachments: staged, at: new Date().toISOString() });
    const giveBack = () => { setDraft(text); setAttachments(staged); };
    try {
      const r = await window.electronAPI?.overseer?.send(text, staged);
      if (!r) { setSendError({ message: 'Electron API unavailable.', detail: null }); giveBack(); return; }
      if (!r.ok) {
        setSendError({ message: r.error, detail: null });
        giveBack(); // give the words and the files back so nothing is lost
        return;
      }
      await loadHistory();
      setPendingSend(null);
      void loadFleet();
    } catch (err) {
      const raw = err instanceof Error ? err.message : String(err);
      const { message, detail } = describeHermesFailure(raw, null);
      setSendError({ message, detail });
      giveBack();
    } finally {
      setSending(false);
      setSendStartedAt(null);
      setPendingSend(null);
    }
  };

  // One at a time, in the order they were written. The effect fires when
  // `sending` falls back to false, which is the moment the next one can go.
  useEffect(() => {
    if (sending || queued.length === 0) return;
    const [next, ...rest] = queued;
    setQueued(rest);
    setDraft(next.text);
    setAttachments(next.attachments);
    // Sent on the next tick so `draft` and the staged files are the queued
    // message's by the time handleSend reads them.
    const id = setTimeout(() => { void handleSend(); }, 0);
    return () => clearTimeout(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- handleSend is redefined every render; the queue is the trigger
  }, [sending, queued]);

  const handleCancelAction = async (actionId: string) => {
    const message = messages.find(m => m.action?.actionId === actionId);
    if (!message?.action) return;
    setActionStates(prev => ({ ...prev, [actionId]: { sending: false, resolved: null, error: null } }));
    const r = await window.electronAPI?.overseer?.confirmAction({ action: message.action, approve: false });
    const at = new Date().toISOString();
    setActionStates(prev => ({
      ...prev,
      [actionId]: r?.success
        ? { sending: false, resolved: 'cancelled', error: null, at }
        : { sending: false, resolved: null, error: r?.error ?? 'Could not cancel.', failedOn: 'cancel', at },
    }));
  };

  const handleSendAction = async (actionId: string) => {
    const message = messages.find(m => m.action?.actionId === actionId);
    if (!message?.action) return;
    setActionStates(prev => ({ ...prev, [actionId]: { sending: true, resolved: null, error: null } }));
    const action: OverseerAction = message.action;
    const r = await window.electronAPI?.overseer?.confirmAction({ action, approve: true });
    const at = new Date().toISOString();
    setActionStates(prev => ({
      ...prev,
      [actionId]: r?.success
        ? { sending: false, resolved: 'sent', error: null, at }
        : { sending: false, resolved: null, error: r?.error ?? 'Could not send.', failedOn: 'send', at },
    }));
    if (r?.success) void loadFleet();
  };

  if (!hasApi) {
    return (
      <div className="h-[calc(100vh-7rem)] lg:h-[calc(100vh-44px)] flex flex-col">
        <PageHeader title="Chat" subtitle="Hermes watches every project and answers for the fleet." />
        <div className="flex-1 flex items-center justify-center">
          <p className="text-sm text-muted-foreground">This page only works inside the Tars desktop app.</p>
        </div>
      </div>
    );
  }

  const agentCount = fleet?.agents.length ?? 0;

  return (
    // The gateway state is probed over IPC, so the banner appears a beat after
    // the page does and moves everything under it. Published here so a test can
    // wait for the probe to land instead of photographing whichever frame it
    // happened to catch.
    <div className="h-[calc(100vh-7rem)] lg:h-[calc(100vh-44px)] flex flex-col" data-gateway-state={gatewayState}>
      <PageHeader
        title="Chat"
        subtitle="Hermes watches every project. Each project has a room where its agents talk to each other and to you."
      />

      <div className="flex-1 min-h-0 flex gap-2.5">
        {/* Two levels in one page, not a replacement: the super chat that
            watches every project stays exactly what it was, and a room per
            project sits beside it. */}
        <ChatSidebar
          hermes={hermesItem}
          rooms={roomItems}
          selectedId={selectedId}
          onSelect={setSelectedId}
          roomsError={roomsError}
        >
          {roomId ? (
            <TeamSection
              project={openRoom?.title || 'this room'}
              agents={roomAgents}
              pending={pending}
              lastSpoke={spoke}
              candidates={candidates}
              onAction={onTeamAction}
              onAdd={id => { if (openRoom) void bus.setMembers([...openRoom.memberIds, id]); }}
              onNewAgent={() => router.push('/agents')}
            />
          ) : (
            <ReachSection />
          )}
        </ChatSidebar>

        {roomId ? (
          <ChatRoom
            bus={bus}
            agents={roomAgents}
            recipient={recipient}
            onRecipient={setRecipient}
            // The terminal an agent lives in is the Dashboard's.
            onOpenTerminal={() => router.push('/')}
          />
        ) : (
        <div className="flex-1 min-w-0 flex flex-col gap-2.5 min-h-0">
          <HermesView
            head={(
              <RoomHead
                title="Hermes"
                path="overseer"
                state={hermesHead}
                rules={false}
                action={gatewayState === 'ok' || gatewayState === 'checking'
                  ? {
                      label: paused ? 'resume' : 'pause',
                      title: paused ? 'Hermes checks in again on its own.' : 'Hermes stops checking in until you resume it.',
                      onClick: () => { void togglePause(); },
                      disabled: pauseBusy,
                    }
                  : undefined}
              />
            )}
            banner={<HermesBanner state={gatewayState} detail={gatewayDetail} onRetry={checkGateway} />}
            messageCount={messages.length + queued.length + (pendingSend ? 1 : 0)}
            rowCount={messages.length + queued.length + (pendingSend ? 1 : 0) + (sending ? 1 : 0)}
          >
            {historyLoading ? (
              <div className="flex-1 flex items-center justify-center">
                <BrandSpinner size={30} label="Loading the conversation" />
              </div>
            ) : messages.length === 0 && !pendingSend && queued.length === 0 && agentCount === 0 ? (
              <div className="flex-1 flex flex-col items-center justify-center gap-1.5 text-center px-6">
                <p className="text-sm text-foreground">Hermes has nothing to watch yet.</p>
                <p className="text-xs text-muted-foreground max-w-sm">
                  Start an agent from Agents or Kanban in any project, then come back - Hermes reports on
                  what it sees here.
                </p>
              </div>
            ) : messages.length === 0 && !pendingSend && queued.length === 0 ? (
              <div className="flex-1 flex flex-col items-center justify-center gap-1.5 text-center px-6">
                <p className="text-sm text-foreground">Nothing said yet.</p>
                <p className="text-xs text-muted-foreground max-w-sm">
                  Ask Hermes what the fleet is doing, or wait - it checks in on its own {cadenceLabel}.
                </p>
              </div>
            ) : (
              groupThread(messages).map(item => (
                item.kind === 'echo' ? (
                  <EchoRunRow
                    key={item.key}
                    count={item.messages.length}
                    open={openEchoes.has(item.key)}
                    onToggle={() => setOpenEchoes(prev => {
                      const next = new Set(prev);
                      if (next.has(item.key)) next.delete(item.key); else next.add(item.key);
                      return next;
                    })}
                  >
                    {item.messages.map(m => (
                      <HermesMessageRow
                        key={m.id}
                        message={m}
                        fleet={fleet}
                        actionState={m.action ? actionStates[m.action.actionId] : undefined}
                        onCancelAction={handleCancelAction}
                        onSendAction={handleSendAction}
                      />
                    ))}
                  </EchoRunRow>
                ) : (
                  <HermesMessageRow
                    key={item.message.id}
                    message={item.message}
                    fleet={fleet}
                    actionState={item.message.action ? actionStates[item.message.action.actionId] : undefined}
                    onCancelAction={handleCancelAction}
                    onSendAction={handleSendAction}
                  />
                )
              ))
            )}
            {pendingSend && (
              <HermesMessageRow
                message={{ role: 'user', text: pendingSend.text, timestamp: pendingSend.at, attachments: pendingSend.attachments }}
                fleet={fleet}
              />
            )}
            {sending && sendStartedAt && <PendingTurnRow startedAt={sendStartedAt} />}
            {queued.map((m, i) => (
              <HermesMessageRow
                key={`q-${i}`}
                message={{ role: 'user', text: m.text, timestamp: m.at, attachments: m.attachments }}
                fleet={fleet}
                queued
              />
            ))}
          </HermesView>

          {settingsError && (
            <div className="flex items-start gap-2 border border-warning/40 bg-card px-3 py-2 shrink-0">
              <AlertCircle className="w-3.5 h-3.5 text-warning shrink-0 mt-0.5" />
              <p className="text-[11.5px] text-muted-foreground flex-1">{settingsError}</p>
            </div>
          )}

          <Composer
            value={draft}
            onChange={setDraft}
            onSend={handleSend}
            // Only a broken gateway disables it now. A turn in flight does
            // not: what you write while Hermes is answering is queued.
            disabled={gatewayState !== 'ok'}
            busy={sending}
            // In the card now, as the room's is: the words and the files are
            // put back in it, so the line that says so sits with them.
            error={sendError ? (sendError.detail ? `${sendError.message} (${sendError.detail})` : sendError.message) : null}
            attachError={attachError}
            attachments={attachments}
            onAttach={handleAttach}
            onRemoveAttachment={p => setAttachments(prev => prev.filter(a => a.path !== p))}
            attaching={attaching}
            controls={<WatchControls settings={settings} onChange={handleSettingsChange} />}
            placeholder={
              gatewayState === 'ok'
                ? 'Ask about any project, or tell Hermes what to do.'
                : 'Fix the Hermes connection above before Hermes can answer.'
            }
          />
        </div>

        )}

      </div>
    </div>
  );
}
