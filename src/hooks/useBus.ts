'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import type { BusDelivery, BusMember, BusMessage, BusRoom, BusThread } from '@/types/electron';

/**
 * The agent bus, as the Chat page sees it.
 *
 * The main process pushes `bus:message`, `bus:delivery` and `bus:thread`, so
 * this never polls: the snapshot is fetched once per room and then kept up to
 * date by the three subscriptions. A delivery is keyed by message *and*
 * target, because one message aimed at a room has one delivery per member and
 * they do not all end the same way.
 */

export interface BusSnapshot {
  room: BusRoom | null;
  /** The room's members, each carrying whether its CLI reports the end of a
   *  turn. Derived in the main process from the provider's hook configuration,
   *  so the page never decides reachability from a provider name. */
  members: BusMember[];
  threads: BusThread[];
  messages: BusMessage[];
  deliveries: BusDelivery[];
}

const EMPTY: BusSnapshot = { room: null, members: [], threads: [], messages: [], deliveries: [] };

const deliveryKey = (d: BusDelivery) => `${d.messageId}:${d.targetAgentId}`;

/** True inside the desktop app with a backend that carries the bus. */
export function hasBus(): boolean {
  return typeof window !== 'undefined' && !!window.electronAPI?.bus;
}

/** How long a read of the bus is given before the page says it did not answer. */
const BUS_READ_MS = 10_000;

/**
 * A read of the bus that says so when it does not come back. A main process
 * that never answered left the room list empty and a room spinning for good,
 * which reads as a fleet that has not spoken yet. Frame: `Chat · A · Room ·
 * the bus does not answer` (`bus:getRoom, no answer in 10 s`).
 */
