import * as fs from 'fs';

/**
 * Renaming a finished temp file over the live one, the last step of every
 * atomic write (audit B S-02), and deleting a file or a folder, while another
 * program may still hold it.
 *
 * darwin/linux: the one fs call, as before; a reader never stands in its way.
 *
 * win32: the rename fails with EPERM, EBUSY or EACCES while any process holds
 * the target open, even to read it (measured on this machine: 198 of 200
 * renames failed under 20 Node readers). Readers here are Claude Code opening
 * ~/.claude.json, an MCP server reading app-settings.json, an antivirus
 * scanning a file that just changed: each holds it for a moment. So the rename
 * is tried again, quickly at first and then less often, for about a second,
 * and if the file is still held after that, the error says which file, for
 * how long, and keeps its code. Any other error (the temp file gone, another
 * volume, a full disk) is thrown at once: no reader causes it and waiting
 * would only hide it.
 *
 * A delete meets the same holders, and one more: a process that just exited,
 * or its own child, still holding a file or a folder (as its working
 * directory) for a moment. It is tried again the same way, on the same
 * budget, for EBUSY, EPERM, EACCES and ENOTEMPTY (a folder whose last file is
 * still being let go), and then the delete's own last error is thrown as it
 * was. Node's `rmSync(p, { maxRetries })` is not used for it: measured here,
 * under Node 22 a folder held as a child's working directory fails at once
 * (EBUSY on rmdir, never retried), under Electron's Node 24 the same hold
 * reads EPERM, and its retries are per file, so a tree of held files waits
 * the delay once per file. One loop around the whole call behaves the same on
 * both, with one bound.
 *
 * The wait blocks the calling thread, as the synchronous call around it does:
 * callers are synchronous and a second at worst is the price of not losing a
 * save, or of not turning an update that worked into a failure.
 */
export const RENAME_RETRY_BUDGET_MS = 1000;
export const REMOVE_RETRY_BUDGET_MS = RENAME_RETRY_BUDGET_MS;

const HELD_BY_READER = new Set(['EPERM', 'EBUSY', 'EACCES']);
const HELD_FROM_DELETE = new Set(['EPERM', 'EBUSY', 'EACCES', 'ENOTEMPTY']);

interface Clock {
  platform?: NodeJS.Platform;
  sleep?: (ms: number) => void;
  now?: () => number;
}

export interface RenameDeps extends Clock {
  rename?: (from: string, to: string) => void;
}

export interface RemoveDeps extends Clock {
  rm?: (target: string, options?: fs.RmOptions) => void;
  unlink?: (target: string) => void;
}

const pause = new Int32Array(new SharedArrayBuffer(4));
const blockFor = (ms: number) => { Atomics.wait(pause, 0, 0, ms); };

/**
 * `op` again while it fails with one of `held`, for `budget` ms counted from
 * the first try (the failing calls included), then `giveUp` says what to throw.
 */
function whileHeld(
  op: () => void,
  held: ReadonlySet<string>,
  budget: number,
  deps: Clock,
  giveUp: (err: NodeJS.ErrnoException, spent: number) => unknown,
): void {
  const sleep = deps.sleep ?? blockFor;
  const now = deps.now ?? Date.now;
  const started = now();
  let wait = 1;
  for (;;) {
    try {
      op();
      return;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException)?.code;
      const spent = now() - started;
      if (!code || !held.has(code)) throw err;
      if (spent >= budget) throw giveUp(err as NodeJS.ErrnoException, spent);
      sleep(Math.min(wait, budget - spent));
      wait = Math.min(wait * 2, 50);
    }
  }
}

export function renameReplacingSync(from: string, to: string, deps: RenameDeps = {}): void {
  const rename = deps.rename ?? ((a: string, b: string) => fs.renameSync(a, b));
  if ((deps.platform ?? process.platform) !== 'win32') {
    rename(from, to);
    return;
  }
  whileHeld(() => rename(from, to), HELD_BY_READER, RENAME_RETRY_BUDGET_MS, deps, (e, spent) => {
    // "may be": a genuine permission error answers the same codes, and is retried then reported alike.
    e.message = `Could not replace ${to}: it may be held open by another program (still ${e.code} after ${spent} ms). ${e.message}`;
    return e;
  });
}

/** fs.rmSync(target, options); on win32, waited on while a holder refuses it. */
export function rmRetryingSync(target: string, options?: fs.RmOptions, deps: RemoveDeps = {}): void {
  const rm = deps.rm ?? ((p: string, o?: fs.RmOptions) => fs.rmSync(p, o));
  if ((deps.platform ?? process.platform) !== 'win32') {
    rm(target, options);
    return;
  }
  whileHeld(() => rm(target, options), HELD_FROM_DELETE, REMOVE_RETRY_BUDGET_MS, deps, e => e);
}

/** fs.unlinkSync(target); on win32, waited on while a holder refuses it. */
export function unlinkRetryingSync(target: string, deps: RemoveDeps = {}): void {
  const unlink = deps.unlink ?? ((p: string) => fs.unlinkSync(p));
  if ((deps.platform ?? process.platform) !== 'win32') {
    unlink(target);
    return;
  }
  whileHeld(() => unlink(target), HELD_FROM_DELETE, REMOVE_RETRY_BUDGET_MS, deps, e => e);
}
