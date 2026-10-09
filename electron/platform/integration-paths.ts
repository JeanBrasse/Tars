import * as path from 'path';
import { realFs, type Env, type FsProbe } from './fs-probe';
import { envValue } from './path-env';
import { isPlainAbsolute, resolveCliBinary } from './cli-binary';

/**
 * Where three outside programs Tars reads from live, per platform. darwin
 * and linux get the paths the code built
 * inline, to the byte: `path.join(home, 'Library', 'Application Support', ...)`
 * and the same three tailscale names, with no disk access.
 *
 * win32, and the source for each:
 * - Hermes Desktop is an Electron app that ships for Windows. Its userData is
 *   `app.getPath('appData')/Hermes` (NousResearch/hermes-agent,
 *   apps/desktop/electron/product-identity.ts), which Electron maps to the
 *   roaming %APPDATA%. Its own e2e spec names `AppData\Roaming\Hermes\connection.json`.
 * - Tailscale's MSI installs to `C:\Program Files\Tailscale` by default
 *   (tailscale.com/kb/1189/install-windows-msi) and the CLI there is
 *   tailscale.exe. The PATH Tars inherited may not hold it (an install after
 *   Tars started, a PATH trimmed by a launcher), so the install folder is
 *   looked at after the PATH.
 * - Tasmania (mbaril010/tasmania) is macOS only: its README requires macOS,
 *   its one maker is darwin and its releases are arm64 .dmg files. Nothing is
 *   guessed for Windows; the caller gets the reason instead of a path.
 */

type Where = { platform?: NodeJS.Platform; home: string; env?: Env };

/** Hermes Desktop's own connection.json, which Settings > Hermes can import. */
export function hermesDesktopConfigPath({ platform = process.platform, home, env = process.env }: Where): string {
  if (platform !== 'win32') return path.join(home, 'Library', 'Application Support', 'Hermes', 'connection.json');
  const w = path.win32;
  const appData = envValue(env, 'APPDATA', 'win32');
  const roaming = appData && isPlainAbsolute(appData) ? appData : w.join(home, 'AppData', 'Roaming');
  return w.join(roaming, 'Hermes', 'connection.json');
}

/**
 * The tailscale CLIs to try, in order, each given to execFile as is.
 * win32: absolute .exe paths that exist, never a bare name (Windows would
 * also search the current directory for it): the PATH's tailscale.exe, then
 * %ProgramFiles%\Tailscale\tailscale.exe. Empty when neither is there.
 */
export function tailscaleCandidates(
  { platform = process.platform, env = process.env, fs = realFs }: { platform?: NodeJS.Platform; env?: Env; fs?: FsProbe } = {},
): string[] {
  if (platform !== 'win32') return ['tailscale', '/usr/local/bin/tailscale', '/Applications/Tailscale.app/Contents/MacOS/Tailscale'];
  const found: string[] = [];
  const onPath = resolveCliBinary('tailscale', env, 'win32', fs);
  if (onPath.ok && onPath.via === 'exe') found.push(onPath.file);
  const programFiles = envValue(env, 'ProgramFiles', 'win32');
  if (programFiles && isPlainAbsolute(programFiles)) {
    const installed = path.win32.join(programFiles, 'Tailscale', 'tailscale.exe');
    if (fs.isFile(installed) && !found.some((f) => f.toLowerCase() === installed.toLowerCase())) found.push(installed);
  }
  return found;
}

export type TasmaniaToken = { ok: true; path: string } | { ok: false; detail: string };

/** Where Tasmania writes its Control API token, or why there is no such place. */
export function tasmaniaTokenPath({ platform = process.platform, home }: Omit<Where, 'env'>): TasmaniaToken {
  if (platform === 'win32') {
    return { ok: false, detail: 'Tasmania is a macOS app and has no Windows build, so there is no Tasmania Control API on this machine.' };
  }
  return { ok: true, path: path.join(home, 'Library', 'Application Support', 'Tasmania', '.control-api-token') };
}
