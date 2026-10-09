import * as fs from 'fs';
import * as path from 'path';

/**
 * What a folder takes on the disk, in bytes, as `du -sk` counts it: the space
 * allocated to each file under it, a link counted as itself and never
 * followed.
 *
 * For Windows, which has no du on a user's PATH: Settings, System read every
 * folder no agent owns as 0 KB there (orphan-folders.ts). Node's `blocks` on
 * Windows is a file's allocated size in 512-byte units (libuv reads NTFS's
 * AllocationSize), so a file counts what it takes, as du's would. A folder or
 * a file that cannot be read counts as nothing, as du skips it. Asynchronous:
 * a worktree's node_modules is tens of thousands of files, and the main
 * process keeps answering meanwhile.
 */
export async function diskUsage(dir: string): Promise<number> {
  let total = 0;
  const stack = [dir];
  while (stack.length) {
    const current = stack.pop()!;
    let entries: fs.Dirent[];
    try {
      entries = await fs.promises.readdir(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const p = path.join(current, entry.name);
      // A junction or a link reads as a link here, not as a folder: not walked into.
      if (entry.isDirectory()) {
        stack.push(p);
        continue;
      }
      try {
        total += ((await fs.promises.lstat(p)).blocks ?? 0) * 512;
      } catch { /* gone since the listing */ }
    }
  }
  return total;
}
