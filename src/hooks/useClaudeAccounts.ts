'use client';

import { useEffect, useState } from 'react';
import type { ClaudeAccountsResult, ClaudeAccountsView, ClaudeAccountId } from '@/types/electron';

/**
 * The Claude accounts as main sees them (#263, DESIGN-COMPTES-CLAUDE.md B6),
 * one copy for the whole window: Settings and every agent's account control
 * read the same view. Main is asked once, then says what changes through
 * `claude-accounts:changed`, so the cards of a large fleet do not each ask.
 */
interface Snapshot {
  view: ClaudeAccountsView | null;
  /** The sentence of the last channel that failed, cleared by the next that works. */
  error: string | null;
  loading: boolean;
}

let snapshot: Snapshot = { view: null, error: null, loading: true };
const listeners = new Set<() => void>();

function publish(next: Partial<Snapshot>) {
  snapshot = { ...snapshot, ...next };
  for (const listener of listeners) listener();
}

type Bridge = NonNullable<NonNullable<Window['electronAPI']>['claudeAccounts']>;
const api = (): Bridge | undefined => (typeof window === 'undefined' ? undefined : window.electronAPI?.claudeAccounts);
const asView = (r: ClaudeAccountsView) => ({ settings: r.settings, accounts: r.accounts });
const sentence = (e: unknown) => (e instanceof Error ? e.message : String(e));

// The bridge the store was started on. Another one (a reloaded page, a test's
// stand-in) starts it over: nothing said by the old one is kept.
let bound: { bridge: Bridge | undefined; unsubscribe: (() => void) | null } | null = null;

function start() {
  const bridge = api();
  if (bound && bound.bridge === bridge) return;
  bound?.unsubscribe?.();
  const mine = { bridge, unsubscribe: null as (() => void) | null };
  bound = mine;
  snapshot = { view: null, error: null, loading: true };
  if (!bridge) {
    publish({ loading: false });
    return;
  }
  mine.unsubscribe = bridge.onChanged(view => { if (bound === mine) publish({ view: asView(view), loading: false }); });
  bridge.list().then(
    r => { if (bound === mine) publish(r.success ? { view: asView(r), error: null, loading: false } : { error: r.error, loading: false }); },
    e => { if (bound === mine) publish({ error: sentence(e), loading: false }); },
  );
}

/** Runs one channel: its view replaces the one shown, its failure is said. */
async function run<T extends object>(call: (bridge: Bridge) => Promise<ClaudeAccountsResult<T>>): Promise<ClaudeAccountsResult<T>> {
  const bridge = api();
  if (!bridge) return { success: false, error: 'Tars is not running this page.' };
  try {
    const r = await call(bridge);
    if (!r.success) publish({ error: r.error });
    else if ('settings' in r && 'accounts' in r) publish({ view: asView(r as unknown as ClaudeAccountsView), error: null });
    else publish({ error: null });
    return r;
  } catch (e) {
    publish({ error: sentence(e) });
    return { success: false, error: sentence(e) };
  }
}

export const claudeAccountActions = {
  setEnabled: (enabled: boolean) => run(b => b.setEnabled(enabled)),
  setThresholds: (p: { fiveHour: number; weekly: number }) => run(b => b.setThresholds(p)),
  add: (p: { label: string }) => run(b => b.add(p)),
  rename: (p: { id: ClaudeAccountId; label: string }) => run(b => b.rename(p)),
  setAccountEnabled: (p: { id: ClaudeAccountId; enabled: boolean }) => run(b => b.setAccountEnabled(p)),
  reorder: (ids: ClaudeAccountId[]) => run(b => b.reorder(ids)),
  remove: (id: ClaudeAccountId) => run(b => b.remove(id)),
  refresh: (id?: ClaudeAccountId) => run(b => b.refresh(id)),
  setAgentAccount: (p: { agentId: string; accountId: ClaudeAccountId | null }) => run(b => b.setAgentAccount(p)),
  clearError: () => publish({ error: null }),
};

export function useClaudeAccounts(): Snapshot & { actions: typeof claudeAccountActions } {
  const [current, setCurrent] = useState(snapshot);
  useEffect(() => {
    const listener = () => setCurrent(snapshot);
    listeners.add(listener);
    start();
    listener();
    return () => { listeners.delete(listener); };
  }, []);
  return { ...current, actions: claudeAccountActions };
}
