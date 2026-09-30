import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import {
  openRepo,
  createWorktree,
  removeWorktree,
  prune,
  status,
  installedMatches,
  WorktreeRefusal,
} from '../../scripts/worktree.mjs';

/**
 * The team's worktree tool: create, remove, prune, status.
 *
 * On 01/10 the Mac crashed with 68 MB free. ~/tars/.worktrees weighed 46 GB
 * across 59 worktrees, most with a full npm ci of their own and a .next cache,
 * and nothing ever removed one.
 *
 * Every way this tool can fail, written before it existed:
 * 1. it creates a worktree with the disk under 30 GB free, or past the cap;
 * 2. it counts only the worktrees it made, and one made by hand slips past the cap;
 * 3. a name with a slash or `..` puts a checkout outside .worktrees/;
 * 4. node_modules is a symlink (next dev refuses one that leaves its root,
 *    measured 30/09), or a symlinked node_modules is taken as a source;
 * 5. it runs a full npm ci where a clone would do, or skips npm when the
 *    clone's lock differs;
 * 6. the clone comes without the Electron binary and nothing fetches it;
 * 7. removal loses work: uncommitted files, or commits on a detached HEAD no
 *    branch holds;
 * 8. --save rewrites the worktree's own branch instead of a wip/ branch;
 * 9. it removes a worktree a process is working in, a locked one, or the
 *    main checkout;
 * 10. it passes --force to git;
 * 11. prune removes an active worktree, an open PR's, or a merged one before
 *     its grace (a fresh worktree of main looks merged);
 * 12. prune never runs because nobody schedules it;
 * 13. a dry run removes something.
 *
 * Every repository here is a throwaway one in the temp directory. Free space,
 * the processes' working directories, the clock, npm and gh are handed in, so
 * no test depends on this machine's disk, its processes or the network.
 */

const GB = 1024 ** 3;
const HOUR = 3600_000;
const DAY = 24 * HOUR;

beforeAll(() => {
  // --save commits, and a throwaway HOME has no git identity.
  process.env.GIT_AUTHOR_NAME = 'Test';
  process.env.GIT_AUTHOR_EMAIL = 'test@example.invalid';
  process.env.GIT_COMMITTER_NAME = 'Test';
  process.env.GIT_COMMITTER_EMAIL = 'test@example.invalid';
});

const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();

const LOCK = (version: string) => JSON.stringify({
  name: 'fixture',
  lockfileVersion: 3,
  packages: { '': { name: 'fixture' }, 'node_modules/left-pad': { version, integrity: `sha-${version}` } },
});
const INSTALLED = (version: string) => JSON.stringify({
  name: 'fixture',
  lockfileVersion: 3,
  packages: { 'node_modules/left-pad': { version, integrity: `sha-${version}` } },
});

/** A main checkout with one commit, .worktrees/ ignored as in the real repository, and an installed node_modules. */
function makeRepo(opts: { installed?: string | null } = {}): string {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'tars-wt-')));
  git(root, 'init', '-q', '-b', 'main');
  fs.writeFileSync(path.join(root, '.gitignore'), '/node_modules\n/.next/\n.worktrees/\n');
  fs.writeFileSync(path.join(root, 'package-lock.json'), LOCK('1.0.0'));
  fs.writeFileSync(path.join(root, 'README.md'), 'hello\n');
  git(root, 'add', '-A');
  git(root, 'commit', '-q', '-m', 'init');
  const installed = opts.installed === undefined ? '1.0.0' : opts.installed;
  if (installed) {
    fs.mkdirSync(path.join(root, 'node_modules', 'left-pad'), { recursive: true });
    fs.writeFileSync(path.join(root, 'node_modules', 'left-pad', 'index.js'), 'module.exports = 1;\n');
    fs.writeFileSync(path.join(root, 'node_modules', '.package-lock.json'), INSTALLED(installed));
  }
  return root;
}

type Call = { command: string; args: string[]; cwd?: string };

