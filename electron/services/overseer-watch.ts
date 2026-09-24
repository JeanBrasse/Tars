import { usableHermesConnection } from './hermes-config';
import { setHermesModel } from './hermes-client';
import { agentStatusEmitter } from './agent-events';
import { recordRunEvents, type RunEvent } from './overseer-runs';
import { AUTO_ACTION_RULES } from './overseer-auto';
import {
  DEFAULT_WATCH_INTERVAL_MS,
  MIN_WATCH_INTERVAL_MS,
  MAX_WATCH_INTERVAL_MS,
  loadState,
  saveState,
  type OverseerMessage,
  type OverseerSettings,
} from './overseer-store';
import { buildFleetSnapshot, formatDuration, type FleetSnapshot } from './overseer-fleet';
import { askOverseer, isOverseerBusy } from './overseer-turn';

// ── The watch ─────────────────────────────────────────────────────────────

const LONG_RUNNING_MS = 20 * 60 * 1000;

/** What changed since the last snapshot, in one sentence, or null if nothing
 *  worth a briefing did. Mutates `longRunningReported` in place. */
function detectFleetChange(prev: FleetSnapshot | null, next: FleetSnapshot, longRunningReported: Set<string>): string | null {
  // No previous snapshot (first tick, or first tick after a restart): there
  // is nothing to diff against yet, so this tick can only ever be a false
  // "everything changed" - skip it rather than replaying the whole fleet.
  if (!prev) return null;

  const prevById = new Map(prev.agents.map(a => [a.id, a]));
  const notes: string[] = [];
  // Every transition seen here is also written to the run ledger, which is
  // what lets a later turn say "that is the third time" rather than only
  // "it is waiting". The diff already knows; it used to discard it.
  const observed: RunEvent[] = [];
  for (const a of next.agents) {
    const before = prevById.get(a.id);
    if (before && before.status !== a.status) {
      observed.push({
        at: Date.now(),
        agentId: a.id,
        agentName: a.name,
        project: a.projectPath,
        from: before.status,
        to: a.status,
        task: a.currentTask ? a.currentTask.slice(0, 120) : undefined,
      });
      // What is worth interrupting somebody for, and what is not.
      //
      // A finish is not. It is the expected end of work, it is the commonest
      // event by far once a fleet is thirty agents, and it is already
      // delivered straight to whoever dispatched that agent by
      // services/agent-watch.ts, so nobody learns anything from the Chat
      // announcing it a second time. Finishes are still recorded in the run
      // ledger below, so a later turn can still say "that is the third time",
      // they just do not start a turn of their own.
      //
      // Something that needs a person is: an agent waiting on an answer is
      // blocked until someone gives one, and an agent that errored has
      // stopped. Both are still here.
      if (a.status === 'error') notes.push(`"${a.name}" (${a.id}) errored in ${a.projectPath}`);
      else if (a.status === 'waiting') notes.push(`"${a.name}" (${a.id}) is now waiting for input in ${a.projectPath}`);
      if (a.status !== 'running') longRunningReported.delete(a.id);
    }
    if (a.status === 'running' && a.statusDurationMs > LONG_RUNNING_MS && !longRunningReported.has(a.id)) {
      notes.push(`"${a.name}" (${a.id}) has been running for ${formatDuration(a.statusDurationMs)} in ${a.projectPath}`);
      longRunningReported.add(a.id);
    }
  }
  recordRunEvents(observed);
  return notes.length ? notes.join('; ') : null;
}

/**
 * Build a snapshot, compare it with the last one, and only spend a Hermes
 * round trip when something actually changed. Returns the resulting briefing
 * message, or null when there was nothing to ask about (including: paused,
 * or a user turn is already in flight - the timer must never race a live
 * conversation for the one standing cron job).
 */
export async function watchTick(): Promise<OverseerMessage | null> {
  const state = loadState();
  if (state.paused || isOverseerBusy()) return null;

  const snapshot = await buildFleetSnapshot();
  const longRunningReported = new Set(state.longRunningReported);
  const reason = detectFleetChange(state.previousSnapshot, snapshot, longRunningReported);

  // Persisted every tick, changed or not, so a restart resumes the diff from
  // here instead of replaying every agent as "new" on the next tick.
  state.previousSnapshot = snapshot;
  state.longRunningReported = Array.from(longRunningReported);
  saveState(state);

  if (!reason) return null;

  const result = await askOverseer(`Fleet change since the last check: ${reason}.`, { isBriefing: true });
  if (!result.ok) {
    // A briefing has nobody waiting on it, so a refusal here used to be a
    // plain `null`: the five minute cycle failed over and over with nothing
    // to see, which is the same silent failure the API server had when its
    // port was taken. Recorded and logged, so the reason is answerable.
    lastWatchFailure = { reason: result.reason, error: result.error, at: new Date().toISOString() };
    console.warn(`[overseer] check-in produced no briefing (${result.reason}): ${result.error}`);
    return null;
  }
  lastWatchFailure = null;
  return result.message;
}

