import * as fs from 'node:fs';
import * as os from 'node:os';

/**
 * Where the run's own temporary folder is made (tmpdir-run.ts): the machine's
 * temp dir, under its canonical spelling on Windows.
 *
 * CI's windows-latest runs as runneradmin, whose %TEMP% is the 8.3 short
 * C:\Users\RUNNER~1\AppData\Local\Temp; git, and every program that
 * canonicalises, report C:\Users\runneradmin\..., and Claude's folder name for
 * a project under RUNNER~1 (RUNNER-1) cannot be read back to that folder. Seen
 * on windows-latest on 2026-09-26: 15 tests (the release script, the purge,
 * the Claude project decoder and its readers) compared the short spelling with
 * the long one. A %TEMP% spelled in another case, or reached through a
 * junction, differs from its canonical spelling the same way.
 * fs.realpathSync.native expands a short name, the case and a junction;
 * fs.realpathSync does not expand a short name or the case. darwin and linux
 * keep their temp dir as it is spelled (/var/folders on macOS, which is behind
 * the /private link): their tests were written and measured against it.
 */
export function runDirParent(tmp: string = os.tmpdir(), platform: NodeJS.Platform = process.platform): string {
  return platform === 'win32' ? fs.realpathSync.native(tmp) : tmp;
}
