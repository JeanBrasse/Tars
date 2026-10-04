import { afterAll, beforeAll } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

/**
 * Each test file writes its temporary folders into a folder of its own, removed
 * when the file ends.
 *
 * Measured on 2026-10-01, main at 105d22ed: one full run left 312 entries
 * (24 MB) in the temporary folder, under 96 prefixes from about 90 test files
 * and fixtures. A day of runs had left about a hundred of each, the night the
 * Mac crashed on a full disk. Every one of those files was written to remove
 * what it made, or meant to be, and a rule each file has to remember is how the
 * class got 96 members. So this does it for all of them, as home-isolation.ts
 * does for HOME: the file's folder is created here, every mkdtemp in the file
 * and in the children it starts lands inside it, and the whole of it goes in
 * afterAll, whatever the test forgot.
 *
 * TMPDIR, TMP and TEMP are all moved: os.tmpdir() reads TMPDIR on macOS and
 * Linux, TEMP and TMP on Windows, and children inherit all three. This runs
 * first among the setup files, before the file's imports, so that a module
 * reading os.tmpdir() at load sees the file's folder, and so does
 * home-isolation.ts, whose throwaway HOME is then inside it too.
 *
 * The folder is made inside the run's own folder (tmpdir-run.ts), which the
 * run checks at its end: a file whose folder survives it, or anything written
 * past this one, fails the run.
 *
 * Except a file skipped whole, by a skipIf or by a -t filter that matches none
 * of its tests: vitest then runs none of its hooks, this afterAll included, so
 * its folder stays, with whatever it wrote at import. The run removes it with
 * its own, and tells it from a leak by the mark below, which only a file whose
 * hooks ran carries (CI failed on that, 2026-10-05: real-claude-bypass.test.ts
 * is skipped on a runner without claude).
 */

const VARIABLES = ['TMPDIR', 'TMP', 'TEMP'] as const;
/** Read by tmpdir-run.ts. */
const MARK = 'tars-vitest-hooks-ran';

const before = Object.fromEntries(VARIABLES.map(name => [name, process.env[name]]));
const own = fs.mkdtempSync(path.join(os.tmpdir(), 'tars-vitest-file-'));
for (const name of VARIABLES) process.env[name] = own;

beforeAll(() => {
  fs.writeFileSync(path.join(own, MARK), '');
});

afterAll(() => {
  for (const name of VARIABLES) {
    if (before[name] === undefined) delete process.env[name];
    else process.env[name] = before[name];
  }
  fs.rmSync(own, { recursive: true, force: true });
});
