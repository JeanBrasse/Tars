import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { reviewDiff, resetReviewCache } from '../../../electron/services/git-review';

/**
 * The Review page reads a file's patch only once that file is picked
 * (`review:file`), but `review:diff` built every patch of the tree alongside
 * the file list: two `git diff` runs over the whole change, up to 2 MB carried
 * over IPC, for a list (the Orchestrator's brief after #231, item 7). A
 * list-only call asks for the list and nothing else.
 *
 * How it fails, written before the code (2026-09-28):
 * 1. A list-only call still runs git for the patches, or hands one back.
 * 2. Its list is not the full call's: files, statuses, counts, untracked
 *    files, the base, ahead and behind.
 * 3. A list-only answer is kept and then handed to a full call, which gets no
 *    patch; or a full answer handed to a list-only call has its patch cleared
 *    in place, and the next full call gets none.
 * 4. Over-correction: a list-only call after a full one, with nothing
 *    changed, runs git for the list again instead of reading what is kept;
 *    or a call with no option (the Review page as it is today) loses its
 *    patch.
 * 5. The option does not cross IPC: the preload, the renderer's type or the
 *    handler drops it.
 */

vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

let tmp: string;
let repo: string;
let log: string;

function git(args: string[]): string {
  return execFileSync('git', args, { cwd: repo, encoding: 'utf8' });
}

/** The git commands Tars ran since the last call, as argument lines. */
function ran(): string[] {
  const lines = fs.existsSync(log) ? fs.readFileSync(log, 'utf8').split('\n').filter(Boolean) : [];
  // Tars runs every git with --no-optional-locks first.
  for (let i = 0; i < lines.length; i++) lines[i] = lines[i].replace(/^--no-optional-locks /, '');
  fs.writeFileSync(log, '');
  return lines;
}
const patchRuns = (lines: string[]) => lines.filter(l => /^diff(?! --numstat| --name-status)/.test(l));

beforeEach(() => {
  resetReviewCache();
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'tars-review-list-')));
  repo = path.join(tmp, 'repo');
  fs.mkdirSync(repo);
  git(['init', '-q', '-b', 'main']);
  git(['config', 'user.email', 't@t.com']);
  git(['config', 'user.name', 't']);
  fs.writeFileSync(path.join(repo, 'a.txt'), 'one\n');
  fs.writeFileSync(path.join(repo, 'gone.txt'), 'bye\n');
  git(['add', '-A']);
  git(['commit', '-qm', 'init']);
  git(['checkout', '-qb', 'feat']);
  fs.writeFileSync(path.join(repo, 'a.txt'), 'one\ntwo\n');
  git(['rm', '-q', 'gone.txt']);
  git(['commit', '-qam', 'two']);
  fs.writeFileSync(path.join(repo, 'a.txt'), 'one\ntwo\nthree\n');
  fs.writeFileSync(path.join(repo, 'new.txt'), 'x\ny\n');

  // Every git Tars runs goes through this one, which writes down its arguments.
  const realGit = execFileSync('which', ['git'], { encoding: 'utf8' }).trim();
  const bin = path.join(tmp, 'bin');
  fs.mkdirSync(bin);
  log = path.join(tmp, 'git.log');
  fs.writeFileSync(path.join(bin, 'git'), `#!/bin/sh\necho "$*" >> "${log}"\nexec "${realGit}" "$@"\n`, { mode: 0o755 });
  vi.stubEnv('PATH', `${bin}:${process.env.PATH}`);
});

afterEach(() => {
  vi.unstubAllEnvs();
  fs.rmSync(tmp, { recursive: true, force: true });
});

const listOnly = { listOnly: true } as Parameters<typeof reviewDiff>[1];

describe('the review diff, asked for its list only', () => {
  it('1, 2. runs no git for the patches, hands none back, and lists what the full call lists', async () => {
    const list = await reviewDiff(repo, listOnly);
    const listRuns = ran();
    resetReviewCache();
    const full = await reviewDiff(repo);
    const fullRuns = ran();

    expect(patchRuns(fullRuns).length, 'the full call builds patches').toBeGreaterThan(0);
    expect(patchRuns(listRuns)).toEqual([]);
    expect(list.patch).toBe('');
    expect(list.truncated).toBe(false);
    const { patch: _p, truncated: _t, ...fullRest } = full;
    const { patch: _lp, truncated: _lt, ...listRest } = list;
    expect(listRest).toEqual(fullRest);
    expect(list.files.map(f => [f.path, f.status])).toEqual(expect.arrayContaining([
      ['a.txt', 'modified'], ['gone.txt', 'deleted'], ['new.txt', 'untracked'],
    ]));
  });

  it('3. hands a full call its patch after a list-only one, and keeps the full patch after a list-only read of it', async () => {
    await reviewDiff(repo, listOnly);
    const full = await reviewDiff(repo);
    expect(full.patch).toContain('+three');

    const list = await reviewDiff(repo, listOnly);
    expect(list.patch).toBe('');
    expect((await reviewDiff(repo)).patch).toContain('+three');
  });

  it('4. reads a list-only call from a full answer kept, and leaves the default call its patch', async () => {
    const full = await reviewDiff(repo);
    expect(full.patch).toContain('+two');
    ran();

    const list = await reviewDiff(repo, listOnly);

    expect(list.files).toEqual(full.files);
    expect(ran().filter(l => /^diff|^ls-files|^rev-list/.test(l))).toEqual([]);
  });
});

describe('the option, across IPC', () => {
  const read = (file: string) => fs.readFileSync(path.join(__dirname, '../../..', file), 'utf8');

  it('5. is passed by the preload, typed for the renderer, and handed on by the handler', () => {
    expect(read('electron/preload.ts')).toMatch(/diff: \(repoPath: string, baseBranch\?: string, opts\?: \{ listOnly\?: boolean \}\) =>\s*ipcRenderer\.invoke\('review:diff', \{ repoPath, baseBranch, listOnly: opts\?\.listOnly === true \}\)/);
    expect(read('src/types/electron.d.ts')).toMatch(/diff: \(repoPath: string, baseBranch\?: string, opts\?: \{ listOnly\?: boolean \}\) =>/);
    expect(read('electron/handlers/ipc-handlers.ts')).toMatch(/reviewDiff\(repoPath, \{ baseBranch, listOnly: listOnly === true \}\)/);
  });
});
