import * as fs from 'fs';
import * as path from 'path';
import { envValue, getPath, resolveCliBinary, withPath } from '../platform';

/**
 * How cli-updater.ts reads and updates the CLIs on Windows (audit A28). Its
 * own module, so that the upstream file carries one call per site and nothing
 * else: darwin and linux never reach anything here.
 *
 * Windows has the same two update paths as macOS, laid out otherwise, and
 * every CLI was "skipped: not installed" there until they were read as they
 * are:
 * - The native installer leaves no link. It copies the version it installs
 *   over %USERPROFILE%\.local\bin\claude.exe, the running one renamed aside
 *   (claude.exe.old.<time>), and takes a launcher whose size is a version's as
 *   being on that version: the win32 branch of its installer, read out of the
 *   2.1.78 binary. So the version is the file in versions the launcher has the
 *   size of, before and after `claude.exe update`. Tars runs that update there
 *   too, for the reason it does on macOS: every claude it starts has
 *   DISABLE_AUTOUPDATER=1 (managedCliEnv), so left to itself a claude run
 *   through Tars would never update. The update is the one each session's
 *   own updater would run beside its running claude.exe, which is why the
 *   installer renames rather than overwrites; its effect on a Windows session
 *   has not been measured, since no real CLI is updated here to find out.
 * - npm's global prefix is %APPDATA%\npm, its packages in node_modules right
 *   under it and its .cmd shims beside them. A shim is read through by the
 *   platform resolver: npm.cmd to the node and npm-cli.js it runs, amp.cmd to
 *   the script or the exe inside its package.
 * - There is no lsof. A package is in use when a process runs from its folder
 *   or names it on its command line (node.exe <script>), read from
 *   Win32_Process through PowerShell, and npm replaces that folder whole.
 */

const w = path.win32;

export type WindowsInstall =
  | { kind: 'native'; launcher: string; binary: string; version: string }
  | { kind: 'npm'; launcher: string; binary: string; prefix: string; pkg: string; version: string }
  | { kind: 'other'; launcher: string; binary: string };

