'use client';

import { useState, useEffect, useCallback, useRef } from 'react';
import type {
  ClaudeSettings,
  ClaudeStats,
  ClaudeProject,
  ClaudePlugin,
  ClaudeSkill,
  ClaudeSession,
  HistoryEntry,
  ClaudeMessage,
} from '@/lib/claude-code';
import { isElectron } from './useElectron';

interface RateLimits {
  five_hour?: { used_percentage: number; resets_at: number };
  seven_day?: { used_percentage: number; resets_at: number };
}

interface TokenStats {
  totalInputTokens: number;
  totalOutputTokens: number;
  totalCostUsd: number;
  extraCostUsd: number;
  sessionCount: number;
  modelTokens?: Record<string, { in: number; out: number }>;
  dailyCosts?: Record<string, { cost: number; extraCost: number }>;
  providerTotals?: Record<string, { in: number; out: number; cost: number; sessions: number }>;
}

/**
 * The latest day of the transcripts, cheaply: its date, its cost and its
 * tokens. A day's cost grows all day without moving the date the stats were
 * computed for, the session counts or the rate windows, so a poll that compared
 * only those kept the morning's figures until the next session started, and
 * for good on an API key, which has no rate windows. The days come sorted by
 * date, so the last is the newest.
 */
function latestDayOf(stats: ClaudeStats | null | undefined): string {
  const days = stats?.dailyModelTokens;
  const last = days?.[days.length - 1];
  if (!last) return '';
  const tokens = Object.values(last.tokensByModel ?? {}).reduce((sum, n) => sum + n, 0);
  return `${last.date}|${last.costUSD ?? ''}|${tokens}`;
}

/** The same for token-stats.json, whose over-quota share the Usage page reads. */
function tokenStatsOf(stats: TokenStats | null | undefined): string {
  return stats ? `${stats.totalCostUsd}|${stats.extraCostUsd}|${stats.sessionCount}` : '';
}

interface ClaudeData {
  settings: ClaudeSettings | null;
  stats: ClaudeStats | null;
  projects: ClaudeProject[];
  plugins: ClaudePlugin[];
  skills: ClaudeSkill[];
  history: HistoryEntry[];
  activeSessions: string[];
  rateLimits: RateLimits | null;
  tokenStats: TokenStats | null;
}