/** What the outside world answers, and a record of the commands the tool ran other than git and cp. */
function world(over: Partial<{ free: number; cwds: { pid: number; command: string; cwd: string }[]; now: number; pr: Record<string, string> }> = {}) {
  const calls: Call[] = [];
  const gitCalls: string[][] = [];
  const ctx = {
    freeBytes: () => over.free ?? 200 * GB,
    processCwds: async () => over.cwds ?? [],
    now: () => over.now ?? Date.now(),
    prState: async (branch: string) => over.pr?.[branch] ?? null,
    runTool: async (command: string, args: string[], options: { cwd?: string } = {}) => {
      calls.push({ command, args, cwd: options.cwd });
      return { code: 0, stdout: '', stderr: '' };
    },
    onGit: (args: string[]) => { gitCalls.push(args); },
    minFreeGb: 30,
    max: 20,
    log: () => {},
  };
  return { ctx, calls, gitCalls };
}

const refusal = async (p: Promise<unknown>) => {
  const error = await p.then(() => null, (e: unknown) => e);
  expect(error).toBeInstanceOf(WorktreeRefusal);
  return (error as Error).message;
};

describe('new', () => {
  let root: string;
  beforeEach(() => { root = makeRepo(); });

  it('creates .worktrees/<name> on a new branch from the base, and records whom it serves', async () => {
    const { ctx } = world();
    const repo = await openRepo(root);
    const wt = await createWorktree(repo, 'fix-thing', { branch: 'fix/thing', from: 'main', agent: 'Tars-Backend', task: '#235' }, ctx);

    expect(wt.path).toBe(path.join(root, '.worktrees', 'fix-thing'));
    expect(git(wt.path, 'branch', '--show-current')).toBe('fix/thing');
    const registry = JSON.parse(fs.readFileSync(path.join(root, '.worktrees', '.registry.json'), 'utf8'));
    expect(registry['fix-thing']).toMatchObject({ branch: 'fix/thing', agent: 'Tars-Backend', task: '#235' });
  });

  it('refuses under 30 GB free and creates nothing', async () => {
    const { ctx } = world({ free: 29 * GB });
    const repo = await openRepo(root);

    const message = await refusal(createWorktree(repo, 'fix-thing', { from: 'main' }, ctx));
    expect(message).toMatch(/29(\.0)? GB free/);
    expect(message).toMatch(/30 GB/);
    expect(fs.existsSync(path.join(root, '.worktrees', 'fix-thing'))).toBe(false);
    expect(git(root, 'branch', '--list', 'fix-thing')).toBe('');
  });

  it('refuses at the cap, counting every worktree of the repository but the main checkout', async () => {
    const { ctx } = world();
    ctx.max = 2;
    const repo = await openRepo(root);
    await createWorktree(repo, 'one', { from: 'main' }, ctx);
    // Made by hand, outside the tool: it counts all the same.
    git(root, 'worktree', 'add', '-q', '-b', 'two', path.join(root, '.worktrees', 'two'), 'main');

    const message = await refusal(createWorktree(repo, 'three', { from: 'main' }, ctx));
    expect(message).toMatch(/2 worktrees/);
    expect(fs.existsSync(path.join(root, '.worktrees', 'three'))).toBe(false);
  });

  it('refuses a name that is a path', async () => {
    const { ctx } = world();
    const repo = await openRepo(root);
    await refusal(createWorktree(repo, '../escape', { from: 'main' }, ctx));
    await refusal(createWorktree(repo, 'a/b', { from: 'main' }, ctx));
    expect(fs.existsSync(path.join(root, 'escape'))).toBe(false);
  });
});

