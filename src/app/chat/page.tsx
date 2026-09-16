'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { AlertCircle } from 'lucide-react';
import { BrandSpinner, Button, PageHeader } from '@/components/ui';
import { ConversationList } from '@/components/Chat/ConversationList';
import type { ConversationSummary } from '@/components/Chat/ConversationList';
import { RoomView } from '@/components/Chat/RoomView';
import { TeamRail } from '@/components/Chat/TeamRail';
import { useBusRoom, useBusRooms } from '@/hooks/useBus';
import { useRoomAgents } from '@/hooks/useRoomAgents';
import { MessageCard } from '@/components/Overseer/MessageCard';
import { EchoRun } from '@/components/Overseer/EchoRun';
import { groupThread } from '@/components/Overseer/echo-runs';
import { FleetRail } from '@/components/Overseer/FleetRail';
import { Composer } from '@/components/Overseer/Composer';
import { AttachmentChips } from '@/components/Overseer/AttachmentChips';
import { WatchControls } from '@/components/Overseer/WatchControls';
import { describeHermesFailure } from '@/components/KanbanBoard/hermes-error';
import type { OverseerAction, OverseerAttachment, OverseerFleetSnapshot, OverseerMessage, OverseerSettings } from '@/types/electron';

/** A message on its way: typed, with whatever was staged beside it. Held
 *  together so a queued message keeps its own files. */