export function useClaude() {
  const [data, setData] = useState<ClaudeData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const didInitialLoad = useRef(false);

  const fetchData = useCallback(async () => {
    try {
      // Only the first load flips `loading`. Background poll ticks used to
      // setLoading(true)/setLoading(false) every 10s, forcing two extra render
      // passes of every consumer (unmemoized AgentManagementCards included)
      // even when the data comparison below ended up returning `prev`.
      if (!didInitialLoad.current) setLoading(true);

      // Use IPC in Electron, API in browser
      if (isElectron() && window.electronAPI?.claude?.getData) {
        const result = await window.electronAPI.claude.getData();
        if (result) {
          // Transform the result to match expected types
          // Electron returns lastAccessed as number (ms timestamp), frontend expects lastActivity as Date
          interface ElectronProject {
            id: string;
            path: string;
            name: string;
            sessions: Array<{ id: string; timestamp: number }>;
            lastAccessed: number;
          }

          const rawProjects = (result.projects || []) as ElectronProject[];
          const activeSessions = (result.activeSessions || []) as string[];
          const rateLimits = (result.rateLimits || null) as RateLimits | null;

          // Only update if data actually changed to prevent unnecessary re-renders
          setData(prev => {
            // The comparison runs against the *raw* IPC payload first. Building
            // `transformedProjects` eagerly allocated one object plus two Date
            // instances per session on every 10s tick, then threw them away
            // whenever the comparison decided nothing had changed.
            const unchanged =
              !!prev &&
              prev.projects.length === rawProjects.length &&
              prev.activeSessions.length === activeSessions.length &&
              // Check if any project changed
              !rawProjects.some((p, i) => {
                const prevP = prev.projects[i];
                return prevP?.id !== p.id || prevP?.sessions.length !== (p.sessions || []).length;
              }) &&
              // Check if rateLimits changed
              JSON.stringify(prev.rateLimits) === JSON.stringify(rateLimits) &&
              // And the figures themselves. Without this the poll kept the
              // first stats it ever saw for as long as no project or session
              // count moved, so a cost that grew, or a transcript that stopped
              // being readable, never reached the page. Compared on what the
              // Usage page reads, cheaply, rather than on the whole object,
              // which carries a per-day array that is expensive to stringify
              // every ten seconds: the date, the unreadable count, and the
              // latest day and token-stats.json as latestDayOf and
              // tokenStatsOf sum them up.
              prev.stats?.lastComputedDate === (result.stats as ClaudeStats | null)?.lastComputedDate &&
              prev.stats?.unreadable === (result.stats as ClaudeStats | null)?.unreadable &&
              latestDayOf(prev.stats) === latestDayOf(result.stats as ClaudeStats | null) &&
              tokenStatsOf(prev.tokenStats) === tokenStatsOf(result.tokenStats as TokenStats | null);
            // No significant changes
            if (unchanged) return prev;

            // Transform the raw projects only now that we know they are needed.
            const transformedProjects = rawProjects.map((p) => ({
              id: p.id,
              name: p.name,
              path: p.path,
              sessions: (p.sessions || []).map(s => ({
                id: s.id,
                projectPath: p.path,
                messages: [] as ClaudeMessage[],
                startTime: new Date(s.timestamp),
                lastActivity: new Date(s.timestamp),
              })),
              lastActivity: new Date(p.lastAccessed),
            }));

            return {
              settings: result.settings as ClaudeSettings | null,
              stats: result.stats as ClaudeStats | null,
              projects: transformedProjects,
              plugins: (result.plugins || []) as ClaudePlugin[],
              skills: (result.skills || []) as ClaudeSkill[],
              history: (result.history || []) as HistoryEntry[],
              activeSessions,
              rateLimits,
              tokenStats: (result.tokenStats || null) as TokenStats | null,
            };
          });
          setError(null);
        } else {
          throw new Error('Failed to get Claude data from Electron');
        }
      } else {
        // The web build's /api/claude route is gone: the main process is the
        // one reader of Claude Code's files now.
        throw new Error('Claude Code data is read by the desktop app');
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unknown error');
    } finally {
      didInitialLoad.current = true;
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchData();
    // Poll every 10 seconds to reduce CPU usage, and only while the window is
    // visible: each tick drives claude:getData, which does blocking fs work on
    // the Electron main process and stalls PTY output. Ungated, it kept running
    // while the window sat behind another app. Same pattern as logs/crons.
    const tick = () => { if (document.visibilityState === 'visible') fetchData(); };
    const interval = setInterval(tick, 10000);
    document.addEventListener('visibilitychange', tick);
    return () => {
      clearInterval(interval);
      document.removeEventListener('visibilitychange', tick);
    };
  }, [fetchData]);

  return { data, loading, error, refresh: fetchData };
}

export function useSessionMessages(projectId: string | null, sessionId: string | null) {
  const [messages, setMessages] = useState<ClaudeMessage[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const fetchMessages = useCallback(async () => {
    if (!projectId || !sessionId) {
      setMessages([]);
      return;
    }

    try {
      setLoading(true);
      const response = await fetch(`/api/claude/sessions/${projectId}/${sessionId}`);
      if (!response.ok) throw new Error('Failed to fetch');
      const result = await response.json();
      setMessages(result);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unknown error');
    } finally {
      setLoading(false);
    }
  }, [projectId, sessionId]);

  useEffect(() => {
    fetchMessages();
  }, [fetchMessages]);

  return { messages, loading, error, refresh: fetchMessages };
}
