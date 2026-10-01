import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

/**
 * The run's own temporary folder, and the guard that it is empty at the end.
 *
 * vitest runs this once, in its main process, before it starts the workers, so
 * the workers and everything they start inherit the folder through TMPDIR,
 * TMP and TEMP. Each test file then makes its own folder inside it and removes
 * it when it ends (tmpdir-isolation.ts). At the end of the run the folder must
 * be empty: anything still in it is a file's folder that outlived the file, or
 * something written past the file's own folder, and the run fails with its
 * names. It is removed either way, so that a failed run does not leave its
 * leftovers behind as well.
 *
 * Why the run fails rather than warns: 312 entries a run were left on
 * 2026-10-01, a day of that filled a disk, and no one had read a warning.
 */

const VARIABLES = ['TMPDIR', 'TMP', 'TEMP'] as const;

export default function setup(): () => void {
  const before = Object.fromEntries(VARIABLES.map(name => [name, process.env[name]]));
  const run = fs.mkdtempSync(path.join(os.tmpdir(), 'tars-vitest-run-'));
  for (const name of VARIABLES) process.env[name] = run;

  return () => {
    for (const name of VARIABLES) {
      if (before[name] === undefined) delete process.env[name];
      else process.env[name] = before[name];
    }
    let left: string[] = [];
    try {
      left = fs.readdirSync(run);
    } finally {
      fs.rmSync(run, { recursive: true, force: true });
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
