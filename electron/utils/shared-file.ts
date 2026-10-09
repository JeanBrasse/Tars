import * as fs from 'fs';
import * as path from 'path';
import { renameReplacingSync } from '../platform/rename-replacing';

/** What updateSharedJsonSync did. */
export type SharedJsonOutcome =
  /** The file was replaced. */
  | 'written'
  /** The change was already there, or asked for nothing: no write. */
  | 'unchanged'
  /** The file exists and is not JSON: it is left exactly as it is. */
  | 'unreadable'
  /** The file changed under every attempt: left as the other writer made it. */
  | 'busy';

const ATTEMPTS = 3;

/**
 * Changing a JSON file that other programs read and write while Tars runs:
 * `~/.claude.json`, which every live Claude Code reads and rewrites, Claude's
 * `settings.json`, and `~/.claude/mcp.json`, which every Claude session Tars
 * starts reads through `--mcp-config`.
 *
 * All three were rewritten in place. A reader that opened the file during the
 * write got a truncated JSON document, and Claude Code opens `~/.claude.json`
 * at every start. So the file is written whole beside itself and renamed over,
 * as writeAtomicSync does, with three things that helper does not do and these
 * files need:
 *
 * - the mode is kept. `~/.claude.json` is 0600 (measured here) and holds the
 *   account, while a new file is 0644: a plain temp-and-rename would have
 *   made it readable by every account on the machine;
 * - a link is followed, so a dotfile kept elsewhere stays linked;
 * - the temp name is Tars's own. Claude writes the same file through
 *   `.claude.json.tmp.<pid>.<hex>` names (four of them were left in this HOME),
 *   and a name shared with another writer would let one publish the other's
 *   half-written file.
 *
 * Atomicity only settles what a reader sees. It does nothing for an update
 * lost between reading the file and replacing it, while another program writes
 * it. That window is kept to the rename: the new contents are computed and
 * written to the temp file first, the file is read again, and if it changed in
 * the meantime the change is started over from what it holds now. What is left
 * is a write landing between that last read and the rename, which is a
 * single system call away.
 *
 * On Windows that rename fails while a reader holds the file open, and these
 * files are read all the time; it is retried for about a second
 * (platform/rename-replacing.ts).
 */
export function updateSharedJsonSync<T>(
  filePath: string,
  update: (current: T | undefined) => T | undefined,
  { createMode = 0o600 }: { createMode?: number } = {},
): SharedJsonOutcome {
  // The file a link points at, so the rename replaces it and not the link.
  const target = fs.existsSync(filePath) ? fs.realpathSync(filePath) : filePath;

  for (let attempt = 0; attempt < ATTEMPTS; attempt++) {
    const before = readIfPresent(target);

    let current: T | undefined;
    if (before !== undefined && before.trim()) {
      try {
        current = JSON.parse(before) as T;
      } catch {
        return 'unreadable';
      }
    }

    // Serialized before the update runs, because it may change `current` in
    // place. Compared afterwards, a change made that way read as no change:
    // measured, a server added to `mcpServers` in place came back `unchanged`
    // and the file kept only the servers it had.
    const unchanged = current === undefined ? undefined : JSON.stringify(current, null, 2);
    const next = update(current);
    if (next === undefined) return 'unchanged';
    const contents = JSON.stringify(next, null, 2);
    if (contents === unchanged) return 'unchanged';

    // The file's own mode, given at creation: the umask can only narrow it.
    const mode = before !== undefined ? fs.statSync(target).mode & 0o777 : createMode;
    const tmp = `${target}.tars-${process.pid}.tmp`;
    try {
      if (!fs.existsSync(path.dirname(target))) fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(tmp, contents, { mode });

      if (readIfPresent(target) !== before) {
        // Written to while this was being prepared: start again from that.
        removeTemp(tmp);
        continue;
      }
      renameReplacingSync(tmp, target);
      return 'written';
    } catch (err) {
      removeTemp(tmp);
      throw err;
    }
  }
  return 'busy';
}

/** Cleanup that can neither fail nor hide the error that made it necessary. */
function removeTemp(tmp: string): void {
  try {
    if (fs.existsSync(tmp)) fs.rmSync(tmp, { force: true });
  } catch {
    // The write's own error is the one worth reporting.
  }
}

function readIfPresent(filePath: string): string | undefined {
  try {
    return fs.readFileSync(filePath, 'utf-8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw err;
  }
}
