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
/**
 * Read by home-isolation.ts: the run's folder, which holds this file's. On
 * Windows the temp dir lies inside the account's home, and that guard lets
 * the temp dir through: the run's folder, not only this file's, or a write
 * past the file's folder reads as a write into the real home there, and the
 * run's own guard never gets to see it (tmpdir-isolation.test.ts, 7).
 */
const RUN_FOLDER = Symbol.for('tars.test.runTmpdir');

const before = Object.fromEntries(VARIABLES.map(name => [name, process.env[name]]));
const run = os.tmpdir();
(globalThis as typeof globalThis & { [RUN_FOLDER]?: string })[RUN_FOLDER] = run;
const own = fs.mkdtempSync(path.join(run, 'tars-vitest-file-'));
for (const name of VARIABLES) process.env[name] = own;

beforeAll(() => {
  fs.writeFileSync(path.join(own, MARK), '');
});

afterAll(async () => {
  for (const name of VARIABLES) {
    if (before[name] === undefined) delete process.env[name];
    else process.env[name] = before[name];
  }
  // Retried, and not synchronously: Windows refuses to remove a folder that a
  // process still has as its working directory, and a test's agent is often
  // still being ended when the file ends (AcpSession.stop starts a taskkill
  // and does not wait for it, as it does not wait for its signals on macOS
  // and Linux).
  // rmSync does not retry that refusal at all (EBUSY on a folder's first
  // rmdir: measured on Node 22.23, it failed after 1 ms with the holder
  // alive); fs.promises.rm retries the whole removal, here for at most 5.5 s,
  // under vitest's 10 s for a hook. A process that is never ended still fails
  // the file.
  await fs.promises.rm(own, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});
