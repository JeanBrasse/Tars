import * as fs from 'fs';
import * as path from 'path';
import { renameReplacingSync } from '../platform/rename-replacing';
import * as crypto from 'crypto';
import {
  restrictToOwnerSync, restrictToOwner, restrictDirToOwner, ownerOnlyDirSync, closesByAccessList,
} from '../platform/owner-only';
import { pathKey } from '../platform/path-compare';

/**
 * Windows only: what the startup pass named (closeSecretsToOtherAccounts),
 * the private directory once it is closed, and the staging directory each
 * named file is born in, once that one is closed.
 */
const STAGING_NAME = '.staging';
const namedFiles = new Map<string, string>(); // file key -> its staging directory
const privateDirs = new Set<string>();
const closedDirs = new Set<string>();
const staging = new Map<string, 'ready' | 'failed'>();
const warned = new Set<string>();

type SecretWrite = { how: 'plain' } | { how: 'staged'; stagingDir: string } | { how: 'close-first' };

/** darwin/linux: always plain, the modes do the job. */
function secretWrite(filePath: string): SecretWrite {
  if (!closesByAccessList()) return { how: 'plain' };
  const dir = pathKey(path.dirname(filePath));
  if (closedDirs.has(dir)) return { how: 'plain' };
  const stagingDir = namedFiles.get(pathKey(filePath));
  if (stagingDir !== undefined) {
    if (stagingReadySync(stagingDir)) return { how: 'staged', stagingDir };
    fallBack(filePath, `its staging directory ${stagingDir} could not be closed`);
    return { how: 'close-first' };
  }
  if (privateDirs.has(dir)) {
    fallBack(filePath, 'the private directory is not closed yet');
    return { how: 'close-first' };
  }
  return { how: 'plain' };
}

function stagingReadySync(stagingDir: string): boolean {
  const key = pathKey(stagingDir);
  if (!staging.has(key)) staging.set(key, ownerOnlyDirSync(stagingDir) === 'restricted' ? 'ready' : 'failed');
  return staging.get(key) === 'ready';
}

/** Said once per file and reason: the write goes on, born under its folder's list and closed before the rename. */
function fallBack(filePath: string, why: string): void {
  const once = `${filePath}\0${why}`;
  if (warned.has(once)) return;
  warned.add(once);
  console.warn(`[secret-acl] ${filePath} is written beside itself and closed before the rename, not born closed: ${why}`);
}

/** One temp name per target in the staging directory, whatever folder the target is in. */
function stagedTemp(filePath: string, stagingDir: string, suffix: string): string {
  const tag = crypto.createHash('sha256').update(pathKey(filePath)).digest('hex').slice(0, 12);
  return path.join(stagingDir, `${path.basename(filePath)}-${tag}${suffix}`);
}

/**
 * Write `contents` into a new file in the staging directory: created there,
 * so it has the directory's list (the user and SYSTEM) before a byte is in it,
 * made protected so that a grant later added to the target's folder cannot
 * flow into it, and returned for the caller to rename. Same 'wx' creation as
 * writeAtomicSync: whatever held the name is removed first, nothing is followed.
 */
function stageSync(filePath: string, contents: string | Buffer, stagingDir: string, suffix: string): string {
  const tmp = stagedTemp(filePath, stagingDir, suffix);
  return stageAtSync(tmp, contents);
}

/**
 * stageSync for a save, which must not fail because the staging directory went
 * away after it was closed (removed by the user, by an agent): its readiness
 * is remembered, and the temp then cannot be created (ENOENT). The directory
 * is made and closed again, and the temp tried once more; null when that
 * fails too, for the caller to fall back.
 */
function stageRecoveringSync(filePath: string, contents: string | Buffer, stagingDir: string): string | null {
  const missing = (err: unknown) => (err as NodeJS.ErrnoException)?.code === 'ENOENT';
  try {
    return stageSync(filePath, contents, stagingDir, '.tmp');
  } catch (err) {
    if (!missing(err)) throw err;
  }
  staging.delete(pathKey(stagingDir));
  if (!stagingReadySync(stagingDir)) return null;
  try {
    return stageSync(filePath, contents, stagingDir, '.tmp');
  } catch (err) {
    if (missing(err)) return null;
    throw err;
  }
}

function stageAtSync(tmp: string, contents: string | Buffer): string {
  fs.rmSync(tmp, { force: true });
  const fd = fs.openSync(tmp, 'wx', 0o600);
  try {
    fs.writeFileSync(fd, contents);
  } finally {
    fs.closeSync(fd);
  }
  return tmp;
}

