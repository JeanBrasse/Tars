import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

/**
 * Whether a folder taken as a file root is the home, or holds it.
 *
 * The handlers that read and write files "under a project" (fs:read-text-file,
 * fs:write-text-file, fs:read-project-files, local-file://) take the projects
 * the user added, the agents' folders and the folders Claude has seen as
 * roots. A root that is the home or above it (`/Users`, `/home`, `/`) opens
 * every file of the home: a shell profile, an SSH key, ~/.tars-private.
 * ~/.dorothy/projects.json, which lists the added projects, is under the
 * directory every agent is handed.
 *
 * Such a root is refused by its spelling, and by identity: a folder whose
 * device and inode are the home's or an ancestor's is the same folder under
 * another name (a symlink, a case variant on a case-insensitive volume, the
 * Data volume's firmlink on macOS). The ancestors are those of the home as
 * spelled and of its real location, since a home that is itself a link
 * (/home symlinked to /data/home) has other folders above it on the disk.
 * Read as BigInt, as utils/path-identity.ts says why. An inode of 0 is no
 * inode (file systems that keep none report 0 for every file). A root or a
 * home that cannot be read is judged by its spelling alone.
 *
 * Callers judge the roots a target is under (isUnderSafeRoot), not every root
 * they know: a root on a share nobody answers for would block the stat, on the
 * main thread. The home and the folders above it are local, and read once per
 * call.
 */

export type FileId = { dev: bigint; ino: bigint };

export interface HomeRootDeps {
  home?: string;
  /** Device and inode of a path, undefined when it cannot be read. */
  stat?: (p: string) => FileId | undefined;
  /** The real location of a path, links resolved. Throws when it cannot be read. */
  realpath?: (p: string) => string;
}

/** Device and inode of `p`, links followed; undefined when it cannot be read or has no inode. */
export function fileId(p: string): FileId | undefined {
  try {
    const s = fs.statSync(p, { bigint: true });
    return s.ino === BigInt(0) ? undefined : { dev: s.dev, ino: s.ino };
  } catch {
    return undefined;
  }
}

/** `p` with `.` and `..` folded and no trailing separator, a bare root left whole. */
function spelling(p: string): string {
  const normal = path.normalize(p);
  const root = path.parse(normal).root;
  let end = normal.length;
  while (end > root.length && normal[end - 1] === path.sep) end--;
  return normal.slice(0, end);
}

/** `child` is strictly inside `dir`, by spelling. */
function inside(child: string, dir: string): boolean {
  const d = spelling(dir);
  const c = spelling(child);
  return c !== d && c.startsWith(d.endsWith(path.sep) ? d : d + path.sep);
}

/** The test, with the home and the ids of the folders above it read once, when first needed. */
function homeCoverTest(deps: HomeRootDeps = {}): (root: string) => boolean {
  const home = deps.home ?? os.homedir();
  const stat = (target: string) => {
    try {
      const id = (deps.stat ?? fileId)(target);
      return id && id.ino !== BigInt(0) ? id : undefined;
    } catch {
      return undefined;
    }
  };
  let real: string | undefined;
  try {
    real = (deps.realpath ?? fs.realpathSync.native)(home);
  } catch {
    real = undefined;
  }
  const homes = real && spelling(real) !== spelling(home) ? [home, real] : [home];

  let above: FileId[] | undefined;
  const homeAndAbove = () => {
    if (above) return above;
    const found: FileId[] = [];
    for (const start of homes) {
      for (let dir = start; ; dir = path.dirname(dir)) {
        const id = stat(dir);
        if (id && !found.some(f => f.dev === id.dev && f.ino === id.ino)) found.push(id);
        if (path.dirname(dir) === dir) break;
      }
    }
    above = found;
    return above;
  };
  return (root: string) => {
    if (!root) return false;
    if (homes.some(h => spelling(root) === spelling(h) || inside(h, root))) return true;
    const id = stat(root);
    return !!id && homeAndAbove().some(h => h.dev === id.dev && h.ino === id.ino);
  };
}

export function coversHome(root: string, deps: HomeRootDeps = {}): boolean {
  return homeCoverTest(deps)(root);
}

/** `roots` less every one that is the home or holds it, in order. Stats every root. */
export function withoutHomeCover(roots: string[], deps: HomeRootDeps = {}): string[] {
  const covers = homeCoverTest(deps);
  return roots.filter(root => !covers(root));
}

/**
 * Whether `target` is under one of `roots` that is not the home nor above it.
 * `isInside(root, target)` is the caller's own test, by spelling, which does
 * no I/O; only the roots it matches are judged, so a root the target is not
 * under (a project on an offline share) is never looked at on the disk.
 */
export function isUnderSafeRoot(
  target: string, roots: string[], isInside: (root: string, target: string) => boolean, deps: HomeRootDeps = {},
): boolean {
  const matching = roots.filter(root => isInside(root, target));
  if (matching.length === 0) return false;
  const covers = homeCoverTest(deps);
  return matching.some(root => !covers(root));
}
