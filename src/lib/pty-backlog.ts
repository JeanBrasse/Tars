import type { ElectronAPI, PtyDataEvent } from '@/types/electron';

/**
 * What a PTY writes before its terminal listens. A project's shell writes its
 * banner and first prompt a moment after pty:create answers, while the
 * Projects page is still mounting <Terminal>, a dynamic import away, and the
 * terminal only hears the PTY once it is mounted: those first lines reached
 * nobody, and the terminal opened empty (the QA's WHEEL-QA.md, 05/10). The
 * page listens from before it asks for the PTY, and the terminal takes what
 * came when it starts listening itself. Its failures are listed, and pinned,
 * in __tests__/lib/pty-backlog.test.ts.
 */
export interface PtyBacklog {
  /** What the PTY `id` wrote so far, oldest first, handed over once: the listening ends here. */
  take(id: string): string[];
  /** The listening ends and nothing is kept: no terminal came for it. */
  drop(): void;
}

/** Listens to every PTY from now on: the id is not known until pty:create answers. */
export function ptyBacklog(onData: (callback: (event: PtyDataEvent) => void) => () => void): PtyBacklog {
  let heard: PtyDataEvent[] = [];
  let stop: (() => void) | null = onData(event => { heard.push(event); });
  const end = () => {
    stop?.();
    stop = null;
    const kept = heard;
    heard = [];
    return kept;
  };
  return {
    take: id => end().filter(event => event.id === id).map(event => event.data),
    drop: () => { end(); },
  };
}

/**
 * A PTY asked for with its listening started first, as the Projects page opens
 * a terminal: the id is known only once pty:create answers. A page left before
 * the answer would never take the backlog nor kill the shell, so the listening,
 * which hears every agent's output, ran for the window's life and the shell
 * lived on with nobody attached (the Audit's Low at the gate of PR 328): when
 * `stillWanted` says no at the answer, the listening ends, the PTY is killed,
 * and this answers null. A failed pty:create ends the listening and throws.
 */
export async function openPtyHeard(
  pty: Pick<ElectronAPI['pty'], 'create' | 'onData' | 'kill'>,
  params: { cwd: string },
  stillWanted: () => boolean,
): Promise<{ id: string; backlog: PtyBacklog } | null> {
  const backlog = ptyBacklog(pty.onData);
  let id: string;
  try {
    ({ id } = await pty.create(params));
  } catch (err) {
    backlog.drop();
    throw err;
  }
  if (!stillWanted()) {
    backlog.drop();
    pty.kill({ id }).catch(() => {});
    return null;
  }
  return { id, backlog };
}