describe('dependencies', () => {
  it('clones an installed node_modules at the same lock into a real folder, and runs no npm', async () => {
    const root = makeRepo();
    const { ctx, calls } = world();
    const repo = await openRepo(root);
    const wt = await createWorktree(repo, 'deps-same', { from: 'main' }, ctx);

    const nm = path.join(wt.path, 'node_modules');
    expect(fs.lstatSync(nm).isSymbolicLink()).toBe(false);
    expect(fs.lstatSync(nm).isDirectory()).toBe(true);
    expect(fs.readFileSync(path.join(nm, 'left-pad', 'index.js'), 'utf8')).toContain('module.exports');
    expect(calls.filter(c => c.command === 'npm' || c.command === 'npx')).toEqual([]);
  });

  it('clones the nearest one and reconciles it with npm install when the lock differs', async () => {
    const root = makeRepo({ installed: '0.9.0' });
    const { ctx, calls } = world();
    const repo = await openRepo(root);
    const wt = await createWorktree(repo, 'deps-differ', { from: 'main' }, ctx);

    expect(fs.existsSync(path.join(wt.path, 'node_modules', 'left-pad', 'index.js'))).toBe(true);
    expect(calls).toContainEqual(expect.objectContaining({ command: 'npm', args: expect.arrayContaining(['install']), cwd: wt.path }));
    expect(calls.some(c => c.command === 'npm' && c.args.includes('ci'))).toBe(false);
  });

  it('installs from scratch only when there is nothing to clone', async () => {
    const root = makeRepo({ installed: null });
    const { ctx, calls } = world();
    const repo = await openRepo(root);
    const wt = await createWorktree(repo, 'deps-none', { from: 'main' }, ctx);

    expect(calls).toContainEqual(expect.objectContaining({ command: 'npm', args: expect.arrayContaining(['ci']), cwd: wt.path }));
  });

  it('never takes a symlinked node_modules as a source, nor makes one', async () => {
    const root = makeRepo({ installed: null });
    const elsewhere = makeRepo();
    fs.symlinkSync(path.join(elsewhere, 'node_modules'), path.join(root, 'node_modules'));
    const { ctx, calls } = world();
    const repo = await openRepo(root);
    const wt = await createWorktree(repo, 'deps-link', { from: 'main' }, ctx);

    expect(fs.existsSync(path.join(wt.path, 'node_modules')) && fs.lstatSync(path.join(wt.path, 'node_modules')).isSymbolicLink()).toBe(false);
    expect(calls.some(c => c.command === 'npm' && c.args.includes('ci'))).toBe(true);
  });

  it('fetches the Electron binary when the clone has none', async () => {
    const root = makeRepo();
    fs.mkdirSync(path.join(root, 'node_modules', 'electron'), { recursive: true });
    fs.writeFileSync(path.join(root, 'node_modules', 'electron', 'package.json'), '{}');
    const { ctx, calls } = world();
    const repo = await openRepo(root);
    const wt = await createWorktree(repo, 'deps-electron', { from: 'main' }, ctx);

    expect(calls).toContainEqual(expect.objectContaining({ command: 'npx', args: expect.arrayContaining(['install-electron']), cwd: wt.path }));
  });

  it('reads an installed tree against a lock', () => {
    const root = makeRepo();
    expect(installedMatches(path.join(root, 'node_modules'), path.join(root, 'package-lock.json'))).toBe(true);
    fs.writeFileSync(path.join(root, 'node_modules', '.package-lock.json'), INSTALLED('2.0.0'));
    expect(installedMatches(path.join(root, 'node_modules'), path.join(root, 'package-lock.json'))).toBe(false);
    fs.rmSync(path.join(root, 'node_modules', '.package-lock.json'));
    expect(installedMatches(path.join(root, 'node_modules'), path.join(root, 'package-lock.json'))).toBe(false);
  });
});

