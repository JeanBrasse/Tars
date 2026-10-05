import { execFile } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

/**
 * The folders no agent owns (Noah's choice 16 of 05/10; the frames merged in
 * #315, "Settings · System · folders no agent owns").
 *
 * A folder under a project's `.worktrees` that no git worktree holds: git
 * forgot it (its `.git` points to a gitdir that is gone), or it never had a
 * `.git`. Nothing says whether it holds work, so Tars lists each with its
 * project, its size and when it last changed, and never removes one on its
 * own. The window confirms, then asks for all of them to go: each is checked
 * again at that moment (still an orphan, no agent's, no process working in
 * it, no link) and removed one at a time, the progress told as it goes. Git is
 * never told --force: these are folders git no longer knows.
 */

/** Tars warns below this much free space on the disk (the frames' 30 GB). */
export const DISK_FLOOR_BYTES = 30 * 1024 ** 3;

export type OrphanReason = 'git-forgot' | 'no-git';
export type OrphanFolder = {
  /** The project the .worktrees folder is in. */
  project: string;
  path: string;
  /** Its path under the project's .worktrees. */
  name: string;
  reason: OrphanReason;
  sizeBytes: number;
  /** The newest change in it (caches and .git aside), or null when none could be read. */
  lastChangedAt: string | null;
};
export type OrphanListing = { folders: OrphanFolder[]; count: number; totalBytes: number };
export type KeptReason = 'in-use' | 'unknown-use' | 'failed';
export type RemovalReport = {
  removed: number;
  freedBytes: number;
  kept: Array<{ path: string; project: string; reason: KeptReason; detail?: string }>;
};
export type RemovalProgress = { done: number; total: number; freedBytes: number; current: string };
type ProcessCwd = { pid: number; command: string; cwd: string };

function run(file: string, args: string[], cwd?: string): Promise<{ code: number; stdout: string }> {
  return new Promise(resolve => {
    execFile(file, args, { cwd, maxBuffer: 32 * 1024 * 1024 }, (err, stdout) => {
      resolve({ code: err ? (typeof (err as { code?: unknown }).code === 'number' ? (err as { code: number }).code : 1) : 0, stdout: String(stdout) });
    });
  });
}

function real(p: string): string {
  try { return fs.realpathSync(p); } catch { return path.resolve(p); }
}

function inside(child: string, parent: string): boolean {
  return child === parent || child.startsWith(parent.endsWith(path.sep) ? parent : parent + path.sep);
}

/** The worktrees git knows for a project, as real paths. */
async function knownWorktrees(project: string): Promise<string[]> {
  const r = await run('git', ['worktree', 'list', '--porcelain'], project);
  if (r.code !== 0) return [];
  return r.stdout.split('\n').filter(l => l.startsWith('worktree ')).map(l => real(l.slice('worktree '.length)));
}

function isRealDir(p: string): boolean {
  try { return fs.lstatSync(p).isDirectory(); } catch { return false; }
}

/** Size on disk, in bytes, as du counts it. */
async function sizeOf(p: string): Promise<number> {
  const r = await run('du', ['-sk', p]);
  const kb = Number(r.stdout.split(/\s/)[0]);
  return Number.isFinite(kb) ? kb * 1024 : 0;
}

/** The newest mtime of the files in `dir`, caches and .git aside, a bounded walk. */
function lastChangeOf(dir: string): string | null {
  const skip = new Set(['node_modules', '.next', '.git']);
  let newest = 0;
  let seen = 0;
  const stack = [dir];
  while (stack.length && seen < 20_000) {
    const current = stack.pop()!;
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(current, { withFileTypes: true }); } catch { continue; }
    for (const entry of entries) {
      seen++;
      const p = path.join(current, entry.name);
      if (entry.isDirectory()) { if (!skip.has(entry.name)) stack.push(p); continue; }
      if (!entry.isFile()) continue;
      try { newest = Math.max(newest, fs.lstatSync(p).mtimeMs); } catch { /* gone */ }
    }
  }
  if (!newest) {
    try { newest = fs.lstatSync(dir).mtimeMs; } catch { return null; }
  }
  return new Date(newest).toISOString();
}

/**
 * The orphans under one project's .worktrees: each folder that is not a
 * worktree git knows nor an agent's, walked into when it holds one (a branch
 * name with a slash nests its worktree), never through a link.
 */
