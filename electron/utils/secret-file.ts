import * as fs from 'fs';
import * as path from 'path';

/**
 * Writing a file that holds credentials.
 *
 * `fs.writeFileSync(p, data)` creates the file with 0666 & ~umask, which on a
 * default umask of 022 lands at 0644 - readable by every other account on the
 * machine. `api-token` and `hermes-webhook-secret` were hardened for this
 * reason; `app-settings.json` was not, and it holds far more: the Telegram,
 * Slack, Jira, SocialData, X, OpenRouter, DeepSeek, Mimo, Moonshot, Qwen,
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
 */
export function writeSecretFileSync(filePath: string, contents: string): void {
  writeAtomicSync(filePath, contents, 0o600);

  // renameSync preserves the temp file's mode, but be explicit: if the target
  // already existed at 0644 on some platform, this is what narrows it.
  try {
    fs.chmodSync(filePath, 0o600);
  } catch {
    // A filesystem without POSIX modes (a network share) - nothing to do.
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
 */
export function writeAtomicSync(filePath: string, contents: string, mode?: number): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tmp = `${filePath}.tmp`;
  fs.writeFileSync(tmp, contents, mode !== undefined ? { mode } : undefined);
  fs.renameSync(tmp, filePath);
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
