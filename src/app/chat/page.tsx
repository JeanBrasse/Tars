'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { AlertCircle } from 'lucide-react';
import { BrandSpinner, Button, PageHeader } from '@/components/ui';
import { MessageCard } from '@/components/Overseer/MessageCard';
import { FleetRail } from '@/components/Overseer/FleetRail';
import { Composer } from '@/components/Overseer/Composer';
import { WatchControls } from '@/components/Overseer/WatchControls';
import { describeHermesFailure } from '@/components/KanbanBoard/hermes-error';
import type { OverseerAction, OverseerFleetSnapshot, OverseerMessage, OverseerSettings } from '@/types/electron';

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
    <div className="border border-border bg-card px-3.5 py-3 flex items-center gap-3">
      <BrandSpinner size={16} label="Hermes is checking the fleet and composing a reply" />
      <p className="text-[11.5px] text-muted-foreground">
        Hermes is checking the fleet and composing a reply. This usually takes about 30 seconds
        {seconds > 0 && ` · ${seconds}s`}.
      </p>
    </div>
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

  const [gatewayState, setGatewayState] = useState<GatewayState>('checking');
  const [gatewayDetail, setGatewayDetail] = useState<string | null>(null);

  const [draft, setDraft] = useState('');
  const [sending, setSending] = useState(false);
  const [sendStartedAt, setSendStartedAt] = useState<number | null>(null);
  const [sendError, setSendError] = useState<{ message: string; detail: string | null } | null>(null);

  const [actionStates, setActionStates] = useState<Record<string, ActionState>>({});

  const threadRef = useRef<HTMLDivElement>(null);
  const autoScroll = useRef(true);

  const hasApi = typeof window !== 'undefined' && !!window.electronAPI?.overseer;

  const loadHistory = useCallback(async () => {
    const r = await window.electronAPI?.overseer?.history();
    setMessages(r?.messages ?? []);
    setHistoryLoading(false);
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

  const handleSend = async () => {
    const text = draft.trim();
    if (!text || sending) return;
    setDraft('');
    setSendError(null);
    setSending(true);
    setSendStartedAt(Date.now());
    try {
      const r = await window.electronAPI?.overseer?.send(text);
      if (!r) { setSendError({ message: 'Electron API unavailable.', detail: null }); setDraft(text); return; }
      if (!r.ok) {
        setSendError({ message: r.error, detail: null });
        setDraft(text); // give the words back so nothing typed is lost
        return;
      }
      await loadHistory();
      void loadFleet();
    } catch (err) {
      const raw = err instanceof Error ? err.message : String(err);
      const { message, detail } = describeHermesFailure(raw, null);
      setSendError({ message, detail });
      setDraft(text);
    } finally {
      setSending(false);
      setSendStartedAt(null);
    }
  };

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
  const composerDisabled = gatewayState !== 'ok' || sending;

  return (
    // The gateway state is probed over IPC, so the banner appears a beat after
    // the page does and moves everything under it. Published here so a test can
    // wait for the probe to land instead of photographing whichever frame it
    // happened to catch.
    <div className="h-[calc(100vh-7rem)] lg:h-[calc(100vh-44px)] flex flex-col" data-gateway-state={gatewayState}>
      <PageHeader
        title="Chat"
        subtitle="Hermes watches every project and answers for the fleet."
        actions={
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
        }
      />

      <div className="flex-1 min-h-0 flex gap-2.5">
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
              messages.map(m => (
                <MessageCard
                  key={m.id}
                  message={m}
                  fleet={fleet}
                  actionState={m.action ? actionStates[m.action.actionId] : undefined}
                  onCancelAction={handleCancelAction}
                  onSendAction={handleSendAction}
                />
              ))
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
            disabled={composerDisabled}
            controls={<WatchControls settings={settings} onChange={handleSettingsChange} />}
            placeholder={
              gatewayState === 'ok'
                ? 'Ask about any project, or tell Hermes what to do.'
                : 'Fix the Hermes connection above before Hermes can answer.'
            }
          />
        </div>

        <FleetRail fleet={fleet} />
      </div>
    </div>
  );
}