/**
 * Writing a file that holds credentials.
 *
 * `fs.writeFileSync(p, data)` creates the file with 0666 & ~umask, which on a
 * default umask of 022 lands at 0644 - readable by every other account on the
 * machine. `api-token` and `hermes-webhook-secret` were hardened for this
 * reason; `app-settings.json` was not, and it holds far more: the Telegram,
 * Slack, Discord, Jira, SocialData, X, OpenRouter, DeepSeek, Mimo, Moonshot, Qwen,
 * Zhipu, MiniMax, NVIDIA and Nous Portal keys, the Hermes gateway token, and
 * the gbrain and Honcho credentials. One file, twenty-odd secrets, world
 * readable.
 *
 * `mode` on writeFileSync only applies when the file is CREATED, so an
 * existing 0644 file keeps its mode forever. The explicit chmod is what fixes
 * installs that already have one.
 *
 * The write is atomic as well: a crash between truncate and write used to
 * leave an empty settings file, and the app would silently fall back to
 * defaults - every key gone.
 *
 * A directory this has to create is made 0700, readable by its owner alone.
 * It is how `~/.tars-private` comes into being on an install that never had
 * anything to migrate there: made with the default mode, it was 0755, open to
 * a listing by every account on the machine, while the migration, the only
 * other place that made it, made it 0700. A directory that already exists is
 * left as it is: `~/.dorothy` is the agents' directory, and not this
 * function's to narrow.
 *
 * On Windows the modes do nothing, and an access list only binds the handles
 * opened after it is set: one opened before keeps what it was granted, and
 * Node opens with full sharing. So a file the startup pass names
 * (closeSecretsToOtherAccounts) is born closed: its temp is created in a
 * staging directory of the account alone (~/.tars-private/.staging), holding
 * that directory's list before its first byte, then renamed into place, which
 * keeps the list (same volume). A file in the private directory is closed by
 * the directory's own list once that pass has closed it, and starts nothing.
 * Until a staging directory is closed (or when it cannot be), the temp is made
 * beside the target and closed before the rename, as before, and that is
 * logged. Any other file (hermes-session.json, rewritten on every gateway
 * reply that sets a cookie) keeps what its folder hands down: one icacls is a
 * process start on the main process, 25 ms on an idle machine and 400 ms on a
 * busy one. A failure is logged and the write goes on. darwin/linux: nothing
 * runs.
 */
export function writeSecretFileSync(filePath: string, contents: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
  let plan = secretWrite(filePath);
  let tmp = `${filePath}.tmp`;
  try {
    if (plan.how === 'staged') {
      const staged = stageRecoveringSync(filePath, contents, plan.stagingDir);
      if (staged) {
        tmp = staged;
        // Born closed already; this makes it protected. A failure names the target.
        restrictToOwnerSync(tmp, {}, { warn: (m) => console.warn(`${m} (the save of ${filePath})`) });
        renameReplacingSync(tmp, filePath);
      } else {
        fallBack(filePath, `its staging directory ${plan.stagingDir} was removed and could not be made again`);
        plan = { how: 'close-first' };
      }
    }
    if (plan.how !== 'staged') {
      writeAtomicSync(filePath, contents, 0o600, plan.how === 'close-first' ? (t) => { restrictToOwnerSync(t); } : undefined);
    }
  } catch (err) {
    // A temp that holds the secret does not outlive a write that failed.
    fs.rmSync(tmp, { force: true });
    throw err;
  }

  // renameSync preserves the temp file's mode, but be explicit: if the target
  // already existed at 0644 on some platform, this is what narrows it.
  try {
    fs.chmodSync(filePath, 0o600);
  } catch {
    // A filesystem without POSIX modes (a network share) - nothing to do.
  }
}

/**
 * A secret that must be written whoever is reading it: api-token, minted at
 * startup. Written as writeSecretFileSync writes, a new file object; but when
 * the rename is refused because another program holds the file open (EPERM,
 * EBUSY or EACCES after the retry, measured with a Node reader), it is written
 * in place instead, 0600 and closed to other accounts, and that is logged: the
 * app must start. In place, a handle already open on the file reads the new
 * contents; that is the price of starting. Any other error is thrown as before.
 */
export function writeSecretFileEvenIfHeldSync(filePath: string, contents: string): void {
  try {
    writeSecretFileSync(filePath, contents);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException)?.code;
    if (!code || !['EPERM', 'EBUSY', 'EACCES'].includes(code)) throw err;
    console.warn(`[secret-acl] ${filePath} is held open by another program (${code}): written in place, so a handle already open on it reads the new contents`);
    fs.writeFileSync(filePath, contents, { mode: 0o600 });
    restrictToOwnerSync(filePath);
  }
}

