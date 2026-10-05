/**
 * The folders no agent owns (Noah's choice 16 of 05/10; the frames merged in
 * #315, "Settings · System · folders no agent owns"): the folders under a
 * project's .worktrees that no git worktree holds, listed with their size and
 * last change, and removed only when the window says so, one at a time.
 * (electron/services/orphan-folders.ts)
 *
 * How it fails, written before the code (2026-10-06):
 * 1. A folder git still lists as a worktree, or one an agent works in, is
 *    listed: removing it would take a live worktree.
 * 2. A folder whose .git points to a gitdir that is gone (git forgot it), or
 *    one with no .git at all, is missed.
 * 3. A folder that only holds worktrees (`.worktrees/feat/` for a branch
 *    `feat/x`) is listed whole, live worktrees and all; or one that holds
 *    forgotten worktrees hides them.
 * 4. Anything outside a project's .worktrees is listed, or a link is
 *    followed out of it.
 * 5. A size or a last change is wrong, or the totals are not the sum.
 * 6. The removal takes what the window was shown rather than what is true at
 *    that moment (a folder git took back since, one an agent took), a folder
 *    a process works in, or follows a link.
 * 7. The progress is not told per folder, the space given back is wrong, or a
 *    folder is kept without saying why.
 * 8. The processes cannot be read, and the folders are removed anyway.
 * 9. The disk's free and total space are not the disk's, or the floor is not
 *    30 GB.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execFileSync } from 'child_process';
import {
  listOrphanFolders, removeOrphanFolders, diskSpace, DISK_FLOOR_BYTES,
} from '../../../electron/services/orphan-folders';

let root: string;
let project: string;
let wt: string;
const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

/** A file of `bytes` bytes, last changed at `when`. */
function file(p: string, bytes: number, when?: Date): void {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, Buffer.alloc(bytes, 120));
  if (when) fs.utimesSync(p, when, when);
}

/** A worktree git made, then forgot: its .git points to a gitdir that is gone. */
function forgotten(p: string): void {
  fs.mkdirSync(p, { recursive: true });
  fs.writeFileSync(path.join(p, '.git'), `gitdir: ${path.join(project, '.git', 'worktrees', path.basename(p) + '-gone')}\n`);
}

beforeEach(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'tars-orphans-')));
  project = path.join(root, 'tars-hermes');
  fs.mkdirSync(project);
  git(project, 'init', '-q', '-b', 'main');
  git(project, 'config', 'user.email', 't@t.example');
  git(project, 'config', 'user.name', 'T');
  fs.writeFileSync(path.join(project, 'a.txt'), 'a\n');
  git(project, 'add', '-A');
  git(project, 'commit', '-qm', 'init');
  // A live worktree git knows, nested as a branch name nests it.
  wt = path.join(project, '.worktrees', 'feat', 'live');
  git(project, 'worktree', 'add', '-q', wt, '-b', 'feat/live');
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

const old = new Date('2026-05-01T10:00:00Z');

describe('listing', () => {
  it('1, 2, 3. lists what git forgot and what has no .git, never a live worktree, an agent\'s, or a folder that holds them', async () => {
    forgotten(path.join(project, '.worktrees', 'feat-relay-retry'));
    file(path.join(project, '.worktrees', 'feat-relay-retry', 'node_modules', 'x', 'index.js'), 4096, old);
    file(path.join(project, '.worktrees', 'agent-7f3c1a', 'notes.md'), 1024, old);
    forgotten(path.join(project, '.worktrees', 'feat', 'gone'));
    const agentOwned = path.join(project, '.worktrees', 'agent-owned');
    file(path.join(agentOwned, 'work.txt'), 10);

    const listing = await listOrphanFolders({ projects: [project], owned: [agentOwned] });
    const byName = Object.fromEntries(listing.folders.map(f => [f.name, f]));

    expect(Object.keys(byName).sort()).toEqual(['agent-7f3c1a', 'feat-relay-retry', path.join('feat', 'gone')].sort());
    expect(byName['feat-relay-retry']).toMatchObject({ project, reason: 'git-forgot', path: path.join(project, '.worktrees', 'feat-relay-retry') });
    expect(byName['agent-7f3c1a'].reason).toBe('no-git');
    expect(byName[path.join('feat', 'gone')].reason).toBe('git-forgot');
  });

  it('3. never lists a folder that holds a live worktree two levels down', async () => {
    const deep = path.join(project, '.worktrees', 'team', 'feat', 'deep');
    git(project, 'worktree', 'add', '-q', deep, '-b', 'team/feat/deep');
    const listing = await listOrphanFolders({ projects: [project], owned: [] });
    expect(listing.folders.map(f => f.name)).toEqual([]);
  });

  it('4. lists nothing outside .worktrees, and follows no link out of it', async () => {
    const outside = path.join(root, 'outside');
    file(path.join(outside, 'precious.txt'), 10);
    fs.mkdirSync(path.join(project, '.worktrees'), { recursive: true });
    fs.symlinkSync(outside, path.join(project, '.worktrees', 'a-link'));
    file(path.join(project, 'not-a-worktree', 'x.txt'), 10);
    const listing = await listOrphanFolders({ projects: [project], owned: [] });
    expect(listing.folders.map(f => f.name)).toEqual([]);
  });

  it('5. says each folder\'s size and last change, and the totals', async () => {
    forgotten(path.join(project, '.worktrees', 'one'));
    file(path.join(project, '.worktrees', 'one', 'big.bin'), 300_000, old);
    file(path.join(project, '.worktrees', 'two', 'small.bin'), 100_000, new Date('2026-06-01T10:00:00Z'));
    const listing = await listOrphanFolders({ projects: [project], owned: [] });
    const one = listing.folders.find(f => f.name === 'one')!;
    const two = listing.folders.find(f => f.name === 'two')!;
    expect(one.sizeBytes).toBeGreaterThanOrEqual(300_000);
    expect(two.sizeBytes).toBeGreaterThanOrEqual(100_000);
    expect(two.sizeBytes).toBeLessThan(one.sizeBytes);
    expect(two.lastChangedAt).toBe('2026-06-01T10:00:00.000Z');
    expect(listing).toMatchObject({ count: 2, totalBytes: one.sizeBytes + two.sizeBytes });
  });
});

