import * as path from 'path';
import { realFs, type Env, type FsProbe } from './fs-probe';
import { envValue } from './path-env';
import { findOnPath } from './cli-binary';
import { resolveShell } from './shell';

/**
 * The shells Settings > Terminal offers on Windows, and the one
 * a terminal gets when the user picked none. darwin/linux: none, the row is not
 * shown there and the shell stays $SHELL (resolveShell).
 *
 * PowerShell 7, Windows PowerShell and the Command Prompt are always listed,
 * with a null path when missing, so the list reads the same on every machine;
 * Git Bash only when it is installed.
 */
export type ShellChoiceId = 'pwsh' | 'powershell' | 'cmd' | 'git-bash';

export interface ShellChoice {
  id: ShellChoiceId;
  /** The executable, or null when it is not installed. */
  path: string | null;
}

export interface DetectedShells {
  /** What a terminal starts with no setting: resolveShell's own answer. */
  defaultPath: string;
  choices: ShellChoice[];
}

const w = path.win32;

export function detectShells(opts: {
  platform?: NodeJS.Platform;
  env?: Env;
  fs?: FsProbe;
} = {}): DetectedShells | null {
  const platform = opts.platform ?? process.platform;
  if (platform !== 'win32') return null;
  const env = opts.env ?? process.env;
  const fs = opts.fs ?? realFs;
  const read = (name: string) => envValue(env, name, 'win32');
  const firstFile = (candidates: (string | undefined)[]) =>
    candidates.find((p): p is string => !!p && fs.isFile(p)) ?? null;

  const systemRoot = read('SystemRoot') || 'C:\\Windows';
  const programDirs = [read('ProgramW6432'), read('ProgramFiles'), read('ProgramFiles(x86)')]
    .filter((d): d is string => !!d);
  const localAppData = read('LOCALAPPDATA');

  const pwsh = findOnPath('pwsh.exe', env, fs)
    ?? firstFile(programDirs.map((d) => w.join(d, 'PowerShell', '7', 'pwsh.exe')));
  const powershell = findOnPath('powershell.exe', env, fs)
    ?? firstFile([w.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')]);
  const cmd = firstFile([read('ComSpec'), w.join(systemRoot, 'System32', 'cmd.exe')]);

  // Git Bash is bin\bash.exe of a Git for Windows install, found from where
  // Git lives: Program Files, the per-user folder, or the root of the Git
  // layout (cmd\, bin\ or mingw64\bin\) around a git.exe on the PATH. bash.exe
  // itself is never looked up on the PATH: the first one there is System32's,
  // the WSL launcher, which is not Git Bash.
  const gitOnPath = findOnPath('git.exe', env, fs);
  const gitRoots = [
    ...programDirs.map((d) => w.join(d, 'Git')),
    ...(localAppData ? [w.join(localAppData, 'Programs', 'Git')] : []),
  ];
  if (gitOnPath) {
    const dir = w.dirname(gitOnPath);
    const leaf = w.basename(dir).toLowerCase();
    if (leaf === 'cmd' || leaf === 'bin') gitRoots.push(w.dirname(dir));
    if (leaf === 'bin' && w.basename(w.dirname(dir)).toLowerCase() === 'mingw64') gitRoots.push(w.dirname(w.dirname(dir)));
  }
  const gitBash = firstFile(gitRoots.map((r) => w.join(r, 'bin', 'bash.exe')));

  const choices: ShellChoice[] = [
    { id: 'pwsh', path: pwsh },
    { id: 'powershell', path: powershell },
    { id: 'cmd', path: cmd },
  ];
  if (gitBash) choices.push({ id: 'git-bash', path: gitBash });

  return { defaultPath: resolveShell({ platform: 'win32', env, fs }), choices };
}
