import * as fs from 'fs';
import * as path from 'path';
import { createHash } from 'crypto';
import { DATA_DIR } from '../constants';

/**
 * A durable temporary folder per agent (RD-REDEMARRAGE.md, 2.1, approved by
 * Noah on 2026-10-05).
 *
 * macOS empties /private/tmp and the app's /var/folders/.../T at every boot,
 * and every agent's scratchpad and background task output went with them on
 * the night of 2026-10-01: Claude Code files those under its own
 * CLAUDE_CODE_TMPDIR, the agent's commands under TMPDIR, and Tars set neither.
 * Each agent now gets ~/.dorothy/tmp/<short id>/, with `t/` as the TMPDIR of
 * its commands and `c/` as Claude Code's CLAUDE_CODE_TMPDIR. ~/.dorothy is in
 * every agent's --add-dir, so writing there asks no permission. The path stays
 * short, as the Unix sockets made under it require.
 *
 * Kept 7 days and 20 GB in all (10 GB when the disk has under 30 GB free),
 * oldest first, or the disk fills up again as it did that night: see
 * enforceTmpRetention.
 */

export const TMP_ROOT = path.join(DATA_DIR, 'tmp');

/** The agent's folder name: ten hex characters of its id, the same at every launch. */
export function shortIdOf(agentId: string): string {
  return createHash('sha256').update(agentId).digest('hex').slice(0, 10);
}

/** A real folder of its owner alone: a link planted in its place is removed, not followed. */
function ownDir(dir: string): void {
  try {
    if (!fs.lstatSync(dir).isDirectory()) fs.rmSync(dir, { force: true });
  } catch { /* absent */ }
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  fs.chmodSync(dir, 0o700);
}

/** The two variables an agent's CLI is given, its folders made first. */
export function agentTmpEnv(agentId: string, root = TMP_ROOT): { TMPDIR: string; CLAUDE_CODE_TMPDIR: string } {
  const dir = path.join(root, shortIdOf(agentId));
  const t = path.join(dir, 't');
  const c = path.join(dir, 'c');
  for (const each of [root, dir, t, c]) ownDir(each);
  return { TMPDIR: t, CLAUDE_CODE_TMPDIR: c };
}

/**
 * The same, or nothing when the folder cannot be made (a full disk, a file in
 * its way): the CLI then starts with the temporary folder it would have had,
 * rather than not at all.
 */
export function agentTmpEnvOrNone(agentId: string): { TMPDIR?: string; CLAUDE_CODE_TMPDIR?: string } {
  try {
    return agentTmpEnv(agentId);
  } catch (err) {
    console.warn(`[agent-tmp] no durable temporary folder for ${agentId}: ${(err as Error).message}`);
    return {};
  }
}

/** Where each deletion is written: ~/.dorothy/logs/agent-tmp.log, moved to .1 past 256 KB. */
export function retentionLog(line: string, file = path.join(DATA_DIR, 'logs', 'agent-tmp.log')): void {
  console.log(line);
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    try {
      if (fs.statSync(file).size > 256 * 1024) fs.renameSync(file, `${file}.1`);
    } catch { /* none yet */ }
    fs.appendFileSync(file, `${new Date().toISOString()} ${line}\n`, { mode: 0o600 });
  } catch { /* the console has it */ }
}

// ── The retention ─────────────────────────────────────────────────────────

const DAY_MS = 86_400_000;
const GB = 1024 ** 3;
export const TMP_MAX_AGE_MS = 7 * DAY_MS;
export const TMP_CAP_BYTES = 20 * GB;
export const TMP_LOW_DISK_BYTES = 30 * GB;
export const TMP_LOW_DISK_CAP_BYTES = 10 * GB;

export interface RetentionDeps {
  root?: string;
  now?: () => number;
  /** Agents whose CLI runs now, in a terminal or a delegated run: nothing of theirs is deleted. */
  liveAgentIds: () => string[];
  /** Every agent of the fleet: a folder of none of them belongs to a deleted agent. */
  knownAgentIds: () => string[];
  /** Free space on the disk that holds the root, or null when it cannot be read. */
  freeBytes?: () => number | null;
  capBytes?: number;
  log?: (line: string) => void;
}

