import * as nodeFs from 'fs';
import * as path from 'path';
import { realFs, type Env, type FsProbe } from './fs-probe';
import { envValue } from './path-env';
import { childEnv } from './child-env';

/**
 * How Windows plays a notification sound, as a program and its
 * arguments, never a command line built from the file.
 *
 * The file's path comes from app-settings.json, which sits in ~/.dorothy, the
 * directory every agent is handed. It used to be pasted into PowerShell code
 * (`(New-Object Media.SoundPlayer '<path>').PlaySync()`), so a `'` in a file
 * name ended the string and the rest ran. Here the script is one fixed text,
 * passed base64-encoded (-EncodedCommand, so no quoting rule applies to it
 * either), and the path reaches it as data, in the TARS_SOUND_FILE variable.
 *
 * Refused before anything starts: a path that is not a local absolute
 * `X:\...` one (a UNC path would be opened, and opening it sends the
 * account's NTLM hash to that host; `\\?\`, relative and drive-relative paths
 * have no business here), a control character, anything but `.wav` (the only
 * format SoundPlayer plays), and a file that is not there. PowerShell is
 * System32's, by its full path, with no profile: never a `powershell` found on
 * the PATH or in the working directory.
 */
// Progress off: PowerShell otherwise reports loading its modules as a CLIXML record on stderr.
const SCRIPT = "$ProgressPreference = 'SilentlyContinue'; (New-Object System.Media.SoundPlayer $env:TARS_SOUND_FILE).PlaySync()";

export type SoundCommand =
  | { ok: true; file: string; args: string[]; env: NodeJS.ProcessEnv }
  | { ok: false; error: string };

/** A link's target as stored, or null for anything that is not a link. Must not follow the link. */
export type ReadLink = (p: string) => string | null;

const realReadLink: ReadLink = (p) => {
  try {
    return nodeFs.lstatSync(p).isSymbolicLink() ? nodeFs.readlinkSync(p) : null;
  } catch {
    return null;
  }
};

/**
 * Whether a link (symlink or junction) on the way to `file` leads off this
 * machine: to a UNC share, `\\?\UNC\...`, a device (`\\.\...`) or
 * `\\?\GLOBALROOT`. Opening the file would contact that host, which is what
 * refusing a UNC path is for. Walked a segment at a time with lstat and
 * readlink, which never open the target, so the answer comes before anything
 * is contacted. A loop, or more than 32 links, is refused too. Known gap: a
 * drive letter mapped to a share (`net use X: \\host\share`) is not a link,
 * and `X:\a.wav` passes (Node has no drive-type query).
 */
function linkLeavesMachine(file: string, readLink: ReadLink): boolean {
  const w = path.win32;
  const split = (p: string) => {
    const root = w.parse(p).root;
    return { root, segments: p.slice(root.length).split('\\').filter(Boolean) };
  };
  let { root: current, segments: queue } = split(w.resolve(file));
  let hops = 0;
  while (queue.length) {
    const next = w.join(current, queue.shift()!);
    const stored = readLink(next);
    if (stored === null) {
      current = next;
      continue;
    }
    if (++hops > 32) return true;
    let target = stored.replace(/\//g, '\\');
    const local = /^\\\\[?.]\\([A-Za-z]:(\\.*)?)$/.exec(target);
    if (local) target = local[1];
    if (target.startsWith('\\\\')) return true;
    const resolved = split(w.resolve(current, target));
    current = resolved.root;
    queue = [...resolved.segments, ...queue];
  }
  return false;
}

export function windowsSoundCommand(filePath: string, opts: { env?: Env; fs?: FsProbe; readLink?: ReadLink } = {}): SoundCommand {
  const env = opts.env ?? process.env;
  const fs = opts.fs ?? realFs;
  if (typeof filePath !== 'string' || !filePath) return { ok: false, error: 'no sound file' };
  if (/[\x00-\x1f\x7f]/.test(filePath)) return { ok: false, error: 'the sound file path holds a control character' };
  if (!/^[A-Za-z]:[\\/]/.test(filePath)) return { ok: false, error: 'the sound file must be a local absolute path (X:\\...)' };
  if (path.win32.extname(filePath).toLowerCase() !== '.wav') return { ok: false, error: 'only .wav files can be played' };
  if (linkLeavesMachine(filePath, opts.readLink ?? realReadLink)) {
    return { ok: false, error: 'the sound file is reached through a link to a share or a device' };
  }
  if (!fs.isFile(filePath)) return { ok: false, error: 'the sound file is not there' };

  const systemRoot = envValue(env, 'SystemRoot', 'win32') || 'C:\\Windows';
  const file = path.win32.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  return {
    ok: true,
    file,
    args: ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(SCRIPT, 'utf16le').toString('base64')],
    // Through unknown: Env and Next's ProcessEnv (which requires NODE_ENV) do not overlap.
    // No PSModulePath: New-Object is lost under a PowerShell 7 parent's (child-env.ts).
    env: childEnv(file, { ...env, TARS_SOUND_FILE: filePath }, 'win32') as unknown as NodeJS.ProcessEnv,
  };
}
