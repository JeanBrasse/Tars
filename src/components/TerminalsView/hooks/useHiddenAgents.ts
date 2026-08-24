'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';

/**
 * Panels taken off a board, per tab.
 *
 * Removing a panel from a project board used to be the only way to delete an
 * agent for good: it killed the terminal, dropped the record and ran
 * `git worktree remove --force`. That is a reasonable thing to want and a
 * terrible thing to reach for when all you meant was "not on this screen".
 *
 * So a board removal hides, and hiding is reversible. The agent keeps running,
 * keeps its worktree and stays reachable from Agents, Kanban and delegation:
 * this is a property of one board on one machine, which is why it lives beside
 * the grid layouts in localStorage rather than in agents.json.
 *
 * Deleting for good is still available, from the same menu, behind its own
 * wording and its own confirmation.
 */

const STORAGE_KEY = 'terminals-hidden-agents';

type HiddenStore = Record<string, string[]>;

function readStore(): HiddenStore {
  if (typeof window === 'undefined') return {};
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return {};
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    const out: HiddenStore = {};
    for (const [tab, ids] of Object.entries(parsed as Record<string, unknown>)) {
      if (Array.isArray(ids)) out[tab] = ids.filter((i): i is string => typeof i === 'string');
    }
    return out;
  } catch {
    return {};
  }
}

function writeStore(store: HiddenStore): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(store));
  } catch {
    // A full or disabled store must not break hiding a panel.
  }
}

export function useHiddenAgents(tabId: string) {
  const [store, setStore] = useState<HiddenStore>({});

  // Read on mount rather than during render: localStorage does not exist
  // while the static export is being prerendered.
  useEffect(() => {
    setStore(readStore());
  }, []);

  const hiddenIds = useMemo(() => store[tabId] ?? [], [store, tabId]);

  const hide = useCallback((agentId: string) => {
    setStore(() => {
      const next = readStore();
      const current = next[tabId] ?? [];
      if (!current.includes(agentId)) next[tabId] = [...current, agentId];
      writeStore(next);
      return next;
    });
  }, [tabId]);

  const show = useCallback((agentId: string) => {
    setStore(() => {
      const next = readStore();
      next[tabId] = (next[tabId] ?? []).filter(id => id !== agentId);
      if (next[tabId].length === 0) delete next[tabId];
      writeStore(next);
      return next;
    });
  }, [tabId]);

  const showAll = useCallback(() => {
    setStore(() => {
      const next = readStore();
      delete next[tabId];
      writeStore(next);
      return next;
    });
  }, [tabId]);

  /** Forget an agent that no longer exists, so deleting one for good does not
   *  leave it listed as hidden on a board forever. */
  const forget = useCallback((agentId: string) => {
    setStore(() => {
      const next = readStore();
      for (const tab of Object.keys(next)) {
        next[tab] = next[tab].filter(id => id !== agentId);
        if (next[tab].length === 0) delete next[tab];
      }
      writeStore(next);
      return next;
    });
  }, []);

  return { hiddenIds, hide, show, showAll, forget };
}