function readJson(file: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf-8'));
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

/** 1.2.3 as numbers, as cli-updater.ts reads a release; null for anything else. */
function release(version: string): number[] | null {
  const m = /^(\d+)\.(\d+)\.(\d+)/.exec(version);
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

function newer(candidate: string, installed: string): boolean {
  const a = release(candidate);
  const b = release(installed);
  if (!a || !b) return false;
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] > b[i];
  return false;
}

/**
 * What a launch starts, by the platform resolver (PATH and PATHEXT, npm shims
 * read through): the .exe, or for a node shim the script it runs, which is the
 * file inside the package. With the resolver's reason when there is something
 * by that name Windows cannot start.
 */
export function locateOnWindows(command: string, envPath: string): { file?: string; why?: string } {
  const found = resolveCliBinary(command, { PATH: envPath }, 'win32');
  if (found.ok) return { file: found.via === 'npm-shim-node' ? found.prefixArgs[0] : found.file };
  return found.reason === 'not-found' ? {} : { why: found.detail };
}

/** Why a command that was not found is not "not installed": something by that name Windows cannot start. */
export function unstartableOnWindows(command: string, envPath: string): string | undefined {
  const why = locateOnWindows(command, envPath).why;
  return why ? `${command} cannot be started: ${why}` : undefined;
}

/** Where a global package's manifest is on Windows: <prefix>\node_modules, no lib. */
export function windowsGlobalManifest(prefix: string, pkg: string): string {
  return w.join(prefix, 'node_modules', ...pkg.split('/'), 'package.json');
}

/**
 * How a CLI is installed, from where its launcher really is: the native
 * launcher is ~/.local/bin/claude.exe on the version whose file in
 * ~/.local/share/claude/versions it has the size of, and a global npm package
 * sits in <prefix>\node_modules, the prefix being where the shim is.
 */
export function classifyWindowsInstall(launcher: string, binary: string): WindowsInstall {
  const bin = w.dirname(binary);
  if (w.basename(binary).toLowerCase() === 'claude.exe' && w.basename(bin).toLowerCase() === 'bin'
    && w.basename(w.dirname(bin)).toLowerCase() === '.local') {
    const version = windowsNativeVersion(binary);
    if (version) return { kind: 'native', launcher, binary, version };
  }
  const marker = `${w.sep}node_modules${w.sep}`;
  const at = binary.toLowerCase().indexOf(marker);
  if (at > 0) {
    const prefix = binary.slice(0, at);
    const [first, second] = binary.slice(at + marker.length).split(w.sep);
    const pkg = first.startsWith('@') ? `${first}/${second}` : first;
    const manifest = readJson(windowsGlobalManifest(prefix, pkg));
    if (manifest?.name === pkg && typeof manifest.version === 'string') {
      return { kind: 'npm', launcher, binary, prefix, pkg, version: manifest.version };
    }
  }
  return { kind: 'other', launcher, binary };
}

/**
 * The version a native launcher is a copy of: the newest file in versions
 * with its size, which is how claude's own installer tells whether the
 * launcher is already on a version. Null when none has it.
 */
export function windowsNativeVersion(launcher: string): string | null {
  const versions = w.join(w.dirname(w.dirname(launcher)), 'share', 'claude', 'versions');
  let size: number;
  let names: string[];
  try {
    size = fs.statSync(launcher).size;
    names = fs.readdirSync(versions);
  } catch {
    return null;
  }
  const same = names.filter(name => {
    if (!release(name)) return false;
    try {
      const stat = fs.statSync(w.join(versions, name));
      return stat.isFile() && stat.size === size;
    } catch {
      return false;
    }
  });
  return same.reduce<string | null>((best, name) => (best === null || newer(name, best) ? name : best), null);
}

/**
 * npm for a global prefix: the node and npm-cli.js its npm.cmd runs, the
 * prefix first on the PATH (where npm.cmd sits beside the packages), and the
 * environment to run it in, PATH under one name.
 */
export function npmOnWindows(prefix: string, env: NodeJS.ProcessEnv): { file: string; args: string[]; env: NodeJS.ProcessEnv } | null {
  const searchPath = `${prefix};${getPath(env, 'win32') ?? ''}`;
  const found = resolveCliBinary('npm', { PATH: searchPath }, 'win32');
  if (!found.ok) return null;
  return { file: found.file, args: found.prefixArgs, env: { ...(withPath(env, searchPath, 'win32') as NodeJS.ProcessEnv), npm_config_update_notifier: 'false' } };
}

/** A path as Windows compares it: backslashes, no case. */
function comparable(text: string): string {
  return text.replace(/\//g, '\\').toLowerCase();
}

/**
 * Windows's answer to lsof, for a package npm is about to replace: the pids
 * running from its folder, or naming it on their command line (node.exe and
 * a script of the package's), however the path is spelled. Read from
 * Win32_Process by the PowerShell under %SystemRoot%, never one found on the
 * PATH, whose command holds nothing of the package: the match is made here.
 * Null when it cannot be told.
 */
export async function processesInPackage(
  file: string,
  env: NodeJS.ProcessEnv,
  run: (file: string, args: string[]) => Promise<{ code: number | string; stdout: string }>,
): Promise<number[] | null> {
  const dir = /^(.*?\\node_modules\\(?:@[^\\]+\\)?[^\\]+)(?:\\|$)/i.exec(file)?.[1] ?? file;
  const systemRoot = envValue(env, 'SystemRoot', 'win32') || 'C:\\Windows';
  const powershell = w.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  const script = '[Console]::OutputEncoding = [Text.Encoding]::UTF8; '
    + 'Get-CimInstance Win32_Process | Select-Object ProcessId,ExecutablePath,CommandLine | ConvertTo-Json -Compress';
  const result = await run(powershell, ['-NoProfile', '-NonInteractive', '-Command', script]);
  if (result.code !== 0) return null;
  let rows: unknown;
  try {
    rows = JSON.parse(result.stdout);
  } catch {
    return null;
  }
  // The folder and a separator: `...\@sourcegraph\amp` must not match `...\@sourcegraph\amp-next`.
  const needle = `${comparable(dir)}\\`;
  const names = (text: unknown) => typeof text === 'string' && comparable(text).includes(needle);
  return (Array.isArray(rows) ? rows : [rows])
    .filter((row): row is { ProcessId: number; ExecutablePath?: unknown; CommandLine?: unknown } =>
      !!row && typeof (row as { ProcessId?: unknown }).ProcessId === 'number')
    .filter(row => row.ProcessId !== process.pid && (names(row.ExecutablePath) || names(row.CommandLine)))
    .map(row => row.ProcessId);
}
