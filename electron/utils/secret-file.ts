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
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });

  const tmp = `${filePath}.tmp`;
  fs.writeFileSync(tmp, contents, { mode: 0o600 });
  fs.renameSync(tmp, filePath);

  // renameSync preserves the temp file's mode, but be explicit: if the target
  // already existed at 0644 on some platform, this is what narrows it.
  try {
    fs.chmodSync(filePath, 0o600);
  } catch {
    // A filesystem without POSIX modes (a network share) - nothing to do.
  }
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
