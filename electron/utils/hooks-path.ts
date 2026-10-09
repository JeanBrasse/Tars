import { app } from 'electron';
import * as path from 'path';

/**
 * The bundled hooks folder: `<app>/hooks`, or `app.asar.unpacked/hooks` in a
 * packaged build, where the CLIs can run the files.
 *
 * A leaf module, imported statically by hooks-manager.ts (which configures the
 * CLIs' hooks) and statusline.ts (which points Claude Code's status line at
 * hooks/statusline.mjs on win32). statusline.ts used to require hooks-manager
 * lazily at call time, which pulled the provider registry in behind it and, as
 * a runtime require of a TypeScript path, could not be loaded outside the
 * compiled build at all.
 */
export function getHooksPath(): string {
  let appPath = app.getAppPath();
  // If running from asar, use unpacked path
  if (appPath.includes('app.asar')) {
    appPath = appPath.replace('app.asar', 'app.asar.unpacked');
  }
  return path.join(appPath, 'hooks');
}
