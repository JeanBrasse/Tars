import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

/**
 * Every test file writes its temporary folders into a folder of its own, which
 * goes when the file ends, and the run fails if anything is left behind.
 *
 * Measured on 2026-10-01, main at 105d22ed: one full run left 312 entries
 * (24 MB) in the temporary folder, under 96 prefixes from about 90 test files
 * and fixtures (fake-gh.ts, fake-claude.ts, worktree.test.ts, release.test.ts
 * first). The Mac had crashed that night on a full disk, and its temporary
 * folder held about a hundred of each from the day's runs. Asking each file to
 * remove what it makes is how the class reached 96 members, so
 * tmpdir-isolation.ts does it for every file, as home-isolation.ts does for HOME.
 *
 * How it can fail, each written down before the setup was:
 * 1. os.tmpdir() inside a test is still the machine's temporary folder, so
 *    whatever a test forgets to remove stays there.
 * 2. A child process the test starts without its own environment writes into
 *    the machine's folder, because the folder was moved for this process only.
 * 3. On Windows os.tmpdir() reads TEMP and TMP, not TMPDIR, so moving TMPDIR
 *    alone moves nothing there.
 * 4. The file's folder is not inside the run's own folder, so the guard at the
 *    end of the run (tmpdir-run.ts) never sees what a file leaves.
 * 5. The file's folder outlives the file. Not seen from inside a file: the
 *    guard fails the run when the run's folder is not empty at its end, and the
 *    PR's witness is the run with the removal taken out (it fails).
 */

const FILE_PREFIX = 'tars-vitest-file-';
const RUN_PREFIX = 'tars-vitest-run-';

describe('the temporary folder of a test file', () => {
  it('1. is a folder of this file\'s own, not the machine\'s temporary folder', () => {
    const own = os.tmpdir();
    expect(path.basename(own).startsWith(FILE_PREFIX), `os.tmpdir() is ${own}`).toBe(true);
    expect(fs.statSync(own).isDirectory()).toBe(true);
  });

  it('2. is the one a child process started without its own environment uses', () => {
    const child = spawnSync(process.execPath, ['-e', 'process.stdout.write(require("os").tmpdir())'], { encoding: 'utf8' });
    expect(child.status).toBe(0);
    expect(child.stdout).toBe(os.tmpdir());
  });

  it('3. is named by TMPDIR, TMP and TEMP alike, for every platform\'s reading', () => {
    expect(process.env.TMPDIR).toBe(os.tmpdir());
    expect(process.env.TMP).toBe(os.tmpdir());
    expect(process.env.TEMP).toBe(os.tmpdir());
  });

  it('4. lies inside the run\'s own folder, which the guard empties and checks at the end of the run', () => {
    const run = path.dirname(os.tmpdir());
    expect(path.basename(run).startsWith(RUN_PREFIX), `the file's folder is in ${run}`).toBe(true);
  });
});
