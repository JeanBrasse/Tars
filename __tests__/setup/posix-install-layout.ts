import { cannotSymlink } from './symlink-privilege';

/**
 * Whether a test that plants the macOS and Linux install layout of a CLI has
 * to skip, for `it.skipIf(cannotPlantPosixInstall())`.
 *
 * cli-updater.test.ts and cli-updater-scenarios.test.ts lay out claude's native
 * installer as it is there (~/.local/bin/claude, a link to an extensionless
 * `#!/usr/bin/env node` script in ~/.local/share/claude/versions) and npm's
 * global packages in <prefix>/lib/node_modules behind <prefix>/bin links.
 * Windows has none of that: CI's windows-latest can make the links, so until
 * 2026-09-26 those tests ran there and the updater rightly refused the script
 * as "not a Windows executable" (37 failures in CI run 36232894943). Windows's
 * own layouts (claude.exe copies, npm's .cmd shims) are in
 * cli-updater-windows.test.ts and cli-updater-scenarios-windows.test.ts, with
 * the same assertions for everything that does not depend on the layout.
 *
 * Off Windows the answer is cannotSymlink()'s, which is no: nothing changes on
 * macOS and Linux.
 */

export const POSIX_INSTALL_SKIP_REASON = 'Windows has no native claude link, no <prefix>/lib/node_modules '
  + 'and no extensionless script it can start; these tests plant the macOS and Linux layout, and their '
  + 'Windows counterparts are in cli-updater-windows.test.ts and cli-updater-scenarios-windows.test.ts';

let said = false;

export function cannotPlantPosixInstall(): boolean {
  if (process.platform !== 'win32') return cannotSymlink();
  if (!said) {
    said = true;
    console.warn(`skipped, the tests of the macOS and Linux install layout: ${POSIX_INSTALL_SKIP_REASON}`);
  }
  return true;
}
