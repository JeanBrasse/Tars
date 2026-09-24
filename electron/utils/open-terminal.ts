import * as fs from 'fs';
import { execFile, spawn } from 'child_process';

/**
 * Open a terminal in a directory, on the platforms Tars runs on.
 *
 * macOS: Terminal.app through osascript, as it always did. The directory
 * crosses two languages there, so it is escaped for both: shell quoting for
 * the `cd` that `do script` runs, then AppleScript quoting for the literal that
 * holds it. See shell:open-terminal in handlers/ipc-handlers.ts for the
 * injection this replaced.
 *
 * Linux (Noah, 2026-09-24: "l'app doit rester compatible linux"): the first of
 * LINUX_TERMINALS that is installed, started in the directory (its cwd, and the
 * flag that names the directory where the terminal has one), detached, with an
 * argv array and no shell: the directory is never parsed as a command. Before
 * this, Linux ran osascript and answered "spawn osascript ENOENT".
 *
 * Anything else: a clear refusal.
 */

export interface LinuxTerminal {
  file: string;
  args: (dir: string) => string[];
}

/** Debian's alternative first (it is whatever the desktop chose), then the three common desktops' own. */
export const LINUX_TERMINALS: LinuxTerminal[] = [
  { file: 'x-terminal-emulator', args: () => [] },
  { file: 'gnome-terminal', args: dir => [`--working-directory=${dir}`] },
  { file: 'konsole', args: dir => ['--workdir', dir] },
  { file: 'xterm', args: () => [] },
];

type Options = { cwd?: string; detached?: boolean; stdio?: 'ignore'; timeout?: number };

export interface OpenTerminalDeps {
  platform: NodeJS.Platform;
  /** Starts a program and resolves once it has started; rejects with ENOENT when it is not installed. */
  launch: (file: string, args: string[], options: Options) => Promise<void>;
  execFile: (file: string, args: string[], options: Options) => Promise<void>;
}

/** The real launcher and runner, exported so a proof can drive them on another platform's branch. */
export const nodeLaunch: OpenTerminalDeps['launch'] = (file, args, options) => new Promise((resolve, reject) => {
    const child = spawn(file, args, { ...options, shell: false });
    child.once('error', reject);
    child.once('spawn', () => { child.unref(); resolve(); });
  });

export const nodeExecFile: OpenTerminalDeps['execFile'] = (file, args, options) => new Promise((resolve, reject) => {
  execFile(file, args, options, err => (err ? reject(err) : resolve()));
});

const realDeps: OpenTerminalDeps = { platform: process.platform, launch: nodeLaunch, execFile: nodeExecFile };

export type OpenTerminalResult = { success: true; terminal: string } | { success: false; error: string; terminal?: undefined };

export async function openTerminal(cwd: string, deps: OpenTerminalDeps = realDeps): Promise<OpenTerminalResult> {
  const dir = String(cwd || '');
  let isDir = false;
  try {
    isDir = !!dir && fs.statSync(dir).isDirectory();
  } catch {
    isDir = false;
  }
  if (!isDir) return { success: false, error: 'no such directory' };

  if (deps.platform === 'darwin') {
    const shellQuoted = `'${dir.replace(/'/g, "'\\''")}'`;
    const appleQuoted = `"${`cd ${shellQuoted}`.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
    try {
      await deps.execFile('osascript', ['-e', `tell application "Terminal" to do script ${appleQuoted}`], { timeout: 15000 });
      return { success: true, terminal: 'Terminal' };
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  if (deps.platform === 'linux') {
    for (const terminal of LINUX_TERMINALS) {
      try {
        await deps.launch(terminal.file, terminal.args(dir), { cwd: dir, detached: true, stdio: 'ignore' });
        return { success: true, terminal: terminal.file };
      } catch (err) {
        if ((err as NodeJS.ErrnoException)?.code === 'ENOENT') continue;
        return { success: false, error: `${terminal.file}: ${err instanceof Error ? err.message : String(err)}` };
      }
    }
    return { success: false, error: `No terminal found: looked for ${LINUX_TERMINALS.map(t => t.file).join(', ')}.` };
  }

  return { success: false, error: `Opening a terminal is not supported on ${deps.platform}.` };
}
