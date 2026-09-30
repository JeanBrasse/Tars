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
 *
 * Identities are read as BigInt. A plain stat gives the inode as a Number,
 * exact only below 2^53, and some volumes hand out 64-bit file ids above it
 * (NTFS, or a share whose client passes the server's ids through, as Linux's
 * CIFS does by default): two files a few ids apart then read as one number,
 * and this took an ordinary folder for a blocked one, or a folder outside the
 * home for the home.
 */
export function isWithinDir(candidate: string, dir: string): boolean {
  let target: fs.BigIntStats;
  let current: string;
  try {
    target = fs.statSync(dir, { bigint: true });
    current = fs.realpathSync.native(candidate);
  } catch {
    return false;
  }
  for (;;) {
    let here: fs.BigIntStats;
    try {
      here = fs.statSync(current, { bigint: true });
    } catch {
      return false;
    }
    if (here.dev === target.dev && here.ino === target.ino) return true;
    const parent = path.dirname(current);
    if (parent === current) return false;
    current = parent;
  }
}

/**
 * Whether `candidate` is another name for a file inside `dir`: a hard link.
 *
 * isWithinDir follows a path, and a hard link has none back to the file it
 * names: it is a second directory entry for the same inode, anywhere on the
 * volume, so a link made in /tmp to the webhook secret is inside nothing and
 * the vault copied it in (the audit's gate of #137, measured). Only a regular
 * file with more than one name can be one, so only those are looked for, by
 * device and inode, among the regular files under `dir`, whose symlinks are
 * not followed. `dir` is walked, so this is for small directories whose files
 * are secrets whole: the private directory and ~/.ssh. Read as BigInt, as
 * isWithinDir says why.
 */
export function isHardLinkInto(candidate: string, dir: string): boolean {
  let file: fs.BigIntStats;
  try {
    file = fs.statSync(candidate, { bigint: true });
  } catch {
    return false;
  }
  if (!file.isFile() || file.nlink < BigInt(2)) return false;
  const pending = [dir];
  while (pending.length > 0) {
    const current = pending.pop()!;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        pending.push(full);
      } else if (entry.isFile()) {
        try {
          const here = fs.lstatSync(full, { bigint: true });
          if (here.dev === file.dev && here.ino === file.ino) return true;
        } catch {
          // Gone since it was listed.
        }
      }
    }
  }
  return false;
}
