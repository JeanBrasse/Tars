/**
 * What a test cannot hold on Windows, named once, with the reason it prints.
 *
 * The same shape as symlink-privilege.ts: a function for `skipIf`, or for a
 * guard around one assertion, that answers where the platform lacks the thing
 * and says why, once per file, the first time it does. Each of these still
 * runs on macOS, Linux and CI's ubuntu, where the thing exists.
 *
 * - The `.sh` hooks and the bash status line: Windows ships neither. The
 *   CLIs there run hooks written for Node instead, with tests of their own. A
 *   test whose subject is a `.sh` script run by bash has nothing to run there.
 * - POSIX permission bits: Windows has none. chmod sets or clears the
 *   read-only attribute and stat reports 0o666 or 0o444 whatever was asked
 *   (the secret files are closed by an access list there instead). Only the
 *   assertion on the bits is skipped; the rest of its test runs.
 */

export const SH_HOOKS_REASON = 'the .sh hooks and the bash status line do not ship on Windows '
  + '(the CLIs run hooks written for Node there, with tests of their own); these run on macOS, Linux and CI';

export const POSIX_MODES_REASON = 'Windows has no POSIX permission bits: chmod only sets the read-only '
  + 'attribute and stat reports 0o666 or 0o444; the mode is '
  + 'asserted on macOS, Linux and CI, and the rest of the test runs here';

export const ACCOUNTS_REASON = 'several Claude accounts are off on a Windows build until they are ported '
  + '(owner-only folders by POSIX modes, sign-in by the bare claude); these run on macOS, Linux and CI';

const said = new Set<string>();

/**
 * The system the suite runs on, read once, at load. Several files make the
 * product read another platform (`process.platform` set to 'linux' in a
 * beforeAll, to hold darwin and linux's launch on a Windows host); the disk,
 * the binaries and the hooks shipped are still the host's.
 */
const HOST = process.platform;

/**
 * True on Windows, for `skipIf` or a guard, having said `reason` once per
 * file. For a limit one file alone meets; the shared ones are below.
 */
export function skipOnWindows(reason: string): boolean {
  if (HOST !== 'win32') return false;
  if (!said.has(reason)) {
    said.add(reason);
    console.warn(`skipped on Windows: ${reason}`);
  }
  return true;
}

/** True where a test that runs a `.sh` hook or the bash status line has to skip, for `skipIf`. */
export function shHooksNotShipped(): boolean {
  return skipOnWindows(SH_HOOKS_REASON);
}

/** True where permission bits exist to be asserted; on Windows false, having said why. */
export function hasPosixModes(): boolean {
  return !skipOnWindows(POSIX_MODES_REASON);
}

/** True where the Claude accounts feature is off, for `skipIf`, having said why. */
export function claudeAccountsNotPorted(): boolean {
  return skipOnWindows(ACCOUNTS_REASON);
}
