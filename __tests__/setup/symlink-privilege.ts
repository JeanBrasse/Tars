import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

/**
 * Whether this process may create a symbolic link, for the tests that plant one.
 *
 * Windows gives the right to accounts with SeCreateSymbolicLinkPrivilege, which
 * an ordinary account only has with Developer Mode on. Nicolas's machine runs
 * without it (decision D4 in WINDOWS-PORT.md), and there fs.symlinkSync fails
 * with EPERM: 81 tests in 13 files failed on the link they set up, not on what
 * they assert. They skip there, saying why, and run everywhere a link can be
 * made: macOS, Linux, and CI's windows-latest, whose runner account has it.
 *
 * Probed once per file, by making a link: the privilege is the account's, and
 * nothing else answers the question the way the tests will ask it. Off Windows
 * it is not probed at all, and the answer is yes.
 */

export const SYMLINK_SKIP_REASON = 'this Windows account cannot create symbolic links '
  + '(no SeCreateSymbolicLinkPrivilege: Developer Mode is off, decision D4); '
  + 'these tests run on macOS, Linux and CI windows-latest';

let probed: boolean | undefined;
let said = false;

export function canSymlink(): boolean {
  if (probed !== undefined) return probed;
  if (process.platform !== 'win32') return (probed = true);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tars-symlink-probe-'));
  try {
    fs.writeFileSync(path.join(dir, 'target'), '');
    fs.symlinkSync(path.join(dir, 'target'), path.join(dir, 'link'), 'file');
    probed = true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EPERM') throw error;
    probed = false;
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  return probed;
}

/**
 * True where a test that plants a symbolic link has to skip, for
 * `it.skipIf(cannotSymlink())`. Says why, once per file, the first time it does.
 */
export function cannotSymlink(): boolean {
  const cannot = !canSymlink();
  if (cannot && !said) {
    said = true;
    console.warn(`skipped, the tests that plant a symbolic link: ${SYMLINK_SKIP_REASON}`);
  }
  return cannot;
}