describe('remove', () => {
  let root: string;
  beforeEach(() => { root = makeRepo(); });

  async function made(name: string, branch = name) {
    const { ctx } = world();
    const repo = await openRepo(root);
    const wt = await createWorktree(repo, name, { branch, from: 'main' }, ctx);
    return { repo, wt };
  }

  it('removes a clean worktree with its node_modules, keeps its branch, and never passes --force', async () => {
    const { repo, wt } = await made('done');
    fs.writeFileSync(path.join(wt.path, 'README.md'), 'changed\n');
    git(wt.path, 'commit', '-q', '-am', 'work');
    const head = git(wt.path, 'rev-parse', 'HEAD');
    const { ctx, gitCalls } = world();

    await removeWorktree(repo, 'done', {}, ctx);

    expect(fs.existsSync(wt.path)).toBe(false);
    expect(git(root, 'rev-parse', 'done')).toBe(head);
    expect(gitCalls.flat()).not.toContain('--force');
    expect(gitCalls.flat()).not.toContain('-f');
    const registry = JSON.parse(fs.readFileSync(path.join(root, '.worktrees', '.registry.json'), 'utf8'));
    expect(registry.done).toBeUndefined();
    const log = fs.readFileSync(path.join(root, '.worktrees', '.removed.log'), 'utf8');
    expect(log).toContain(head);
  });

  it('refuses a dirty worktree and names what is uncommitted', async () => {
    const { repo, wt } = await made('dirty');
    fs.writeFileSync(path.join(wt.path, 'README.md'), 'changed\n');
    fs.writeFileSync(path.join(wt.path, 'new-file.txt'), 'x');
    const { ctx } = world();

    const message = await refusal(removeWorktree(repo, 'dirty', {}, ctx));
    expect(message).toContain('README.md');
    expect(message).toContain('new-file.txt');
    expect(fs.existsSync(path.join(wt.path, 'new-file.txt'))).toBe(true);
  });

  it('with --save, commits the uncommitted work on wip/<name> and leaves the branch as it was', async () => {
    const { repo, wt } = await made('saved', 'feat/saved');
    const before = git(wt.path, 'rev-parse', 'HEAD');
    fs.writeFileSync(path.join(wt.path, 'README.md'), 'changed\n');
    fs.writeFileSync(path.join(wt.path, 'new-file.txt'), 'x');
    const { ctx } = world();

    await removeWorktree(repo, 'saved', { save: true }, ctx);

    expect(fs.existsSync(wt.path)).toBe(false);
    expect(git(root, 'rev-parse', 'feat/saved')).toBe(before);
    expect(git(root, 'show', 'wip/saved:new-file.txt')).toBe('x');
    expect(git(root, 'show', 'wip/saved:README.md')).toBe('changed');
  });

  it('gives a detached HEAD on no branch a wip/<name> branch before removing it', async () => {
    const { repo, wt } = await made('loose');
    git(wt.path, 'checkout', '-q', '--detach');
    fs.writeFileSync(path.join(wt.path, 'README.md'), 'orphan\n');
    git(wt.path, 'commit', '-q', '-am', 'orphan work');
    const head = git(wt.path, 'rev-parse', 'HEAD');
    git(root, 'branch', '-q', '-D', 'loose');
    const { ctx } = world();

    await removeWorktree(repo, 'loose', {}, ctx);

    expect(git(root, 'rev-parse', 'wip/loose')).toBe(head);
  });

  it('leaves a worktree some process works in', async () => {
    const { repo, wt } = await made('busy');
    const { ctx } = world({ cwds: [{ pid: 4242, command: 'claude', cwd: path.join(wt.path, 'src') }] });

    const message = await refusal(removeWorktree(repo, 'busy', {}, ctx));
    expect(message).toContain('4242');
    expect(fs.existsSync(wt.path)).toBe(true);
  });

  it('never removes the main checkout', async () => {
    const { ctx } = world();
    const repo = await openRepo(root);
    await refusal(removeWorktree(repo, root, {}, ctx));
    expect(fs.existsSync(path.join(root, 'README.md'))).toBe(true);
  });
});

