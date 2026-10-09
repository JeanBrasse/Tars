import * as os from 'os';
import * as path from 'path';
import { realFs, type Env, type FsProbe } from './fs-probe';
import { envValue, getPath, pathEntries, unquoteEntry } from './path-env';
import { isPlainAbsolute, pathExts, resolveCliBinary, type CliBinaryFailure } from './cli-binary';

/**
 * Finding a CLI on Windows, for Settings > CLI paths and Google Workspace
 * (audit B/C-01..C-05): a path the user typed with or without its extension,
 * a name in the folders Windows installers use and then along the PATH.
 * Moved here from providers/cli-exec.ts, unchanged. win32 only: the callers
 * ask on win32 and nowhere else.
 */

/** Whether the lookup wants a CLI Tars will start, or a command file that only has to be there (gcloud.cmd, which gws runs). */
export type CliLookup = 'startable' | 'present';

const w = path.win32;

/** What only has to be there may still be a batch file the resolver cannot read through. */
const PRESENT_ENOUGH = new Set(['unrecognised-shim', 'shim-target-missing', 'node-not-found']);
/**
 * An npm node shim with no node on this PATH is still the CLI: node is found
 * when it starts, on the agent's PATH, which carries the node the user
 * configured (Settings > CLI paths > Node.js).
 */
const STARTABLE_ENOUGH = new Set(['node-not-found']);

/**
 * `file`, an absolute path with or without its extension, as the file a
 * Windows user means by it: the first `file + ext` in PATHEXT order that
 * exists, or `file` itself when it carries one of those extensions. Never the
 * extensionless sh shim npm writes beside a .cmd. With 'startable' the
 * resolver must be able to start it (node aside, see STARTABLE_ENOUGH); with
 * 'present' a command file that exists is enough.
 */
export function windowsCliFile(
  file: string, env: Env, lookup: CliLookup = 'startable', fs: FsProbe = realFs,
): { path: string } | { failure: CliBinaryFailure } {
  if (!isPlainAbsolute(file)) {
    return { failure: { ok: false, reason: 'invalid-name', name: file, detail: 'Not a plain absolute path: nothing is looked up relative to the current directory.' } };
  }
  const exts = pathExts(env);
  const own = w.extname(file).toLowerCase();
  const candidates = own && exts.includes(own) ? [file] : exts.map((e) => file + e);
  for (const candidate of candidates) {
    if (!fs.isFile(candidate)) continue;
    const binary = resolveCliBinary(candidate, env, 'win32', fs);
    if (binary.ok || (lookup === 'present' ? PRESENT_ENOUGH : STARTABLE_ENOUGH).has(binary.reason)) return { path: candidate };
    return { failure: binary };
  }
  // Nothing with an extension: the resolver says why (not there, or only the sh shim).
  const binary = resolveCliBinary(file, env, 'win32', fs);
  return binary.ok ? { path: file } : { failure: binary };
}

/**
 * The first of `dirs`, then of the env's PATH (unquoted, in order), that
 * holds `name`. `rejected` lists what was there and could not be used (the
 * sh shim alone, a shim whose target is gone), for the log; a folder that
 * does not hold it, or is not a plain absolute path, is skipped silently.
 */
export function findWindowsCli(
  name: string, dirs: string[], env: Env, lookup: CliLookup = 'startable', fs: FsProbe = realFs,
): { path?: string; rejected: CliBinaryFailure[] } {
  const rejected: CliBinaryFailure[] = [];
  const searched = [...dirs, ...pathEntries(getPath(env, 'win32'), 'win32').map(unquoteEntry)];
  for (const dir of searched) {
    const found = windowsCliFile(w.join(dir, name), env, lookup, fs);
    if ('path' in found) return { path: found.path, rejected };
    if (found.failure.reason !== 'not-found' && found.failure.reason !== 'invalid-name') rejected.push(found.failure);
  }
  return { rejected };
}

function profileDirs(env: Env) {
  const home = envValue(env, 'USERPROFILE', 'win32') || os.homedir();
  return {
    home,
    appData: envValue(env, 'APPDATA', 'win32') || w.join(home, 'AppData', 'Roaming'),
    localAppData: envValue(env, 'LOCALAPPDATA', 'win32') || w.join(home, 'AppData', 'Local'),
  };
}

/**
 * Where CLIs land on Windows, before the PATH is searched (macOS's
 * /opt/homebrew/bin and ~/.local/bin have no meaning there): the native
 * claude installer, npm -g, per-user installers, scoop, winget, the grok
 * installer, pnpm -g.
 */
export function windowsCliDirs(env: Env): string[] {
  const { home, appData, localAppData } = profileDirs(env);
  return [
    w.join(home, '.local', 'bin'),
    w.join(appData, 'npm'),
    w.join(localAppData, 'Programs'),
    w.join(home, 'scoop', 'shims'),
    w.join(localAppData, 'Microsoft', 'WinGet', 'Links'),
    w.join(home, '.grok', 'bin'),
    w.join(localAppData, 'pnpm'),
  ];
}

/** The Cloud SDK's bin folder: the per-user install, then the machine-wide ones. gcloud there is gcloud.cmd. */
export function windowsGcloudDirs(env: Env): string[] {
  const { localAppData } = profileDirs(env);
  const sdkBin = (root: string) => w.join(root, 'Google', 'Cloud SDK', 'google-cloud-sdk', 'bin');
  const machine = ['ProgramFiles(x86)', 'ProgramFiles']
    .map((name) => envValue(env, name, 'win32'))
    .filter((root): root is string => !!root && isPlainAbsolute(root));
  return [sdkBin(localAppData), ...machine.map(sdkBin)];
}