function busRead<T>(channel: string, call: () => Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${channel}, no answer in ${BUS_READ_MS / 1000} s`)), BUS_READ_MS);
  });
  return Promise.race([call(), late]).finally(() => clearTimeout(timer));
}

/** What failed, without the wrapper IPC puts around the main process's words. */
const readError = (err: unknown): string =>
  (err instanceof Error ? err.message : String(err)).replace(/^Error invoking remote method '[^']+':\s*(Error:\s*)?/, '');

export function useBusRooms() {
  const [rooms, setRooms] = useState<BusRoom[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(async () => {
    if (!hasBus()) { setLoading(false); return; }
    try {
      const r = await busRead('bus:listRooms', () => window.electronAPI!.bus!.listRooms());
      setRooms(r?.rooms ?? []);
      setError(r?.error ?? null);
    } catch (err) {
      // The rooms already listed stay: the note says the list is not whole.
      setError(readError(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void reload(); }, [reload]);

  // A room appears when its first message lands, and `setMembers` emits nothing
  // of its own, so this refresh is the only thing keeping the list's member
  // counts current. It stays, and it is coalesced: an active room was paying a
  // full listRooms round trip per message to learn nothing had changed. A burst
  // now costs one read. The real answer is a room event from the main process,
  // which the contract does not have.
  const pendingReload = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    if (!hasBus()) return;
    const offMessage = window.electronAPI!.bus!.onMessage(() => {
      if (pendingReload.current) return;
      pendingReload.current = setTimeout(() => {
        pendingReload.current = null;
        void reload();
      }, 400);
    });
    return () => {
      offMessage();
      if (pendingReload.current) {
        clearTimeout(pendingReload.current);
        pendingReload.current = null;
      }
    };
  }, [reload]);

  return { rooms, loading, error, reload };
}

export function useBusRoom(roomId: string | null) {
  const [snapshot, setSnapshot] = useState<BusSnapshot>(EMPTY);
  const [loading, setLoading] = useState(!!roomId);
  const [error, setError] = useState<string | null>(null);
  /** Bumped to ask for a fresh read of the same room. */
  const [refreshToken, setRefreshToken] = useState(0);

  // Fetch per room, and drop an answer that arrives after you have moved on:
  // a slow getRoom for the room you just left must not overwrite the one you
  // are looking at.
  useEffect(() => {
    if (!roomId || !hasBus()) { setSnapshot(EMPTY); setLoading(false); return; }
    let cancelled = false;
    setLoading(true);
    void (async () => {
      try {
        const r = await busRead('bus:getRoom', () => window.electronAPI!.bus!.getRoom(roomId));
        if (cancelled) return;
        setSnapshot({
          room: r?.room ?? null,
          members: r?.members ?? [],
          threads: r?.threads ?? [],
          messages: r?.messages ?? [],
          deliveries: r?.deliveries ?? [],
        });
        setError(r?.success ? null : (r?.error ?? 'The bus did not answer.'));
      } catch (err) {
        if (cancelled) return;
        // Not the room before it, shown as if it were this one.
        setSnapshot(EMPTY);
        setError(readError(err));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [roomId, refreshToken]);

  const reload = useCallback(() => { setRefreshToken(t => t + 1); }, []);

  // Re-subscribed per room, which is cheaper than keeping the id in a ref and
  // lets each handler compare against the room it was installed for.
  useEffect(() => {
    if (!roomId || !hasBus()) return;
    const bus = window.electronAPI!.bus!;

    const offMessage = bus.onMessage((message: BusMessage) => {
      if (message.roomId !== roomId) return;
      setSnapshot(prev => (prev.messages.some(m => m.id === message.id)
        ? prev
        : { ...prev, messages: [...prev.messages, message] }));
    });

    const offDelivery = bus.onDelivery((delivery: BusDelivery) => {
      setSnapshot(prev => {
        // Only deliveries for messages this room already holds: a delivery
        // arrives with no room id of its own.
        if (!prev.messages.some(m => m.id === delivery.messageId)) return prev;
        const key = deliveryKey(delivery);
        return { ...prev, deliveries: [...prev.deliveries.filter(d => deliveryKey(d) !== key), delivery] };
      });
    });

    const offThread = bus.onThread((thread: BusThread) => {
      if (thread.roomId !== roomId) return;
      setSnapshot(prev => ({
        ...prev,
        threads: [...prev.threads.filter(t => t.id !== thread.id), thread],
      }));
    });

    return () => { offMessage(); offDelivery(); offThread(); };
  }, [roomId]);

  const post = useCallback(async (text: string, mentions: string[], attachments: string[] = []) => {
    if (!roomId || !hasBus()) return { success: false, error: 'The bus is not available.' };
    const r = await window.electronAPI!.bus!.postMessage({
      roomId,
      text,
      mentions,
      ...(attachments.length ? { attachments } : {}),
    });
    // The message itself arrives on bus:message; the deliveries come back from
    // the call, so the receipts under your own line appear with it.
    if (r?.success && r.deliveries?.length) {
      const fresh = r.deliveries;
      setSnapshot(prev => {
        const keys = new Set(fresh.map(deliveryKey));
        return { ...prev, deliveries: [...prev.deliveries.filter(d => !keys.has(deliveryKey(d))), ...fresh] };
      });
    }
    return r ?? { success: false, error: 'The bus did not answer.' };
  }, [roomId]);

  const stopThread = useCallback(async (threadId: string) => {
    if (!hasBus()) return { success: false, error: 'The bus is not available.' };
    const r = await window.electronAPI!.bus!.stopThread(threadId);
    if (r?.thread) {
      const stopped = r.thread;
      setSnapshot(prev => ({ ...prev, threads: [...prev.threads.filter(t => t.id !== stopped.id), stopped] }));
    }
    return r ?? { success: false, error: 'The bus did not answer.' };
  }, []);

  // What is held for an agent whose CLI reports no turn end, sent on your word,
  // oldest first. The deliveries come back from the call the way they do from
  // `post`, so the receipts change under the message you are looking at rather
  // than on the next refresh.
  const releaseHeld = useCallback(async (agentId: string) => {
    if (!hasBus()) return { success: false, error: 'The bus is not available.' };
    const r = await window.electronAPI!.bus!.releaseNotSent(agentId);
    if (r?.success && r.deliveries?.length) {
      const fresh = r.deliveries;
      setSnapshot(prev => {
        const keys = new Set(fresh.map(deliveryKey));
        return { ...prev, deliveries: [...prev.deliveries.filter(d => !keys.has(deliveryKey(d))), ...fresh] };
      });
    }
    return r ?? { success: false, error: 'The bus did not answer.' };
  }, []);

  // Files for the message being written, put where every agent in the room
  // can read them. What the bus refused is named in `error`; the rest are
  // staged and sent by id with the message.
  const stageFiles = useCallback(async (files: File[]) => {
    if (!roomId || !hasBus()) return { success: false, attachments: [], error: 'The bus is not available.' };
    const payload = await Promise.all(files.map(async file => ({
      name: file.name,
      mimeType: file.type || 'application/octet-stream',
      data: new Uint8Array(await file.arrayBuffer()),
    })));
    const r = await window.electronAPI!.bus!.stageFiles({ roomId, files: payload });
    return r ?? { success: false, attachments: [], error: 'The bus did not answer.' };
  }, [roomId]);

  // Send now: recorded as a post is, the agent's turn interrupted first when
  // it is busy and can be. The deliveries come back from the call the way
  // they do from `post`.
  const sendNow = useCallback(async (agentId: string, text: string, attachments: string[] = []) => {
    if (!roomId || !hasBus()) return { success: false, interrupted: false, error: 'The bus is not available.' };
    const r = await window.electronAPI!.bus!.sendNow({
      roomId,
      agentId,
      text,
      ...(attachments.length ? { attachments } : {}),
    });
    if (r?.success && r.deliveries?.length) {
      const fresh = r.deliveries;
      setSnapshot(prev => {
        const keys = new Set(fresh.map(deliveryKey));
        return { ...prev, deliveries: [...prev.deliveries.filter(d => !keys.has(deliveryKey(d))), ...fresh] };
      });
    }
    return r ?? { success: false, interrupted: false, error: 'The bus did not answer.' };
  }, [roomId]);

  const setMembers = useCallback(async (memberIds: string[]) => {
    if (!roomId || !hasBus()) return { success: false, error: 'The bus is not available.' };
    const r = await window.electronAPI!.bus!.setMembers(roomId, memberIds);
    // Changing the members closes the open anchor, so the threads are stale:
    // read the room again rather than patch one field of it.
    if (r?.success) reload();
    return r ?? { success: false, error: 'The bus did not answer.' };
  }, [roomId, reload]);

  return { snapshot, loading, error, reload, post, stopThread, setMembers, releaseHeld, stageFiles, sendNow };
}