/** One thing the retention keeps or deletes whole. */
interface Unit {
  path: string;
  owner: string;
  bytes: number;
  /** Its newest modification, itself and everything under it. */
  newest: number;
}

export interface RetentionResult {
  removed: Array<{ path: string; bytes: number; reason: string }>;
  totalBytes: number;
  capBytes: number;
}

/** Size and newest date of what is under `p`, never through a link; null when it cannot be read. */
async function measure(p: string): Promise<{ bytes: number; newest: number } | null> {
  let st: fs.Stats;
  try {
    st = await fs.promises.lstat(p);
  } catch {
    return null;
  }
  let bytes = st.isDirectory() ? 0 : (typeof st.blocks === 'number' ? st.blocks * 512 : st.size);
  let newest = st.mtimeMs;
  if (st.isDirectory()) {
    let names: string[];
    try {
      names = await fs.promises.readdir(p);
    } catch {
      return null;
    }
    for (const name of names) {
      const inner = await measure(path.join(p, name));
      if (!inner) return null;
      bytes += inner.bytes;
      newest = Math.max(newest, inner.newest);
    }
  }
  return { bytes, newest };
}

async function childrenOf(dir: string): Promise<string[]> {
  try {
    return (await fs.promises.readdir(dir)).map((name) => path.join(dir, name));
  } catch {
    return [];
  }
}

async function isRealDir(p: string): Promise<boolean> {
  try {
    return (await fs.promises.lstat(p)).isDirectory();
  } catch {
    return false;
  }
}

/**
 * What the retention weighs, one unit at a time: each entry of an agent's
 * `t/`, each Claude Code session folder of its `c/`
 * (`claude-<uid>/<project>/<session>`), and the whole folder of an agent the
 * fleet no longer has, or anything at the top that is not a real folder.
 */
async function unitsOf(root: string, known: Map<string, string>): Promise<Array<{ path: string; owner: string }>> {
  const units: Array<{ path: string; owner: string }> = [];
  for (const top of await childrenOf(root)) {
    const owner = known.get(path.basename(top));
    if (!owner || !(await isRealDir(top))) {
      units.push({ path: top, owner: owner ?? '' });
      continue;
    }
    for (const entry of await childrenOf(path.join(top, 't'))) units.push({ path: entry, owner });
    const walk = async (dir: string, depth: number): Promise<void> => {
      for (const entry of await childrenOf(dir)) {
        if (depth < 3 && (await isRealDir(entry)) && (await childrenOf(entry)).length > 0) await walk(entry, depth + 1);
        else units.push({ path: entry, owner });
      }
    };
    await walk(path.join(top, 'c'), 1);
    for (const other of await childrenOf(top)) {
      if (!['t', 'c'].includes(path.basename(other))) units.push({ path: other, owner });
    }
  }
  return units;
}

/**
 * One pass: deletes what nothing touched for 7 days, then the oldest first
 * while the whole is over the cap. Nothing of a live agent, never through a
 * link (a link is deleted as the link it is), nothing outside the root, and
 * nothing at all when the root itself is a link.
 */
