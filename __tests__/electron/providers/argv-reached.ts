import * as fs from 'node:fs';
import * as path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { toLaunch } from '../../../electron/platform/launch';
import { quoteWindowsArg } from '../../../electron/platform/windows-command-line';

/**
 * A provider's command as its CLI receives it, on the platform the suite runs
 * on, for the tests that read a command "the way the CLI reads it".
 *
 * darwin/linux: through a real bash, which is what runs it there
 * (`bash -l -c "cd <dir> && exec <cmd>"`, or the line typed into a shell).
 *
 * win32: Tars starts no shell (decision D2). The command is read back into
 * words (posix-words.ts), its binary resolved and the Windows command line
 * built by toLaunch (launch.ts), and node-pty hands that command line to
 * CreateProcess as it is. So it goes through the same toLaunch here, and the
 * command line it built reaches the binary verbatim: the argv is the one the
 * binary's own runtime parses out of it, as the CLI's would.
 */

const onWindows = process.platform === 'win32';

/** The JSON array of its arguments, the last line a printer writes. */
function printed(out: string): string[] {
  return JSON.parse(out.trim().split('\n').pop() as string) as string[];
}

export function argvReached(command: string, cwd: string): string[] {
  if (!onWindows) return printed(execFileSync('/bin/bash', ['-c', command], { encoding: 'utf-8' }));
  const launch = toLaunch(command, cwd, process.env, 'win32');
  if (launch.platform !== 'win32') throw new Error('toLaunch gave a posix launch on win32');
  const run = spawnSync(launch.file, [launch.commandLine], {
    cwd: launch.cwd,
    env: launch.env as NodeJS.ProcessEnv,
    encoding: 'utf-8',
    // As node-pty does: the file, then the command line as built, untouched.
    argv0: quoteWindowsArg(launch.file),
    windowsVerbatimArguments: true,
  });
  if (run.error) throw run.error;
  if (run.status !== 0) throw new Error(`${launch.file} exited ${run.status}: ${run.stderr}`);
  return printed(run.stdout);
}

const PRINTER = 'console.log(JSON.stringify(process.argv.slice(2)));\n';

/**
 * A binary that prints its argv, at `file`, and the path a provider is to be
 * given for it. darwin/linux: `file`, a `#!/usr/bin/env node` script. Windows
 * starts no shebang file, and Tars refuses one as not a Windows executable
 * (cli-binary.ts): there a node CLI is an npm cmd-shim in front of its script,
 * so the script is `file.cjs` and the shim, `file.cmd`, is what is returned.
 */
export function writeArgvPrinter(file: string): string {
  if (!onWindows) {
    fs.writeFileSync(file, `#!/usr/bin/env node\n${PRINTER}`, { mode: 0o755 });
    return file;
  }
  const script = `${file}.cjs`;
  fs.writeFileSync(script, PRINTER);
  const shim = `${file}.cmd`;
  fs.writeFileSync(shim, [
    '@ECHO off', 'GOTO start', ':find_dp0', 'SET dp0=%~dp0', 'EXIT /b', ':start', 'SETLOCAL', 'CALL :find_dp0', '',
    'IF EXIST "%dp0%\\node.exe" (', '  SET "_prog=%dp0%\\node.exe"', ') ELSE (', '  SET "_prog=node"', ')', '',
    `endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\\${path.basename(script)}" %*`, '',
  ].join('\r\n'));
  return shim;
}