async function orphansOf(project: string, owned: Set<string>): Promise<Array<Omit<OrphanFolder, 'sizeBytes' | 'lastChangedAt'>>> {
  const base = path.join(project, '.worktrees');
  if (!isRealDir(base)) return [];
  const live = [...await knownWorktrees(project), ...owned].map(real);
  const holdsLive = (dir: string) => live.some(w => inside(w, real(dir)) && w !== real(dir));
  const found: Array<Omit<OrphanFolder, 'sizeBytes' | 'lastChangedAt'>> = [];
  const walk = (dir: string) => {
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const p = path.join(dir, entry.name);
      const r = real(p);
      if (live.includes(r)) continue;
      if (holdsLive(p)) { walk(p); continue; }
      const hasGit = fs.existsSync(path.join(p, '.git'));
      if (!hasGit && fs.readdirSync(p, { withFileTypes: true }).some(e => e.isDirectory() && fs.existsSync(path.join(p, e.name, '.git')))) {
        // A folder of forgotten worktrees: each is listed for itself.
        walk(p);
        continue;
      }
      found.push({ project, path: p, name: path.relative(base, p), reason: hasGit ? 'git-forgot' : 'no-git' });
    }
  };
  walk(base);
  return found;
}

export async function listOrphanFolders(opts: { projects: string[]; owned: string[] }): Promise<OrphanListing> {
  const owned = new Set(opts.owned.map(real));
  const folders: OrphanFolder[] = [];
  for (const project of [...new Set(opts.projects)]) {
    for (const orphan of await orphansOf(project, owned)) {
      folders.push({ ...orphan, sizeBytes: await sizeOf(orphan.path), lastChangedAt: lastChangeOf(orphan.path) });
    }
  }
  folders.sort((a, b) => b.sizeBytes - a.sizeBytes);
  return { folders, count: folders.length, totalBytes: folders.reduce((sum, f) => sum + f.sizeBytes, 0) };
}

/**
 * Every process's working directory: /proc on Linux, lsof elsewhere. Null when
 * neither answers, and then nothing is removed. As scripts/worktree.mjs reads it.
 */
export async function processCwds(): Promise<ProcessCwd[] | null> {
  const found: ProcessCwd[] = [];
  if (process.platform === 'linux') {
    for (const pid of fs.readdirSync('/proc').filter(n => /^\d+$/.test(n))) {
      try {
        found.push({ pid: Number(pid), command: fs.readFileSync(`/proc/${pid}/comm`, 'utf8').trim(), cwd: fs.readlinkSync(`/proc/${pid}/cwd`) });
      } catch { /* gone, or not ours to read */ }
    }
    return found;
  }
  const r = await run('lsof', ['-w', '-a', '-d', 'cwd', '-F', 'pcn']);
  if (r.code !== 0 && !r.stdout) return null;
  let current: ProcessCwd | null = null;
  for (const line of r.stdout.split('\n')) {
    if (line.startsWith('p')) current = { pid: Number(line.slice(1)), command: '', cwd: '' };
    else if (current && line.startsWith('c')) current.command = line.slice(1);
    else if (current && line.startsWith('n')) { current.cwd = line.slice(1); found.push(current); }
  }
  return found;
}

let removing = false;

/**
 * Removes every folder no agent owns, as it stands now: the list is read
 * again, and each folder is checked once more just before it goes. One at a
 * time; `onProgress` after each. A folder a process works in is kept, and so
 * is every one when the processes cannot be read.
 */
export async function removeOrphanFolders(opts: {
  projects: string[];
  owned: string[];
  processCwds?: () => Promise<ProcessCwd[] | null>;
  onProgress?: (progress: RemovalProgress) => void;
}): Promise<RemovalReport> {
  if (removing) throw new Error('a removal is already under way');
  removing = true;
  try {
    const listing = await listOrphanFolders(opts);
    const report: RemovalReport = { removed: 0, freedBytes: 0, kept: [] };
    const cwds = await (opts.processCwds ?? processCwds)();
    let done = 0;
    for (const folder of listing.folders) {
      const keep = (reason: KeptReason, detail?: string) => report.kept.push({ path: folder.path, project: folder.project, reason, ...(detail ? { detail } : {}) });
      if (!cwds) {
        keep('unknown-use');
      } else {
        const user = cwds.find(p => inside(real(p.cwd), real(folder.path)));
        if (user) {
          keep('in-use', `${user.command} (${user.pid})`);
        } else if (!isRealDir(folder.path) || !inside(real(folder.path), real(path.join(folder.project, '.worktrees')))) {
          keep('failed', 'it is no longer a folder of the project\'s .worktrees');
        } else {
          try {
            fs.rmSync(folder.path, { recursive: true, force: true });
            report.removed++;
            report.freedBytes += folder.sizeBytes;
          } catch (err) {
            keep('failed', err instanceof Error ? err.message : String(err));
          }
        }
      }
      done++;
      opts.onProgress?.({ done, total: listing.count, freedBytes: report.freedBytes, current: folder.path });
    }
    return report;
  } finally {
    removing = false;
  }
}

/** The free and total space of the disk `at` is on, and the floor Tars warns below. Null when it cannot be read. */
export function diskSpace(at: string = os.homedir()): { freeBytes: number; totalBytes: number; floorBytes: number } | null {
  try {
    const s = fs.statfsSync(at);
    return { freeBytes: s.bavail * s.bsize, totalBytes: s.blocks * s.bsize, floorBytes: DISK_FLOOR_BYTES };
  } catch {
    return null;
  }
}
