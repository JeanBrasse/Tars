import * as path from 'path';

/**
 * Whether two paths name one place, and whether one is inside another, by
 * their spelling (audit B W-02, W-03, U-08). No disk access: a link or an 8.3
 * short name is another spelling to these, as it was to the string
 * comparisons they replace.
 *
 * darwin/linux: exactly those comparisons. A trailing `/` is dropped, then the
 * strings are compared as they are, case and `..` included (kanban-board's
 * `want === own || want.startsWith(own + '/')`, kanban-automation's
 * normalizePath then `===`).
 *
 * win32: the way Windows reads a path. `/` and `\` are one separator, case does
 * not count (NTFS), `.` and `..` segments are resolved, a trailing separator,
 * dot or space is dropped as Win32 drops it, and `\\?\C:\x`, `\\.\C:\x` and
 * `\\?\UNC\srv\share` are `C:\x` and `\\srv\share`. Any other `\\?\` form is
 * left as it is, so it matches no ordinary path.
 */

const isWin = (platform: NodeJS.Platform) => platform === 'win32';

/** What makes two win32 spellings the same. */
function windowsKey(p: string): string {
  let s = p.replace(/\//g, '\\');
  if (/^\\\\\?\\UNC\\/i.test(s)) s = `\\\\${s.slice(8)}`;
  else if (/^\\\\[?.]\\[A-Za-z]:(\\|$)/.test(s)) s = s.slice(4);
  s = path.win32.normalize(s);
  // A drive's root, a UNC share, the current drive's root, or a drive-relative `C:`.
  const root = /^([A-Za-z]:\\|\\\\[^\\]+\\[^\\]+(\\|$)|\\|[A-Za-z]:)/.exec(s)?.[0] ?? '';
  const segments = s.slice(root.length).split('\\').filter(Boolean)
    .map(seg => (/^\.+$/.test(seg) ? seg : seg.replace(/[. ]+$/, '')))
    .filter(Boolean);
  if (!segments.length) return upper(root || s);
  const joint = root && !root.endsWith('\\') && !/^[A-Za-z]:$/.test(root) ? '\\' : '';
  return upper(root + joint + segments.join('\\'));
}

/** Upper case without changing a string's length (`ß`.toUpperCase() is `SS`). */
function upper(s: string): string {
  let out = '';
  for (const ch of s) {
    const u = ch.toUpperCase();
    out += u.length === ch.length ? u : ch;
  }
  return out;
}

const posixKey = (p: string) => p.replace(/\/+$/, '');

/**
 * One key per place, as samePath sees it: two spellings samePath takes as one
 * give one key, for a Set or a Map. darwin/linux: the path less its trailing
 * `/`. win32: separators, case, `.`/`..`, trailing dots and spaces folded.
 */
export function pathKey(p: string, platform: NodeJS.Platform = process.platform): string {
  if (!isWin(platform)) return posixKey(p);
  return p ? windowsKey(p) : p;
}

export function samePath(a: string, b: string, platform: NodeJS.Platform = process.platform): boolean {
  if (!isWin(platform)) return posixKey(a) === posixKey(b);
  if (!a || !b) return a === b;
  return windowsKey(a) === windowsKey(b);
}

/** `child` is strictly inside `root`: not `root` itself, not a sibling sharing its prefix. */
export function isUnder(child: string, root: string, platform: NodeJS.Platform = process.platform): boolean {
  if (!isWin(platform)) return posixKey(child).startsWith(`${posixKey(root)}/`);
  if (!child || !root) return false;
  const r = windowsKey(root);
  const c = windowsKey(child);
  return c !== r && c.startsWith(r.endsWith('\\') ? r : `${r}\\`);
}

/**
 * Whether a path is the root of a file system, which is never a project.
 * darwin/linux: `/`, exactly as the listings compared it. win32: a drive's
 * root, a share's root or `\`, in any spelling (not `C:` alone, which is the
 * drive's current directory).
 */
export function isFilesystemRoot(p: string, platform: NodeJS.Platform = process.platform): boolean {
  if (!isWin(platform)) return p === '/';
  if (!p) return false;
  // normalize keeps a share root's trailing `\` (`\\srv\share\`).
  return /^([A-Z]:\\|\\\\[^\\]+\\[^\\]+\\?|\\)$/.test(windowsKey(p));
}

/**
 * Whether a path lies inside a `worktrees` or `.worktrees` folder, a view of a
 * repository rather than a project of its own. darwin/linux: the
 * `/\/\.?worktrees\//` both listings used; win32: either separator, any case.
 */
export function isInsideWorktreesDir(p: string, platform: NodeJS.Platform = process.platform): boolean {
  return isWin(platform) ? /[\\/]\.?worktrees[\\/]/i.test(p) : /\/\.?worktrees\//.test(p);
}
