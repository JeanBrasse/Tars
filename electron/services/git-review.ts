import { execFile } from 'child_process';
import { promisify } from 'util';
import * as fs from 'fs';
import * as path from 'path';

const run = promisify(execFile);

/**
 * What an agent actually changed.
 *
 * The Git panel ran `git diff --stat | tail -20` through a shell and showed
 * twenty lines of summary - no patch, no per-file view, and a shell command
 * built by string concatenation. Everything here goes through execFile with an
 * argv array: no shell, so a branch or path containing a quote or a semicolon
 * is data, not syntax.
 */

const MAX_PATCH_BYTES = 2_000_000;

export interface ChangedFile {
  path: string;
  status: 'added' | 'modified' | 'deleted' | 'renamed' | 'untracked';
  additions: number;
  deletions: number;
}

export interface ReviewDiff {
  repo: string;
  branch: string;
  baseBranch: string | null;
  ahead: number;
  behind: number;
  files: ChangedFile[];
  totalAdditions: number;
  totalDeletions: number;
  /** Unified patch, capped. Empty when nothing changed. */
  patch: string;
  truncated: boolean;
}

async function git(cwd: string, args: string[], maxBuffer = 8 * 1024 * 1024): Promise<string> {
  const { stdout } = await run('git', args, { cwd, maxBuffer, timeout: 30_000 });
  return stdout;
}

async function tryGit(cwd: string, args: string[]): Promise<string> {
  try {
    return await git(cwd, args);
  } catch {
    return '';
  }
}

/**
 * A ref name that git cannot mistake for an option.
 *
 * Every rev range here is interpolated as `${baseBranch}...HEAD`, which lands
 * in an argv slot git still parses for options - `--` only protects the
 * pathspec that comes after it. A "branch" of `--output=/somewhere/else` made
 * `git diff --numstat --output=/somewhere/else...HEAD` write the patch to a
 * file outside the repo. `fileDiff` guarded its path against a leading dash
 * and left the base branch unguarded; both go through here now.
 *
 * The first character excludes `-` and `/` so no value can start an option,
 * and the rest is the branch/remote alphabet (`origin/feat/x-1.2`).
 */
const SAFE_REF = /^[A-Za-z0-9._][A-Za-z0-9._/-]*$/;

function assertSafeRef(ref: string): string {
  if (!SAFE_REF.test(ref)) throw new Error(`invalid base branch: ${ref}`);
  return ref;
}

function statusFromCode(code: string): ChangedFile['status'] {
  if (code.startsWith('A')) return 'added';
  if (code.startsWith('D')) return 'deleted';
  if (code.startsWith('R')) return 'renamed';
  if (code.startsWith('?')) return 'untracked';
  return 'modified';
}

/**
 * The branch this work should be compared against.
 *
 * The upstream is the wrong answer when it is just origin/<this branch>:
 * comparing an agent's branch to its own remote copy shows nothing, when the
 * question is what the agent changed relative to the trunk it branched from.
 */
