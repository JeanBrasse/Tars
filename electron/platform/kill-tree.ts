import { execFile as nodeExecFile } from 'child_process';
import * as path from 'path';
import type { Env } from './fs-probe';
import { envValue } from './path-env';

/**
 * End a process and every process under it (audit A21).
 *
 * win32: `taskkill /PID <pid> /T /F`, by its absolute path under
 * %SystemRoot%\System32 (never looked up on the PATH, where an agent's project
 * could plant one), with an argv. `child.kill()` there ends the root only:
 * `node npx-cli.js` > adapter > claude.exe > tool shells survive it.
 *
 * darwin/linux: nothing runs, the answer is `not-win32`. The callers keep the
 * process-group kill they have today (acp/client.ts `process.kill(-pid)`,
 * with its `ps` walk); this lot changes none of it.
 */

export type KillTreeResult = { outcome: 'killed' } | { outcome: 'already-gone' } | { outcome: 'not-win32' };

export type KillTreeErrorCode = 'invalid-pid' | 'taskkill-failed';

export class KillTreeError extends Error {
  constructor(readonly code: KillTreeErrorCode, message: string, cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = 'KillTreeError';
  }
}

export interface KillTreeDeps {
  /** Resolves on exit 0, rejects like child_process.execFile (err.code: exit code or errno). */
  execFile(file: string, args: string[]): Promise<void>;
  env?: Env;
}

/** taskkill's exit code when no process has that PID, whatever the language of its message. */
const TASKKILL_NOT_FOUND = 128;

const realDeps: KillTreeDeps = {
  execFile: (file, args) => new Promise((resolve, reject) => {
    nodeExecFile(file, args, { windowsHide: true }, (err) => (err ? reject(err) : resolve()));
  }),
};

export async function killTree(
  pid: number,
  platform: NodeJS.Platform = process.platform,
  deps: KillTreeDeps = realDeps,
): Promise<KillTreeResult> {
  if (typeof pid !== 'number' || !Number.isSafeInteger(pid) || pid <= 0) {
    throw new KillTreeError('invalid-pid', `Not a process id: ${String(pid)}`);
  }
  if (platform !== 'win32') return { outcome: 'not-win32' };

  const systemRoot = envValue(deps.env ?? process.env, 'SystemRoot', 'win32') || 'C:\\Windows';
  const taskkill = path.win32.join(systemRoot, 'System32', 'taskkill.exe');
  try {
    await deps.execFile(taskkill, ['/PID', String(pid), '/T', '/F']);
    return { outcome: 'killed' };
  } catch (err) {
    if ((err as { code?: unknown }).code === TASKKILL_NOT_FOUND) return { outcome: 'already-gone' };
    throw new KillTreeError('taskkill-failed', `taskkill /PID ${pid} /T /F failed: ${err instanceof Error ? err.message : String(err)}`, err);
  }
}