describe('removing them all', () => {
  const noProcess = async () => [];

  it('6, 7. removes each orphan, tells each step and the space given back, and leaves the live worktree', async () => {
    forgotten(path.join(project, '.worktrees', 'one'));
    file(path.join(project, '.worktrees', 'one', 'big.bin'), 300_000);
    file(path.join(project, '.worktrees', 'two', 'small.bin'), 100_000);
    const before = await listOrphanFolders({ projects: [project], owned: [] });
    const steps: Array<{ done: number; total: number; freedBytes: number }> = [];

    const report = await removeOrphanFolders({ projects: [project], owned: [], processCwds: noProcess, onProgress: p => steps.push(p) });

    expect(report).toEqual({ removed: 2, freedBytes: before.totalBytes, kept: [] });
    expect(steps.map(s => [s.done, s.total])).toEqual([[1, 2], [2, 2]]);
    expect(steps[1].freedBytes).toBe(before.totalBytes);
    expect(fs.existsSync(path.join(project, '.worktrees', 'one'))).toBe(false);
    expect(fs.existsSync(path.join(project, '.worktrees', 'two'))).toBe(false);
    expect(git(wt, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe('feat/live');
  });

  it('6, 7. keeps a folder a process works in, and says so', async () => {
    file(path.join(project, '.worktrees', 'busy', 'x.txt'), 10);
    file(path.join(project, '.worktrees', 'idle', 'x.txt'), 10);
    const busy = path.join(project, '.worktrees', 'busy');
    const report = await removeOrphanFolders({
      projects: [project], owned: [],
      processCwds: async () => [{ pid: 4242, command: 'node', cwd: path.join(busy, 'sub') }],
    });
    expect(report.removed).toBe(1);
    expect(report.kept).toEqual([{ path: busy, project, reason: 'in-use', detail: 'node (4242)' }]);
    expect(fs.existsSync(busy)).toBe(true);
  });

  it('6. takes what is true when it removes: an agent that took a folder since the list keeps it', async () => {
    const taken = path.join(project, '.worktrees', 'taken');
    file(path.join(taken, 'x.txt'), 10);
    const report = await removeOrphanFolders({ projects: [project], owned: [taken], processCwds: noProcess });
    expect(report.removed).toBe(0);
    expect(fs.existsSync(taken)).toBe(true);
  });

  it('6. follows no link: a link out of .worktrees is neither listed nor removed through', async () => {
    const outside = path.join(root, 'outside');
    file(path.join(outside, 'precious.txt'), 10);
    fs.mkdirSync(path.join(project, '.worktrees'), { recursive: true });
    fs.symlinkSync(outside, path.join(project, '.worktrees', 'a-link'));
    await removeOrphanFolders({ projects: [project], owned: [], processCwds: noProcess });
    expect(fs.readFileSync(path.join(outside, 'precious.txt'), 'utf8')).toHaveLength(10);
  });

  it('8. removes nothing when the processes cannot be read, and says why for each', async () => {
    file(path.join(project, '.worktrees', 'idle', 'x.txt'), 10);
    const report = await removeOrphanFolders({ projects: [project], owned: [], processCwds: async () => null });
    expect(report.removed).toBe(0);
    expect(report.kept).toEqual([{ path: path.join(project, '.worktrees', 'idle'), project, reason: 'unknown-use' }]);
    expect(fs.existsSync(path.join(project, '.worktrees', 'idle'))).toBe(true);
  });
});

describe('the disk', () => {
  it('9. says the home disk\'s free and total space, and the 30 GB floor', () => {
    const disk = diskSpace(os.tmpdir())!;
    const s = fs.statfsSync(os.tmpdir());
    expect(disk.totalBytes).toBe(s.blocks * s.bsize);
    expect(Math.abs(disk.freeBytes - s.bavail * s.bsize)).toBeLessThan(512 * 1024 * 1024);
    expect(disk.freeBytes).toBeLessThanOrEqual(disk.totalBytes);
    expect(disk.floorBytes).toBe(30 * 1024 ** 3);
    expect(DISK_FLOOR_BYTES).toBe(disk.floorBytes);
  });
});