/**
 * Windows only: whether api-token is to be minted anew although a usable one
 * exists, because this build has never minted it. A token read before the
 * file was closed (by an older build's reader, a sandbox account) stays valid
 * as long as the token does, and Tars reuses any token of 32 characters or
 * more; so it is replaced once, the first time, and `marker` records that it
 * was. darwin/linux: never.
 */
export function oneTimeRotationDue(marker: string): boolean {
  return closesByAccessList() && !fs.existsSync(marker);
}

/** Windows only: record that api-token has been minted by this build. Never throws. */
export function oneTimeRotationDone(marker: string): void {
  if (!closesByAccessList()) return;
  try {
    fs.mkdirSync(path.dirname(marker), { recursive: true, mode: 0o700 });
    fs.writeFileSync(marker, `${new Date().toISOString()}\n`);
  } catch (err) {
    console.warn(`[secret-acl] ${marker} could not be written, so api-token will be minted again next start: ${describeSecretFileError(err)}`);
  }
}

/**
 * An ordinary state file, written atomically.
 *
 * Same temp-file-then-rename as above, without narrowing the mode: the caller's
 * data is not a credential, but a crash between truncate and write would still
 * leave a half-file that the next parse rejects. agents.json already had this
 * treatment; projects.json did not, and losing it silently empties the user's
 * project list.
 *
 * The temp name is fixed, so it is created, never opened. Whatever holds that
 * name is removed first, which takes a link away without touching what it
 * points at, and the file is then made with 'wx', O_CREAT with O_EXCL, which
 * fails rather than follow anything put there in between, a symbolic link or a
 * hard one. Opened the ordinary way, a symbolic link planted at the temp name
 * sent the contents into the file it named, and a hard link truncated that
 * file in place; the rename then made the link the secret file itself. Found
 * by the audit of lot 4. A leftover temp file from a write that died goes the
 * same way; it used to be written over.
 *
 * On Windows the rename fails while another program holds the file open, even
 * to read it; it is retried for about a second (platform/rename-replacing.ts).
 *
 * `beforeRename` gets the written temp file, for what must hold before it
 * takes the live file's place (writeSecretFileSync's access list).
 */
export function writeAtomicSync(filePath: string, contents: string, mode?: number, beforeRename?: (tmp: string) => void): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tmp = `${filePath}.tmp`;
  fs.rmSync(tmp, { force: true });
  fs.writeFileSync(tmp, contents, { flag: 'wx', mode: mode ?? 0o666 });
  beforeRename?.(tmp);
  renameReplacingSync(tmp, filePath);
}

/**
 * At startup, on Windows: close the secret files that already exist, and the
 * private directory with everything in it, to every account but the user and
 * SYSTEM. An install made before this, a file an older build or another tool
 * left open, a conversation file renamed out of ~/.dorothy with that folder's
 * list: all of them end as a fresh write would leave them. The files' own
 * explicit entries go too. A file or directory that does not exist is
 * skipped quietly, except the private directory, which is made so that what
 * the Chat writes there later is closed by its list. darwin/linux: nothing
 * runs and nothing is made, the modes do this there (ensureSecretFileMode,
 * narrowDataDir).
 *
 * Once, at startup, and not on each read as ensureSecretFileMode is: it starts
 * two icacls per file, and readHermesConnection runs on every gateway call.
 * Asynchronous, so the main process goes on while it runs (2 to 4.6 s on a
 * machine at 100% CPU). A save that lands meanwhile is staged by its own
 * write, and the pass only ever narrows, so the two cannot leave a file open.
 * Never rejects: each failure is logged where it happens.
 *
 * The files are not closed in place: each is born again, closed, in the
 * staging directory and renamed over itself (rebornClosed). The private
 * directory is: its list is reset and set, and for that moment what inherits
 * from it (not the staging directory, which keeps its own) has the home's.
 */
export async function closeSecretsToOtherAccounts(files: string[], privateDir: string): Promise<void> {
  if (!closesByAccessList()) return;
  const stagingDir = path.join(privateDir, STAGING_NAME);
  // Named before the first await: a save made while the pass runs is staged too.
  for (const file of files) namedFiles.set(pathKey(file), stagingDir);
  privateDirs.add(pathKey(privateDir));
  // Synchronously, like the first save would: closing it resets its own list
  // for a moment, and no temp may be born in it then. Two icacls, once.
  const staged = stagingReadySync(stagingDir);
  for (const file of files) {
    if (!fs.existsSync(file)) continue;
    if (staged) await rebornClosed(file, stagingDir);
    else {
      fallBack(file, `its staging directory ${stagingDir} could not be closed`);
      await restrictToOwner(file, { replaceExplicit: true });
    }
  }
  const dir = await restrictDirToOwner(privateDir, {}, { create: true, keep: [STAGING_NAME] });
  if (dir === 'restricted') closedDirs.add(pathKey(privateDir));
}