/** Why the last automatic check-in produced nothing, when it produced nothing.
 *  Cleared by the next one that succeeds. */
let lastWatchFailure: WatchFailure | null = null;

export interface WatchFailure {
  reason: string;
  error: string;
  /** ISO timestamp. */
  at: string;
}

export function getLastWatchFailure(): WatchFailure | null {
  return lastWatchFailure;
}

let watchTimer: ReturnType<typeof setInterval> | null = null;
/** Kept so a settings change can re-arm the timer at the new interval without
 *  the caller having to hand the callback in a second time. */
let watchCallback: ((message: OverseerMessage) => void) | null = null;

function clampInterval(ms: number): number {
  if (!Number.isFinite(ms)) return DEFAULT_WATCH_INTERVAL_MS;
  return Math.min(MAX_WATCH_INTERVAL_MS, Math.max(MIN_WATCH_INTERVAL_MS, Math.round(ms)));
}

/**
 * The shortest gap between two event-driven looks.
 *
 * A single piece of work moves an agent through running, waiting and running
 * again within seconds, and a fleet of six doing that at once is a burst. The
 * overseer should look once when the dust settles, not once per transition:
 * each turn is a real Hermes run and a real cost.
 */
const EVENT_SETTLE_MS = 8_000;
/** And never more often than this, however busy the fleet gets. */
const EVENT_FLOOR_MS = 45_000;

let settleTimer: ReturnType<typeof setTimeout> | null = null;
let lastEventLookAt = 0;
let onFleetChange: (() => void) | null = null;

export function startOverseerWatch(onBriefing: (message: OverseerMessage) => void, intervalMs?: number): void {
  if (watchTimer) return;
  watchCallback = onBriefing;
  const period = clampInterval(intervalMs ?? loadState().settings.watchIntervalMs);

  const look = () => {
    watchTick()
      .then(message => { if (message) onBriefing(message); })
      .catch(err => console.error('[overseer] watch tick failed:', err));
  };

  // The timer is the safety net now, not the mechanism: it catches anything
  // that changes without a status transition (a branch moving, a worktree
  // going dirty) and covers the case where nothing emits at all.
  watchTimer = setInterval(look, period);
  watchTimer.unref?.();

  // The mechanism: react when an agent actually moves. `fleet-change` is
  // emitted by emitAgentStatus for every status transition in the app.
  onFleetChange = () => {
    if (settleTimer) clearTimeout(settleTimer);
    settleTimer = setTimeout(() => {
      settleTimer = null;
      const since = Date.now() - lastEventLookAt;
      if (since < EVENT_FLOOR_MS) return;
      lastEventLookAt = Date.now();
      look();
    }, EVENT_SETTLE_MS);
    settleTimer.unref?.();
  };
  agentStatusEmitter.on('fleet-change', onFleetChange);
}

export function getOverseerSettings(): OverseerSettings {
  return loadState().settings;
}

/**
 * Persist a settings change and, if the interval moved, re-arm the timer so it
 * applies now rather than after the next restart.
 */
export async function applyOverseerModel(
  provider: string,
  model: string,
): Promise<{ success: boolean; error?: string }> {
  const conn = usableHermesConnection();
  if (!conn) return { success: false, error: 'Hermes is not configured.' };
  return setHermesModel(conn, { provider, model });
}

export function setOverseerSettings(patch: Partial<OverseerSettings>): OverseerSettings {
  const state = loadState();
  const next: OverseerSettings = {
    watchIntervalMs: clampInterval(patch.watchIntervalMs ?? state.settings.watchIntervalMs),
    model: patch.model ?? state.settings.model,
    provider: patch.provider ?? state.settings.provider,
    // Only ids of rules that exist: a stale id from an older build must not
    // sit in the list looking like something is authorised.
    autoActions: (patch.autoActions ?? state.settings.autoActions ?? [])
      .filter(id => AUTO_ACTION_RULES.some(r => r.id === id)),
  };
  const intervalChanged = next.watchIntervalMs !== state.settings.watchIntervalMs;
  state.settings = next;
  saveState(state);

  if (intervalChanged && watchTimer && watchCallback) {
    const cb = watchCallback;
    stopOverseerWatch();
    startOverseerWatch(cb, next.watchIntervalMs);
  }
  return next;
}

export function stopOverseerWatch(): void {
  if (watchTimer) clearInterval(watchTimer);
  watchTimer = null;
  if (settleTimer) clearTimeout(settleTimer);
  settleTimer = null;
  if (onFleetChange) agentStatusEmitter.off('fleet-change', onFleetChange);
  onFleetChange = null;
  // watchCallback is deliberately kept: setOverseerSettings re-arms through it.
}