async function detectBaseBranch(cwd: string, current: string): Promise<string | null> {
  for (const candidate of ['main', 'master', 'develop']) {
    if (candidate === current) continue;
    const exists = await tryGit(cwd, ['rev-parse', '--verify', '--quiet', candidate]);
    if (exists.trim()) return candidate;
  }

  // The upstream is repo-controlled: a .git/config with `[remote "-evil"]`
  // makes this print `-evil/work`, which would reach the rev-range argv slot
  // with no caller involved. An unusable name is the same as no base branch.
  const upstream = (await tryGit(cwd, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}'])).trim();
  if (upstream && SAFE_REF.test(upstream) && !upstream.endsWith(`/${current}`)) return upstream;

  return null;
}

/**
 * Everything this working tree changed: committed since the base branch, plus
 * whatever is still uncommitted. That is the question a reviewer actually has.
 */
export async function reviewDiff(repoPath: string, opts: { baseBranch?: string } = {}): Promise<ReviewDiff> {
  if (!repoPath || !fs.existsSync(repoPath)) {
    throw new Error(`path does not exist: ${repoPath}`);
  }
  const inside = (await tryGit(repoPath, ['rev-parse', '--is-inside-work-tree'])).trim();
  if (inside !== 'true') throw new Error('not a git repository');

  const branch = (await tryGit(repoPath, ['rev-parse', '--abbrev-ref', 'HEAD'])).trim() || 'HEAD';
  // A caller-supplied base is untrusted: it crosses IPC from the renderer.
  const baseBranch = opts.baseBranch
    ? assertSafeRef(opts.baseBranch)
    : opts.baseBranch ?? await detectBaseBranch(repoPath, branch);

  let ahead = 0;
  let behind = 0;
  if (baseBranch) {
    const counts = (await tryGit(repoPath, ['rev-list', '--left-right', '--count', `${baseBranch}...HEAD`])).trim();
    const [b, a] = counts.split(/\s+/).map(Number);
    behind = Number.isFinite(b) ? b : 0;
    ahead = Number.isFinite(a) ? a : 0;
  }

  // Numstat covers committed work since the base plus the working tree.
  const range = baseBranch ? [`${baseBranch}...HEAD`] : [];
  const numstat = [
    await tryGit(repoPath, ['diff', '--numstat', ...range]),
    await tryGit(repoPath, ['diff', '--numstat', 'HEAD']),
  ].join('\n');

  const nameStatus = [
    await tryGit(repoPath, ['diff', '--name-status', ...range]),
    await tryGit(repoPath, ['diff', '--name-status', 'HEAD']),
  ].join('\n');

  const statusByPath = new Map<string, ChangedFile['status']>();
  for (const line of nameStatus.split('\n')) {
    const [code, ...rest] = line.trim().split('\t');
    const file = rest[rest.length - 1];
    if (code && file) statusByPath.set(file, statusFromCode(code));
  }

  const files = new Map<string, ChangedFile>();
  for (const line of numstat.split('\n')) {
    const parts = line.trim().split('\t');
    if (parts.length < 3) continue;
    const [add, del, file] = parts;
    if (!file) continue;
    const existing = files.get(file);
    const additions = add === '-' ? 0 : Number(add) || 0;
    const deletions = del === '-' ? 0 : Number(del) || 0;
    if (existing) {
      existing.additions = Math.max(existing.additions, additions);
      existing.deletions = Math.max(existing.deletions, deletions);
    } else {
      files.set(file, { path: file, status: statusByPath.get(file) ?? 'modified', additions, deletions });
    }
  }

  // Untracked files never appear in a diff, and they are usually the point.
  const untracked = (await tryGit(repoPath, ['ls-files', '--others', '--exclude-standard'])).trim();
  for (const file of untracked.split('\n').filter(Boolean)) {
    if (files.has(file)) continue;
    let additions = 0;
    try {
      const full = path.join(repoPath, file);
      if (fs.statSync(full).size < 512_000) {
        additions = fs.readFileSync(full, 'utf-8').split('\n').length;
      }
    } catch { /* binary or unreadable: count as 0 */ }
    files.set(file, { path: file, status: 'untracked', additions, deletions: 0 });
  }

  let patch = [
    await tryGit(repoPath, ['diff', ...range]),
    await tryGit(repoPath, ['diff', 'HEAD']),
  ].filter(Boolean).join('\n');

  const truncated = patch.length > MAX_PATCH_BYTES;
  if (truncated) patch = `${patch.slice(0, MAX_PATCH_BYTES)}\n… patch truncated`;

  const list = Array.from(files.values()).sort((a, b) =>
    (b.additions + b.deletions) - (a.additions + a.deletions));

  return {
    repo: repoPath,
    branch,
    baseBranch,
    ahead,
    behind,
    files: list,
    totalAdditions: list.reduce((n, f) => n + f.additions, 0),
    totalDeletions: list.reduce((n, f) => n + f.deletions, 0),
    patch,
    truncated,
  };
}

const MAX_FILE_PATCH_BYTES = 400_000;

function cap(patch: string): string {
  return patch.length > MAX_FILE_PATCH_BYTES
    ? `${patch.slice(0, MAX_FILE_PATCH_BYTES)}\n… patch truncated`
    : patch;
}

/** The patch for one file, for a focused read. */
export async function fileDiff(repoPath: string, file: string, baseBranch?: string): Promise<string> {
  // A leading dash would be read as a flag rather than a path.
  if (file.startsWith('-')) throw new Error('invalid path');
  // Same reason, for the value that is *not* behind the `--` separator.
  if (baseBranch) assertSafeRef(baseBranch);

  const range = baseBranch ? [`${baseBranch}...HEAD`] : [];
  const committed = await tryGit(repoPath, ['diff', ...range, '--', file]);
  const working = await tryGit(repoPath, ['diff', 'HEAD', '--', file]);
  const both = [committed, working].filter(Boolean).join('\n');
  if (both) return cap(both);

  // Untracked: show it as an addition rather than nothing. A generated
  // bundle can be megabytes, and nobody reviews that in a panel.
  try {
    const full = path.join(repoPath, file);
    if (fs.statSync(full).size > MAX_FILE_PATCH_BYTES) {
      return `+++ b/${file}\n… file is too large to show (${Math.round(fs.statSync(full).size / 1024)} KB)`;
    }
    const content = fs.readFileSync(full, 'utf-8');
    return cap(`--- /dev/null\n+++ b/${file}\n${content.split('\n').map(l => `+${l}`).join('\n')}`);
  } catch {
    return '';
  }
}

export interface RepoSummary {
  branch: string;
  status: { status: string; file: string }[];
  commits: { hash: string; subject: string; author: string; when: string }[];
  additions: number;
  deletions: number;
}

/**
 * Everything the Git panel used to gather with four shell pipelines.
 *
 * It built `git status --porcelain`, `git diff --stat | tail -20` and a
 * `--pretty` log as strings and ran them through a login shell; here git runs
 * with an argv array and the parsing happens once, in one place.
 */
export async function repoSummary(repoPath: string): Promise<RepoSummary> {
  if (!repoPath || !fs.existsSync(repoPath)) throw new Error('no such directory');

  const branch = (await tryGit(repoPath, ['rev-parse', '--abbrev-ref', 'HEAD'])).trim() || 'unknown';

  const status = (await tryGit(repoPath, ['status', '--porcelain', '--untracked-files=all']))
    .split('\n')
    .filter(line => line.length >= 3)
    .map(line => {
      const code = line.slice(0, 2);
      const file = line.slice(3).trim();
      const state = code.includes('?') ? 'new'
        : code.includes('A') ? 'added'
        : code.includes('D') ? 'deleted'
        : code.includes('R') ? 'renamed'
        : 'modified';
      return { status: state, file };
    })
    .filter(entry => entry.file);

  const commits = (await tryGit(repoPath, ['log', '--pretty=format:%h%x1f%s%x1f%an%x1f%ar', '-10']))
    .split('\n')
    .filter(Boolean)
    .map(line => {
      const [hash, subject, author, when] = line.split('\x1f');
      return { hash, subject, author, when };
    });

  let additions = 0;
  let deletions = 0;
  for (const line of (await tryGit(repoPath, ['diff', '--numstat', 'HEAD'])).split('\n')) {
    const [add, del] = line.split('\t');
    additions += add === '-' ? 0 : Number(add) || 0;
    deletions += del === '-' ? 0 : Number(del) || 0;
  }

  return { branch, status, commits, additions, deletions };
}