/**
 * Give an existing secret a new file object with the same contents, born
 * closed in the staging directory, rather than change the list of the one
 * there: a handle already open on the old object keeps it, and sees nothing
 * written from now on; and nothing is reset on the way, so the file is never
 * under its folder's list, even for a moment. A save that lands while the
 * temp is being closed wins: the contents are compared again, synchronously,
 * just before the rename, and the temp is dropped when they differ. A rename
 * refused (a reader holding the file past the retry) is logged, and the file
 * is closed where it stands instead.
 */
async function rebornClosed(file: string, stagingDir: string): Promise<void> {
  let before: Buffer;
  let tmp: string;
  try {
    before = fs.readFileSync(file);
    tmp = stageSync(file, before, stagingDir, '.pass.tmp');
  } catch (err) {
    console.warn(`[secret-acl] ${file} could not be copied into ${stagingDir}: ${describeSecretFileError(err)}`);
    await restrictToOwner(file, { replaceExplicit: true });
    return;
  }
  await restrictToOwner(tmp, {}, { warn: (m) => console.warn(`${m} (the startup pass over ${file})`) });
  try {
    if (!fs.readFileSync(file).equals(before)) {
      fs.rmSync(tmp, { force: true });
      return;
    }
    renameReplacingSync(tmp, file);
  } catch (err) {
    fs.rmSync(tmp, { force: true });
    console.warn(`[secret-acl] ${file} kept its file object, closed in place instead: ${describeSecretFileError(err)}`);
    await restrictToOwner(file, { replaceExplicit: true });
  }
}

/**
 * Describe a failure to read one of these files, without quoting the file.
 *
 * `console.error('...', err)` on a credential file logs the file back out.
 * Node builds a JSON.parse message out of the input: corruption at the start
 * of hermes-session.json produced `Unexpected token 'e', "es_session"... is
 * not valid JSON`, which is a cookie name in a log that is not 0600 while the
 * file is. The fragment is ten characters and usually harmless, but the rule
 * that no secret reaches a log is only worth having if it holds when the leak
 * is small.
 *
 * redactSecrets is the wrong tool: it matches secret SHAPES (sk-ant-, bearer,
 * NAME=value), and an arbitrary ten-character slice of a file matches none of
 * them, so it would pass `es_session` through and look like it had worked.
 *
 * What a reader needs is why the file was unusable, not what was in it: the
 * parser rejected it, or the filesystem did and here is its code.
 */
export function describeSecretFileError(err: unknown): string {
  if (err instanceof SyntaxError) return 'not valid JSON';
  if (err && typeof err === 'object' && 'code' in err) {
    return String((err as { code: unknown }).code);
  }
  if (err instanceof Error) return err.name;
  return 'unknown error';
}

/**
 * Narrow an existing file to 0600 if it is wider. Called at startup for the
 * files that predate this helper.
 */
export function ensureSecretFileMode(filePath: string): void {
  try {
    const stat = fs.statSync(filePath);
    if ((stat.mode & 0o077) !== 0) fs.chmodSync(filePath, 0o600);
  } catch {
    // Missing file, or no POSIX modes.
  }
}

/**
 * Close ~/.dorothy to the other accounts on the machine: the directory and its
 * subdirectories to 0700, its files to what their owner already had and no
 * more, so data files land at 0600 and statusline.sh, which Claude Code runs,
 * stays executable by its owner.
 *
 * Called at startup. The directory holds the fleet, the board, the usage
 * ledger and the vault, and an install made before this ran had it at 0755
 * with its files at 0644. One level deep is enough: a directory at 0700 can be
 * neither listed nor entered by anyone else, so nothing below it needs its own
 * mode. A link is never followed, since what it points to may be any file the
 * account owns, and an entry that cannot be changed leaves the others to be.
 */
export function narrowDataDir(dir: string): void {
  let names: string[];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return; // Missing, or not a directory: nothing to narrow.
  }
  const narrow = (p: string) => {
    try {
      const stat = fs.lstatSync(p);
      if (stat.isSymbolicLink()) return;
      const wanted = stat.isDirectory() ? 0o700 : stat.mode & 0o700;
      if ((stat.mode & 0o777) !== wanted) fs.chmodSync(p, wanted);
    } catch {
      // Not ours to change, or gone since the listing.
    }
  };
  for (const name of names) narrow(path.join(dir, name));
  narrow(dir);
}
