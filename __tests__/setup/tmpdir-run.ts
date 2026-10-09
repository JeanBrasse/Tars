import * as fs from 'node:fs';
import * as path from 'node:path';
import { runDirParent } from './run-dir';

/**
 * The run's own temporary folder, and the guard that it is empty at the end.
 *
 * vitest runs this once, in its main process, before it starts the workers, so
 * the workers and everything they start inherit the folder through TMPDIR,
 * TMP and TEMP. Each test file then makes its own folder inside it and removes
 * it when it ends (tmpdir-isolation.ts). At the end of the run, anything still
 * in the folder is a file's folder that outlived the file, or something written
 * past the file's own folder, and the run fails with its names. It is removed
 * either way, so that a failed run does not leave its leftovers behind as well.
 *
 * One kind of entry is not a leak: the folder of a file skipped whole, which
 * ran no hooks and so could not remove it. It is the one file folder without
 * the mark tmpdir-isolation.ts leaves when a file's hooks run, and the run
 * removes it with its own.
 *
 * Why the run fails rather than warns: 312 entries a run were left on
 * 2026-10-01, a day of that filled a disk, and no one had read a warning.
 */

const VARIABLES = ['TMPDIR', 'TMP', 'TEMP'] as const;
/** As tmpdir-isolation.ts names a file's folder, and the mark it leaves there. */
const FILE_PREFIX = 'tars-vitest-file-';
const MARK = 'tars-vitest-hooks-ran';

/** The folder of a test file whose hooks never ran: skipped whole, or never started. */
function ranNoHooks(entry: string): boolean {
  return path.basename(entry).startsWith(FILE_PREFIX) && !fs.existsSync(path.join(entry, MARK));
}

export default function setup(): () => Promise<void> {
  const before = Object.fromEntries(VARIABLES.map(name => [name, process.env[name]]));
  // On Windows under the temp dir's canonical spelling (run-dir.ts says why: RUNNER~1 on CI).
  const run = fs.mkdtempSync(path.join(runDirParent(), 'tars-vitest-run-'));
  for (const name of VARIABLES) process.env[name] = run;

  return async () => {
    for (const name of VARIABLES) {
      if (before[name] === undefined) delete process.env[name];
      else process.env[name] = before[name];
    }
    let left: string[] = [];
    try {
      left = fs.readdirSync(run).filter(name => !ranNoHooks(path.join(run, name)));
    } finally {
      // Retried, as tmpdir-isolation.ts removes a file's folder and for the
      // same reason: rmSync does not retry a folder Windows refuses to remove
      // while a process ending has it as its working directory.
      await fs.promises.rm(run, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
    if (left.length > 0) {
      const shown = left.slice(0, 20).join(', ');
      // vitest 4.1 logs an error thrown here as "error during close" and still
      // exits 0 (measured on the witness run): the exit code is set by hand.
      process.exitCode = 1;
      throw new Error(
        `The run left ${left.length} entr${left.length === 1 ? 'y' : 'ies'} in its temporary folder (${shown}${left.length > 20 ? ', ...' : ''}). `
        + 'A test file\'s folder must go when the file ends (__tests__/setup/tmpdir-isolation.ts), and nothing may be written past it.',
      );
    }
  };
}
