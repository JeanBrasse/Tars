import * as path from 'path';
import { isUnsafePathSegment } from '../platform/windows-names';

/**
 * Where an agent's git worktree is allowed to live.
 *
 * A branch name reaches here from the new-agent form, from the edit form, and
 * from a template - and templates can be imported from a file, so this is not
 * only the user's own typing.
 *
 * The old check was `/^[a-zA-Z0-9._\-\/]+$/`, which admits both `.` and `/`
 * and therefore admits `..` and `../../..`. `path.join(project, '.worktrees',
 * branch)` then resolved outside the project; when that path happened to
 * exist, the caller took the `worktree already exists, reusing it` branch,
 * never invoked git at all, and spawned the agent with its cwd there.
 * `../../../etc` was enough.
 *
 * git's own rules (git check-ref-format) forbid `..`, a leading or trailing
 * `/`, a trailing `.lock`, and `@{`; matching them keeps us from generating
 * commands git would reject anyway.
 */
const BRANCH_SHAPE = /^[A-Za-z0-9][A-Za-z0-9._/-]*$/;

/**
 * On Windows, also no segment Win32 would rewrite: a device name (`feat/nul`
 * opens NUL) or a trailing dot or space (`a./b` is the folder `a/b` to git and
 * Explorer). See platform/windows-names.ts.
 */
export function isValidBranchName(branch: string, platform: NodeJS.Platform = process.platform): boolean {
  if (!branch || branch.length > 200) return false;
  if (!BRANCH_SHAPE.test(branch)) return false;
  if (branch.includes('..')) return false;
  if (branch.includes('//')) return false;
  if (branch.endsWith('/') || branch.endsWith('.') || branch.endsWith('.lock')) return false;
  if (branch.includes('@{')) return false;
  if (branch.split('/').some(segment => isUnsafePathSegment(segment, platform))) return false;
  return true;
}

/**
 * Resolve the worktree directory for a branch, or undefined if the branch name
 * is not usable or the result would land outside the project's `.worktrees`.
 *
 * The containment check is done on resolved paths rather than on the string,
 * so it holds even if the shape check above is ever loosened.
 */
export function resolveWorktreePath(projectPath: string, branch: string): string | undefined {
  if (!isValidBranchName(branch)) return undefined;

  const root = path.resolve(projectPath, '.worktrees');
  const candidate = path.resolve(root, branch);

  if (candidate !== root && !candidate.startsWith(root + path.sep)) return undefined;
  return candidate;
}