interface PendingMessage {
  text: string;
  attachments: OverseerAttachment[];
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

type GatewayState = 'checking' | 'ok' | 'not_configured' | 'needs_sign_in' | 'unreachable';

/** The room id the contract gives the super chat. */
const GLOBAL_ID = 'global';

interface ActionState {
  sending: boolean;
  resolved: 'sent' | 'cancelled' | null;
  error: string | null;
}


function GatewayBanner({ state, detail, onRetry }: { state: GatewayState; detail: string | null; onRetry: () => void }) {
  if (state === 'ok' || state === 'checking') return null;
  const copy: Record<Exclude<GatewayState, 'ok' | 'checking'>, { message: string; cta: string }> = {
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
  const { message, cta } = copy[state];
  return (
    <div className="flex items-start gap-2.5 border border-border bg-card px-3.5 py-3 mb-2.5 shrink-0">
      <AlertCircle className="w-4 h-4 text-warning shrink-0 mt-0.5" />
      <div className="flex-1 min-w-0">
        <p className="text-xs text-foreground">{message}</p>
        {detail && <p className="mt-1 text-[10.5px] font-mono text-muted-foreground break-all">{detail}</p>}
      </div>
      <div className="flex items-center gap-2 shrink-0">
        <Link
          href="/settings?section=hermes"
          className="inline-flex items-center justify-center h-[26px] px-2.5 text-xs font-medium border border-primary bg-primary text-primary-foreground hover:bg-primary/90"
        >
          {cta}
        </Link>
        <Button size="sm" onClick={onRetry}>Retry</Button>
      </div>
    </div>
  );
}

function PendingTurn({ startedAt }: { startedAt: number }) {
  const [seconds, setSeconds] = useState(() => Math.round((Date.now() - startedAt) / 1000));
  useEffect(() => {
    const id = setInterval(() => setSeconds(Math.round((Date.now() - startedAt) / 1000)), 1000);
    return () => clearInterval(id);
  }, [startedAt]);
  return (
    <div className="border border-border bg-card px-3.5 py-3 flex items-center gap-3.5">
      {/* 16px put the 4x4 mark's cells under four pixels each with sub-pixel
          gaps, so the travelling square read as a smudge rather than the mark.
          26 is the smallest size the grid stays legible at. */}
      <BrandSpinner size={26} label="Hermes is checking the fleet and composing a reply" />
      <p className="text-[11.5px] text-muted-foreground">
        Hermes is checking the fleet and composing a reply. This usually takes about 30 seconds
        {seconds > 0 && ` · ${seconds}s`}.
      </p>
    </div>
  );
}

/**
 * One project's room, with its own hooks.
 *
 * A sub-component rather than a branch inside the page: the room's snapshot,
 * its agents and its live subscriptions are hooks, and hooks cannot be called
 * only when a room happens to be selected.
 */
function ChatRoom({ roomId, onHeader }: { roomId: string; onHeader: (node: React.ReactNode) => void }) {
  const router = useRouter();
  const { snapshot, loading, error, post, stopThread } = useBusRoom(roomId);
  const agents = useRoomAgents(snapshot.members);
  const pending = useMemo(() => {
    const per: Record<string, { queued: number; notSent: number }> = {};
    for (const d of snapshot.deliveries) {
      const row = per[d.targetAgentId] ?? { queued: 0, notSent: 0 };
      if (d.state === 'queued') row.queued += 1;
      if (d.state === 'not_sent') row.notSent += 1;
      per[d.targetAgentId] = row;
    }
    return per;
  }, [snapshot.deliveries]);

  // The open anchor is what Stop stops. Published to the page's header so the
  // action sits with the room's state rather than inside the log.
  const open = snapshot.threads.find(t => t.state === 'open') ?? null;

  // The header needs one number out of the fleet, so it depends on that number
  // and not on the list it came from. The fleet list is re-read on every status
  // tick, and republishing the header each time is work nobody asked for even
  // when the count has not moved.
  const running = useMemo(() => agents.filter(a => a.status === 'running').length, [agents]);

  useEffect(() => {
    onHeader(
      <>
        <div className="h-8 flex items-center gap-1.5 border border-border px-2.5">
          <span className={`w-1.5 h-1.5 shrink-0 ${running ? 'bg-status-running' : 'bg-status-idle'}`} />
          <span className="font-mono text-[10.5px] text-muted-foreground">
            {running ? 'relaying' : open ? 'open' : 'quiet'}
          </span>
        </div>
        <Button
          className="font-mono"
          disabled={!open}
          title={open ? 'Stop this exchange. Anything queued for it is cancelled.' : 'Nothing is running in this room.'}
          onClick={() => { if (open) void stopThread(open.id); }}
        >
          stop
        </Button>
      </>,
    );
  }, [running, open, onHeader, stopThread]);

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

  return (
    <>
      <RoomView
        room={snapshot.room}
        threads={snapshot.threads}
        messages={snapshot.messages}
        deliveries={snapshot.deliveries}
        agents={agents}
        loading={loading}
        onPost={post}
      />
      <TeamRail
        agents={agents}
        pending={pending}
        // The terminal an agent lives in is the Dashboard's, so `open` goes
        // there rather than opening a second one here.
        onOpen={() => router.push('/')}
        onStop={agent => { void window.electronAPI?.agent?.stop?.(agent.id); }}
        // Disabled in the rail itself: the bus has no release call yet.
        onSend={() => {}}
        onAdd={() => router.push('/agents')}
      />
    </>
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

  const [actionStates, setActionStates] = useState<Record<string, ActionState>>({});

  /** The global room is Hermes: the super chat that watches every project and
   *  is already what this page was. A project room is the other level. */
  const [selectedId, setSelectedId] = useState<string>(GLOBAL_ID);
  const [roomHeader, setRoomHeader] = useState<React.ReactNode>(null);
  const { rooms, error: roomsError } = useBusRooms();

  const threadRef = useRef<HTMLDivElement>(null);
  const autoScroll = useRef(true);

  const hasApi = typeof window !== 'undefined' && !!window.electronAPI?.overseer;

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

  /**
   * The list on the left. What it shows per room is what the bus actually
   * carries: `listRooms` gives a title, a project and a membership, and no
   * last message, unread count or activity. Those are not guessed here, so a
   * room's line says what it is rather than inventing what happened in it.
   */
  const globalSummary: ConversationSummary = {
    id: GLOBAL_ID,
    name: 'Hermes',
    sub: 'overseer',
    tone: paused ? 'idle' : 'running',
    time: '',
    preview: paused ? 'Watching is paused.' : `Watching every project, ${cadenceLabel}.`,
    counts: [{ label: `${fleet?.agents.length ?? 0} agents` }],
  };

  const roomSummaries: ConversationSummary[] = useMemo(
    () => rooms
      .filter(room => room.kind !== 'global')
      .map(room => {
        const parts = (room.projectPath ?? '').split('/').filter(Boolean);
        const members = room.memberIds.length;

        // A square that always said idle was an assertion the room list cannot
        // support: listRooms carries membership, not activity, so a room whose
        // agents were all working still read as quiet. The fleet listing is
        // where activity lives, and when a member is missing from it, which the
        // snapshot admits by truncating, no square at all beats claiming calm.
        const states = room.memberIds.map(id => fleet?.agents.find(a => a.id === id)?.status);
        const allKnown = states.every(s => s !== undefined);
        const tone: ConversationSummary['tone'] = !members || !allKnown
          ? 'none'
          : states.some(s => s === 'running')
            ? 'running'
            : 'idle';

        return {
          id: room.id,
          name: room.title || parts[parts.length - 1] || room.id,
          tone,
          time: '',
          preview: members
            ? 'Open the room to see what its agents are saying.'
            : 'No agents in this project yet',
          counts: [{ label: members ? `${members} ${members === 1 ? 'member' : 'members'}` : 'no agents' }],
        };
      }),
    [rooms, fleet],
  );

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

  useEffect(() => {
    if (!threadRef.current || !autoScroll.current) return;
    threadRef.current.scrollTop = threadRef.current.scrollHeight;
  }, [messages, sending]);

  const handleThreadScroll = () => {
    const el = threadRef.current;
    if (!el) return;
    autoScroll.current = el.scrollHeight - el.scrollTop - el.clientHeight < 48;
  };

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
    setSendError(null);
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
      if (r.error) setSendError({ message: r.error, detail: null });
    } catch (err) {
      setSendError({ message: err instanceof Error ? err.message : String(err), detail: null });
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
      setQueued(q => [...q, { text, attachments: staged }]);
      setDraft('');
      setAttachments([]);
      return;
    }
    setDraft('');
    setAttachments([]);
    setSendError(null);
    setSending(true);
    setSendStartedAt(Date.now());
    // Shown straight away. The backend only records the user's turn once the
    // whole round trip finishes, which takes about thirty seconds, so what you
    // had just typed simply was not on screen until Hermes answered.
    setPendingSend({ text, attachments: staged });
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
    setActionStates(prev => ({
      ...prev,
      [actionId]: { sending: false, resolved: r?.success ? 'cancelled' : null, error: r?.success ? null : (r?.error ?? 'Could not cancel.') },
    }));
  };

  const handleSendAction = async (actionId: string) => {
    const message = messages.find(m => m.action?.actionId === actionId);
    if (!message?.action) return;
    setActionStates(prev => ({ ...prev, [actionId]: { sending: true, resolved: null, error: null } }));
    const action: OverseerAction = message.action;
    const r = await window.electronAPI?.overseer?.confirmAction({ action, approve: true });
    setActionStates(prev => ({
      ...prev,
      [actionId]: r?.success
        ? { sending: false, resolved: 'sent', error: null }
        : { sending: false, resolved: null, error: r?.error ?? 'Could not send.' },
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
        actions={selectedId !== GLOBAL_ID ? roomHeader : (
          <>
            <div className="h-8 flex items-center gap-1.5 border border-border px-2.5">
              <span className={`w-1.5 h-1.5 shrink-0 ${paused ? 'bg-status-idle' : 'bg-status-running'}`} />
              <span className="font-mono text-[10.5px] text-muted-foreground">
                {paused ? 'paused' : 'watching'}
              </span>
            </div>
            <Button className="font-mono" onClick={togglePause} disabled={pauseBusy}>
              {paused ? 'resume' : 'pause'}
            </Button>
          </>
        )}
      />

      <div className="flex-1 min-h-0 flex gap-2.5">
        {/* Two levels in one page, not a replacement: the super chat that
            watches every project stays exactly what it was, and a room per
            project sits beside it. */}
        <ConversationList
          global={globalSummary}
          rooms={roomSummaries}
          selectedId={selectedId}
          onSelect={setSelectedId}
          error={roomsError}
        />

        {selectedId !== GLOBAL_ID ? (
          <ChatRoom roomId={selectedId} onHeader={setRoomHeader} />
        ) : (
        <>
        {/* No max width: the rail is a fixed 332 and the frame's 830 is simply
            what is left beside it at 1440. Capping the conversation as well
            left a hole between the two on any wider window, so the rail
            stopped meeting the right edge the header still reached. */}
        <div className="flex-1 min-w-0 flex flex-col gap-2.5 min-h-0">
          <GatewayBanner state={gatewayState} detail={gatewayDetail} onRetry={checkGateway} />

          <div ref={threadRef} onScroll={handleThreadScroll} className="flex-1 min-h-0 overflow-y-auto flex flex-col gap-2.5">
            {historyLoading ? (
              <div className="flex-1 flex items-center justify-center">
                <BrandSpinner size={30} label="Loading the conversation" />
              </div>
            ) : messages.length === 0 && agentCount === 0 ? (
              <div className="flex-1 flex flex-col items-center justify-center gap-1.5 text-center px-6">
                <p className="text-sm text-foreground">Hermes has nothing to watch yet.</p>
                <p className="text-xs text-muted-foreground max-w-sm">
                  Start an agent from Agents or Kanban in any project, then come back - Hermes reports on
                  what it sees here.
                </p>
              </div>
            ) : messages.length === 0 ? (
              <div className="flex-1 flex flex-col items-center justify-center gap-1.5 text-center px-6">
                <p className="text-sm text-foreground">Nothing said yet.</p>
                <p className="text-xs text-muted-foreground max-w-sm">
                  Ask Hermes what the fleet is doing, or wait - it checks in on its own {cadenceLabel}.
                </p>
              </div>
            ) : (
              groupThread(messages).map(item => (
                item.kind === 'echo' ? (
                  <EchoRun
                    key={item.key}
                    messages={item.messages}
                    fleet={fleet}
                    actionStates={actionStates}
                    onCancelAction={handleCancelAction}
                    onSendAction={handleSendAction}
                  />
                ) : (
                  <MessageCard
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
            {queued.map((m, i) => (
              <div key={`q-${i}`} className="border border-border bg-card px-3.5 py-3 opacity-60">
                <p className="font-mono text-[10.5px] text-muted-foreground mb-1.5">you · queued</p>
                {m.text && (
                  <p className="text-[12.5px] leading-relaxed text-foreground whitespace-pre-wrap break-words">
                    {m.text}
                  </p>
                )}
                <AttachmentChips attachments={m.attachments} />
              </div>
            ))}
            {pendingSend && (
              <div className="border border-border bg-card px-3.5 py-3">
                <p className="font-mono text-[10.5px] text-muted-foreground mb-1.5">you</p>
                {pendingSend.text && (
                  <p className="text-[12.5px] leading-relaxed text-foreground whitespace-pre-wrap break-words">
                    {pendingSend.text}
                  </p>
                )}
                <AttachmentChips attachments={pendingSend.attachments} />
              </div>
            )}
            {sending && sendStartedAt && <PendingTurn startedAt={sendStartedAt} />}
          </div>

          {settingsError && (
            <div className="flex items-start gap-2 border border-warning/40 bg-card px-3 py-2 shrink-0">
              <AlertCircle className="w-3.5 h-3.5 text-warning shrink-0 mt-0.5" />
              <p className="text-[11.5px] text-muted-foreground flex-1">{settingsError}</p>
            </div>
          )}

          {sendError && (
            <div className="flex items-start gap-2 border border-danger/40 bg-card px-3 py-2 shrink-0">
              <AlertCircle className="w-3.5 h-3.5 text-danger shrink-0 mt-0.5" />
              <p className="text-[11.5px] text-danger flex-1">{sendError.message}</p>
              {sendError.detail && <p className="text-[10px] font-mono text-muted-foreground">{sendError.detail}</p>}
            </div>
          )}

          <Composer
            value={draft}
            onChange={setDraft}
            onSend={handleSend}
            // Only a broken gateway disables it now. A turn in flight does
            // not: what you write while Hermes is answering is queued.
            disabled={gatewayState !== 'ok'}
            sendLabel={sending ? 'queue' : 'send'}
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

        <FleetRail fleet={fleet} />
        </>
        )}
      </div>
    </div>
  );
}
