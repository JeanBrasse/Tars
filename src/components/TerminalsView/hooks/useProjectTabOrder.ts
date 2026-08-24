'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';

/**
 * The order of the project tabs, as the user arranged them.
 *
 * The strip's order came from the order agents happened to appear in, so it
 * changed under the user whenever an agent was created or removed. This stores
 * an explicit order instead, next to the grid layouts (see
 * useGridLayoutStorage.ts) and for the same reason: it is a property of this
 * machine's window, not of the agents, and it must survive a reload.
 *
 * The stored list is a preference, never the source of truth for which
 * projects exist. Paths that no longer have an agent are ignored, and paths
 * that are not in the list yet go to the end in the order they arrived, so a
 * new project appears rather than vanishing because it was never ranked.
 */

const STORAGE_KEY = 'terminals-project-tab-order';

function readStored(): string[] {
  if (typeof window === 'undefined') return [];
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((p): p is string => typeof p === 'string') : [];
  } catch {
    return [];
  }
}

/** Live paths, ranked by the stored order, with unranked ones kept at the end. */
export function applyOrder(paths: string[], order: string[]): string[] {
  const live = new Set(paths);
  // Deduped as it is built: a stored list holding the same path twice would
  // otherwise render two tabs for one project, which React sees as a duplicate
  // key and the user sees as a tab that will not go away.
  const seen = new Set<string>();
  const ranked: string[] = [];
  for (const path of order) {
    if (!live.has(path) || seen.has(path)) continue;
    seen.add(path);
    ranked.push(path);
  }
  return [...ranked, ...paths.filter(p => !seen.has(p))];
}

export function useProjectTabOrder(projectPaths: string[]) {
  const [order, setOrder] = useState<string[]>([]);

  // Read once on mount rather than during render: localStorage is not
  // available while the static export is being prerendered.
  useEffect(() => {
    const stored = readStored();
    if (stored.length) setOrder(stored);
  }, []);

  const orderedPaths = useMemo(() => applyOrder(projectPaths, order), [projectPaths, order]);

  const reorder = useCallback((from: string, to: string) => {
    if (from === to) return;
    setOrder(() => {
      // Ranked against what is on screen now, so a drag writes a complete
      // order rather than patching a stale one.
      const next = applyOrder(projectPaths, readStored());
      const fromIndex = next.indexOf(from);
      const toIndex = next.indexOf(to);
      if (fromIndex === -1 || toIndex === -1) return next;
      next.splice(toIndex, 0, next.splice(fromIndex, 1)[0]);
      try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
      } catch { /* a full or disabled store must not break the drag */ }
      return next;
    });
  }, [projectPaths]);

  return { orderedPaths, reorder };
}
