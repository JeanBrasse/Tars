'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import type { AgentTranscript, TranscriptMessage, TranscriptUnavailableReason } from '@/types/electron';

/**
 * The preload exposes this on `agent` (see electron/preload.ts), while the type
 * mirror in src/types/electron.d.ts declares it inside the `pty` block. Calling
 * `pty.transcript` would type-check and be undefined at runtime, so the method
 * is reached through this narrow shape until the declaration is moved. Delete
 * this and call `window.electronAPI.agent.transcript` directly once it is.
 */
type TranscriptFn = (params: { agentId: string; before?: string; limit?: number }) => Promise<AgentTranscript>;

function transcriptApi(): TranscriptFn | undefined {
  const agent = window.electronAPI?.agent as unknown as { transcript?: TranscriptFn } | undefined;
  return agent?.transcript;
}

export interface Unavailable {
  reason: TranscriptUnavailableReason;
  /** The main process writes a showable sentence. Show it, do not rephrase it. */
  detail: string;
}

export interface PanelTranscript {
  loading: boolean;
  loadingOlder: boolean;
  messages: TranscriptMessage[];
  hasMore: boolean;
  unavailable?: Unavailable;
  error?: string;
  loadOlder: () => void;
  refresh: () => void;
}

/**
 * An agent's conversation, read once.
 *
 * This is a snapshot on purpose, and the view says so. Two reasons. The list is
 * read upwards from the newest message, so growing it live would shift every
 * row under a reader who is scrolling through it, which is the exact complaint
 * that started this work. And watching an agent work already has a view: the
 * live terminal next door, which is why the panel has two. Re-reading is a
 * button, so nothing moves unless the reader asks for it.
 */
export function usePanelTranscript(agentId: string, enabled: boolean): PanelTranscript {
  const [loading, setLoading] = useState(false);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [messages, setMessages] = useState<TranscriptMessage[]>([]);
  const [hasMore, setHasMore] = useState(false);
  const [unavailable, setUnavailable] = useState<Unavailable | undefined>();
  const [error, setError] = useState<string | undefined>();
  const cursorRef = useRef<string | undefined>(undefined);
  // Bumped by refresh, and by leaving and re-entering the view.
  const [readToken, setReadToken] = useState(0);

  useEffect(() => {
    if (!enabled) return;
    const api = transcriptApi();
    if (!api) {
      setError('The transcript reader is not available in this build.');
      return;
    }
    let cancelled = false;
    setLoading(true);
    setError(undefined);
    setUnavailable(undefined);
    api({ agentId })
      .then((result) => {
        if (cancelled) return;
        if (!result.available) {
          setMessages([]);
          setHasMore(false);
          cursorRef.current = undefined;
          setUnavailable({ reason: result.reason, detail: result.detail });
          return;
        }
        setMessages(result.messages);
        setHasMore(result.hasMore);
        cursorRef.current = result.nextCursor;
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => { cancelled = true; };
  }, [agentId, enabled, readToken]);

  const loadOlder = useCallback(() => {
    const api = transcriptApi();
    const before = cursorRef.current;
    if (!api || !before || loadingOlder) return;
    setLoadingOlder(true);
    api({ agentId, before })
      .then((result) => {
        if (!result.available) {
          setHasMore(false);
          return;
        }
        // The answer is the page above what is on screen, oldest first, so it
        // goes in front. Anything already held wins on id: a refresh racing a
        // page would otherwise show a message twice.
        setMessages((current) => {
          const held = new Set(current.map(m => m.id));
          return [...result.messages.filter(m => !held.has(m.id)), ...current];
        });
        setHasMore(result.hasMore);
        cursorRef.current = result.nextCursor;
      })
      .catch(() => {})
      .finally(() => setLoadingOlder(false));
  }, [agentId, loadingOlder]);

  const refresh = useCallback(() => {
    cursorRef.current = undefined;
    setMessages([]);
    setHasMore(false);
    setReadToken(t => t + 1);
  }, []);

  return { loading, loadingOlder, messages, hasMore, unavailable, error, loadOlder, refresh };
}
