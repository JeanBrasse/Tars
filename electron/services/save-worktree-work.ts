import { execFile } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

/**
 * An agent's uncommitted work, saved on wip/<name> before its worktree goes
 * (Noah, 05/10: deleting an agent saves it first, without asking). The window's
 * delete removed the worktree with `git worktree remove --force`, and whatever
 * was not committed went with it.
 *
 * Made with a throwaway index and `commit-tree`: the worktree's files and
 * branch are not touched, the agent's own branch does not move, and no hook of
 * the repository runs. The commit's parent is the worktree's HEAD.
 */

function git(cwd: string, args: string[], env: NodeJS.ProcessEnv = process.env): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile('git', args, { cwd, env, maxBuffer: 16 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) reject(new Error(`git ${args[0]} failed: ${String(stderr || err.message).trim().slice(0, 300)}`));
      else resolve(String(stdout).trim());
    });
  });
}

/** wip/<name>, a ref git takes whatever the agent is called. */
export function wipBranchName(name: string): string {
  const slug = name.toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60)
    .replace(/-+$/g, '');
  return `wip/${slug || 'agent'}`;
}

/**
 * Commits what `worktreePath` has not committed (changes and untracked files)
 * on a new wip/<name>, the next free one. Null when there is nothing to save.
 * Throws when it could not save: the caller must then keep the worktree.
 */
export async function saveUncommittedWork(worktreePath: string, name: string): Promise<{ branch: string } | null> {
  const status = await git(worktreePath, ['status', '--porcelain', '--untracked-files=all']);
  if (!status) return null;

  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'tars-wip-index-'));
  try {
    const env = { ...process.env, GIT_INDEX_FILE: path.join(scratch, 'index') };
    await git(worktreePath, ['read-tree', 'HEAD'], env);
    await git(worktreePath, ['add', '-A'], env);
    const tree = await git(worktreePath, ['write-tree'], env);
    const head = await git(worktreePath, ['rev-parse', 'HEAD']);
    const commit = await git(worktreePath, ['commit-tree', tree, '-p', head, '-m', `wip: ${name}'s uncommitted work, saved by Tars when the agent was deleted`]);

    const base = wipBranchName(name);
    for (let n = 1; n < 100; n++) {
      const branch = n === 1 ? base : `${base}-${n}`;
      try {
        await git(worktreePath, ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`]);
      } catch {
        await git(worktreePath, ['branch', branch, commit]);
        return { branch };
      }
    }
    throw new Error(`no free name for ${base}`);
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
}