export async function enforceTmpRetention(deps: RetentionDeps): Promise<RetentionResult> {
  const root = deps.root ?? TMP_ROOT;
  const now = (deps.now ?? Date.now)();
  const log = deps.log ?? ((line: string) => console.log(line));
  const free = deps.freeBytes?.() ?? null;
  const lowDisk = free !== null && free < TMP_LOW_DISK_BYTES;
  const capBytes = deps.capBytes ?? (lowDisk ? TMP_LOW_DISK_CAP_BYTES : TMP_CAP_BYTES);
  const result: RetentionResult = { removed: [], totalBytes: 0, capBytes };
  if (lowDisk) {
    log(`[agent-tmp] under 30 GB free on the disk (${(free / GB).toFixed(1)} GB): the agents' temporary folders are kept to ${(capBytes / GB).toFixed(0)} GB`);
  }

  let rootReal: string;
  try {
    const st = fs.lstatSync(root);
    if (!st.isDirectory()) {
      log(`[agent-tmp] ${root} is a link or not a folder: nothing is measured or deleted under it`);
      return result;
    }
    rootReal = fs.realpathSync(root);
  } catch {
    return result;
  }
  /**
   * Still the folder the pass began in, and the entry still inside it. Checked
   * before each deletion, not once: a pass awaits a long time between its
   * start and its deletions, and an agent that swapped ~/.dorothy/tmp for a
   * link meanwhile would have the same name deleted elsewhere (the Audit's
   * gate of #306).
   */
  const stillInside = (p: string): boolean => {
    try {
      if (!fs.lstatSync(root).isDirectory() || fs.realpathSync(root) !== rootReal) return false;
      const parent = fs.realpathSync(path.dirname(p));
      return parent === rootReal || parent.startsWith(rootReal + path.sep);
    } catch {
      return false;
    }
  };

  const known = new Map(deps.knownAgentIds().map((id) => [shortIdOf(id), id] as const));
  const units: Unit[] = [];
  for (const { path: p, owner } of await unitsOf(root, known)) {
    const m = await measure(p);
    if (!m) {
      log(`[agent-tmp] ${p} could not be read: kept, and weighed again at the next pass`);
      continue;
    }
    units.push({ path: p, owner, ...m });
  }

  // Who runs now, read once the measuring is done: an agent started during a
  // long pass is spared too.
  const live = new Set(deps.liveAgentIds());
  let swapped = false;
  const remove = async (unit: Unit, reason: string): Promise<boolean> => {
    const resolved = path.resolve(unit.path);
    if (swapped || !resolved.startsWith(root + path.sep)) return false;
    if (!stillInside(resolved)) {
      swapped = true;
      log(`[agent-tmp] ${root} was moved or changed into a link during the pass: nothing more is deleted until the next one`);
      return false;
    }
    try {
      await fs.promises.rm(resolved, { recursive: true, force: true });
    } catch (err) {
      log(`[agent-tmp] ${resolved} could not be deleted (${(err as Error).message}): kept`);
      return false;
    }
    result.removed.push({ path: resolved, bytes: unit.bytes, reason });
    const since = new Date(unit.newest).toISOString().slice(0, 16).replace('T', ' ');
    log(`[agent-tmp] removed ${resolved} (${unit.bytes} bytes, untouched since ${since}): ${reason}`);
    return true;
  };

  const kept: Unit[] = [];
  for (const unit of units) {
    const mine = unit.owner && live.has(unit.owner);
    if (!mine && unit.newest < now - TMP_MAX_AGE_MS && (await remove(unit, 'untouched for 7 days'))) continue;
    kept.push(unit);
  }

  let total = kept.reduce((sum, u) => sum + u.bytes, 0);
  const oldestFirst = kept.filter((u) => !(u.owner && live.has(u.owner))).sort((a, b) => a.newest - b.newest);
  for (const unit of oldestFirst) {
    if (total <= capBytes) break;
    if (await remove(unit, `over ${(capBytes / GB).toFixed(0)} GB in all, the oldest first`)) total -= unit.bytes;
  }
  if (total > capBytes) {
    log(`[agent-tmp] still ${total} bytes over a cap of ${capBytes}: what is left belongs to agents whose CLI runs`);
  }
  result.totalBytes = total;
  return result;
}

/** At launch (a minute after, out of the way of the start) and every hour. */
export function startTmpRetention(deps: RetentionDeps, opts: { firstMs?: number; everyMs?: number } = {}): () => void {
  let running = false;
  const pass = () => {
    if (running) return;
    running = true;
    enforceTmpRetention(deps)
      .catch((err) => console.warn('[agent-tmp] the retention pass failed:', err))
      .finally(() => { running = false; });
  };
  const first = setTimeout(pass, opts.firstMs ?? 60_000);
  const every = setInterval(pass, opts.everyMs ?? 3_600_000);
  first.unref?.();
  every.unref?.();
  return () => { clearTimeout(first); clearInterval(every); };
}
