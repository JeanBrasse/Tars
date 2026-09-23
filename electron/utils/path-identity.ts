import * as fs from 'fs';
import * as path from 'path';

/**
 * Whether `candidate` is `dir`, or lies inside it, however either is spelled.
 *
 * A path is a name, and a file has several. On the case-insensitive volume
 * macOS ships, `~/.TARS-PRIVATE/x` opens `~/.tars-private/x`; the Data
 * volume's firmlink puts `/System/Volumes/Data` in front of every path under
 * /Users and /private; a symlink puts a directory anywhere. A prefix test on
 * the string sees none of them: the vault's attach route copied the webhook
 * secret in through the first two (the audit's lead #21, reproduced in a
 * sandbox app). So the question is asked of the file system instead: the
 * candidate's real path, then each directory above it, compared with `dir` by
 * device and inode.
 *
 * `dir` may name a file too (`~/.netrc`): the candidate itself is compared
 * first. A candidate that does not exist is inside nothing, and nothing is
 * inside a `dir` that does not exist; callers keep their lexical test for
 * those.
 */
export function isWithinDir(candidate: string, dir: string): boolean {
  let target: fs.Stats;
  let current: string;
  try {
    target = fs.statSync(dir);
    current = fs.realpathSync.native(candidate);
  } catch {
    return false;
  }
  for (;;) {
    let here: fs.Stats;
    try {
      here = fs.statSync(current);
    } catch {
      return false;
    }
    if (here.dev === target.dev && here.ino === target.ino) return true;
    const parent = path.dirname(current);
    if (parent === current) return false;
    current = parent;
  }
}