describe('prune', () => {
  let root: string;
  beforeEach(() => { root = makeRepo(); });

  /** A worktree whose branch carries one commit of its own. */
  async function withCommit(name: string) {
    const { ctx } = world();
    const repo = await openRepo(root);
    const wt = await createWorktree(repo, name, { from: 'main' }, ctx);
    fs.writeFileSync(path.join(wt.path, `${name}.txt`), name);
    git(wt.path, 'add', '-A');
    git(wt.path, 'commit', '-q', '-m', name);
    return { repo, wt };
  }

  it('removes a worktree inactive for longer than --older-than, and keeps a recent one', async () => {
    const { repo, wt } = await withCommit('stale');

    const recent = await prune(repo, { olderThanDays: 7 }, world({ now: Date.now() + 6 * DAY }).ctx);
    expect(recent.removed).toEqual([]);
    expect(fs.existsSync(wt.path)).toBe(true);

    const old = await prune(repo, { olderThanDays: 7 }, world({ now: Date.now() + 8 * DAY }).ctx);
    expect(old.removed.map(r => r.name)).toEqual(['stale']);
    expect(fs.existsSync(wt.path)).toBe(false);
  });

  it('removes one merged into the base a day after its last activity, not before', async () => {
    const { repo, wt } = await withCommit('merged');
    git(root, 'merge', '-q', '--ff-only', 'merged');

    expect((await prune(repo, { olderThanDays: 7, base: 'main' }, world({ now: Date.now() + 2 * HOUR }).ctx)).removed).toEqual([]);
    const later = await prune(repo, { olderThanDays: 7, base: 'main' }, world({ now: Date.now() + 25 * HOUR }).ctx);
    expect(later.removed).toEqual([expect.objectContaining({ name: 'merged', why: expect.stringMatching(/merged/) })]);
    expect(fs.existsSync(wt.path)).toBe(false);
  });

  it('removes one whose PR was merged or closed an hour after its last activity', async () => {
    const { repo, wt } = await withCommit('closed');

    const soon = await prune(repo, { olderThanDays: 7, github: true }, world({ now: Date.now() + 10 * 60_000, pr: { closed: 'CLOSED' } }).ctx);
    expect(soon.removed).toEqual([]);
    const later = await prune(repo, { olderThanDays: 7, github: true }, world({ now: Date.now() + 2 * HOUR, pr: { closed: 'CLOSED' } }).ctx);
    expect(later.removed.map(r => r.name)).toEqual(['closed']);
    expect(fs.existsSync(wt.path)).toBe(false);
  });

  it('keeps an open PR', async () => {
    const { repo, wt } = await withCommit('open');
    const result = await prune(repo, { olderThanDays: 7, github: true }, world({ now: Date.now() + 2 * HOUR, pr: { open: 'OPEN' } }).ctx);
    expect(result.removed).toEqual([]);
    expect(fs.existsSync(wt.path)).toBe(true);
  });

  it('keeps a dirty one, a locked one and a busy one, and says why', async () => {
    const dirty = (await withCommit('dirty')).wt;
    fs.writeFileSync(path.join(dirty.path, 'scratch.txt'), 'x');
    const locked = (await withCommit('locked')).wt;
    git(root, 'worktree', 'lock', locked.path);
    const { repo, wt: busy } = await withCommit('busy');

    const result = await prune(repo, { olderThanDays: 7 }, world({
      now: Date.now() + 30 * DAY,
      cwds: [{ pid: 77, command: 'node', cwd: busy.path }],
    }).ctx);

    expect(result.removed).toEqual([]);
    const why = Object.fromEntries(result.kept.map(k => [k.name, k.why]));
    expect(why.dirty).toContain('scratch.txt');
    expect(why.locked).toMatch(/locked/);
    expect(why.busy).toContain('77');
    for (const wt of [dirty, locked, busy]) expect(fs.existsSync(wt.path)).toBe(true);
  });

  it('removes nothing on a dry run', async () => {
    const { repo, wt } = await withCommit('dry');
    const result = await prune(repo, { olderThanDays: 7, dryRun: true }, world({ now: Date.now() + 30 * DAY }).ctx);
    expect(result.removed.map(r => r.name)).toEqual(['dry']);
    expect(fs.existsSync(wt.path)).toBe(true);
  });

  it('runs before every new worktree, so the cleanup needs no schedule of its own', async () => {
    const { repo, wt } = await withCommit('forgotten');
    const { ctx } = world({ now: Date.now() + 30 * DAY });

    await createWorktree(repo, 'fresh', { from: 'main' }, ctx);

    expect(fs.existsSync(wt.path)).toBe(false);
    expect(fs.existsSync(path.join(root, '.worktrees', 'fresh'))).toBe(true);
  });
});

describe('status', () => {
  it('lists every worktree with its branch, owner, activity and state, and the free space against the floor', async () => {
    const root = makeRepo();
    const { ctx } = world({ free: 100 * GB });
    const repo = await openRepo(root);
    const wt = await createWorktree(repo, 'shown', { branch: 'feat/shown', from: 'main', agent: 'Tars-QA', task: 'gate' }, ctx);
    fs.writeFileSync(path.join(wt.path, 'x.txt'), 'x');

    const report = await status(repo, ctx);

    expect(report.freeGb).toBe(100);
    expect(report.minFreeGb).toBe(30);
    expect(report.max).toBe(20);
    expect(report.worktrees).toEqual([expect.objectContaining({
      name: 'shown', branch: 'feat/shown', agent: 'Tars-QA', task: 'gate', dirty: ['x.txt'], deps: 'folder',
    })]);
  });
});
