import * as fs from 'node:fs';
import * as path from 'node:path';
import type * as ChildProcessModule from 'node:child_process';
import type { ChildProcess } from 'node:child_process';

/**
 * The Windows install layouts and the process table the Windows updater tests
 * run against: cli-updater-windows.test.ts and cli-updater-scenarios-windows.test.ts.
 *
 * The layouts are the real ones (read on this machine and in claude 2.1.78's
 * installer, see cli-updater-windows.test.ts): claude.exe a copy of a file in
 * ~/.local/share/claude/versions, npm's global prefix %APPDATA%\npm with its
 * packages in node_modules and npm's own .cmd shims beside them.
 *
 * The process table. The updater's busy check asks PowerShell for every
 * process's path and command line (Get-CimInstance Win32_Process), and matches
 * them itself. On CI's windows-latest one such query took up to 25 s (run
 * 36232894943: three tests of 50 to 70 s, one past its 60 s timeout), so the
 * unit tests answer it here: the rows Get-CimInstance returns for this runner,
 * for a process Windows lists with no path (System), and for every session a
 * test started and is still running, spelled as Windows spells them. What the
 * updater makes of the rows, the matching included, is the product's own code.
 * One test per file that needs it (`processTable.mode = 'real'`) asks the real
 * PowerShell, so the query itself is still proven on the machine.
 */

/** node.exe under another name: a hard link, which needs no privilege, else a copy. */
export function nodeAs(file: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  try { fs.linkSync(process.execPath, file); } catch { fs.copyFileSync(process.execPath, file); }
}

/** npm's cmd-shim over a node script, as npm 10 writes it (copied from %APPDATA%\npm\codex.cmd here). */
export const CMD_SHIM_NODE = (script: string) => [
  '@ECHO off', 'GOTO start', ':find_dp0', 'SET dp0=%~dp0', 'EXIT /b', ':start', 'SETLOCAL', 'CALL :find_dp0', '',
  'IF EXIST "%dp0%\\node.exe" (', '  SET "_prog=%dp0%\\node.exe"', ') ELSE (', '  SET "_prog=node"', '  SET PATHEXT=%PATHEXT:;.JS;=;%', ')', '',
  `endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\\${script}" %*`, '',
].join('\r\n');

/** The same over a native exe (%APPDATA%\npm\claude.cmd here). */
export const CMD_SHIM_EXE = (exe: string) => [
  '@ECHO off', 'GOTO start', ':find_dp0', 'SET dp0=%~dp0', 'EXIT /b', ':start', 'SETLOCAL', 'CALL :find_dp0',
  `"%dp0%\\${exe}"   %*`, '',
].join('\r\n');

/** NODE_OPTIONS for a preload: its parser reads a backslash inside quotes as an escape, so the path goes with forward slashes. */
export const requirePreload = (preload: string) => `--require "${preload.replace(/\\/g, '/')}"`;

/** %USERPROFILE%\.local\bin\claude.exe, a copy of versions\<version>, as the native installer leaves it. */
export function nativeClaudeExe(home: string, version = '1.0.0'): string {
  const launcher = path.join(home, '.local', 'bin', 'claude.exe');
  nodeAs(path.join(home, '.local', 'share', 'claude', 'versions', version));
  nodeAs(launcher);
  return launcher;
}

/** The version claude.exe is a copy of, by size, as the installer reads it. */
export function launcherVersion(home: string): string | undefined {
  const versions = path.join(home, '.local', 'share', 'claude', 'versions');
  const size = fs.statSync(path.join(home, '.local', 'bin', 'claude.exe')).size;
  return fs.readdirSync(versions).find(v => fs.statSync(path.join(versions, v)).size === size);
}

/** %APPDATA%\npm with npm's own shim over `npmCli` (a fake npm-cli.js), and node.exe beside them as the shims prefer. */
export function npmPrefixWith(home: string, npmCli: string): string {
  const prefix = path.join(home, 'AppData', 'Roaming', 'npm');
  fs.mkdirSync(path.join(prefix, 'node_modules', 'npm', 'bin'), { recursive: true });
  fs.writeFileSync(path.join(prefix, 'node_modules', 'npm', 'bin', 'npm-cli.js'), npmCli);
  fs.writeFileSync(path.join(prefix, 'node_modules', 'npm', 'package.json'), JSON.stringify({ name: 'npm', version: '10.9.9' }));
  fs.writeFileSync(path.join(prefix, 'npm.cmd'), CMD_SHIM_NODE('node_modules\\npm\\bin\\npm-cli.js'));
  nodeAs(path.join(prefix, 'node.exe'));
  return prefix;
}

/** <shim>.cmd over <owner>'s script, in the prefix, as `npm install -g <owner>` leaves it. Returns the script. */
export function npmPackage(prefix: string, version = '0.0.1', owner = '@sourcegraph/amp', shim = 'amp'): string {
  const pkgDir = path.join(prefix, 'node_modules', ...owner.split('/'));
  fs.mkdirSync(path.join(pkgDir, 'bin'), { recursive: true });
  fs.writeFileSync(path.join(pkgDir, 'package.json'), JSON.stringify({ name: owner, version }));
  const script = path.join(pkgDir, 'bin', `${shim}.js`);
  fs.writeFileSync(script, "console.log('ready'); setTimeout(() => {}, 60000);\n");
  fs.writeFileSync(path.join(prefix, `${shim}.cmd`), CMD_SHIM_NODE(path.relative(prefix, script)));
  return script;
}

/**
 * What the busy check's PowerShell answers: 'fake' (the rows below), 'broken'
 * (PowerShell cannot be started, as the ACP tests take ps away) or 'real'.
 * `sessions` are the processes the tests started; a test pushes each one.
 */
export const processTable: { mode: 'fake' | 'broken' | 'real'; sessions: ChildProcess[] } = { mode: 'fake', sessions: [] };

/** What the updater asked of every process it started: the file and whether its console window is hidden. */
export const started: { file: string; windowsHide: unknown }[] = [];

/** A command line as Windows builds it from an argv: an argument with a space or a quote goes in double quotes. */
function commandLine(argv: string[]): string {
  return argv.map(a => (/[\s"]/.test(a) ? `"${a.replace(/"/g, '\\"')}"` : a)).join(' ');
}

/** The rows `Get-CimInstance Win32_Process | Select-Object ProcessId,ExecutablePath,CommandLine` gives for this machine as the tests see it. */
export function processRows(): Array<{ ProcessId: number; ExecutablePath: string | null; CommandLine: string | null }> {
  return [
    { ProcessId: 4, ExecutablePath: null, CommandLine: null },
    { ProcessId: process.pid, ExecutablePath: process.execPath, CommandLine: commandLine([process.execPath, ...process.argv.slice(1)]) },
    ...processTable.sessions
      .filter(child => child.pid !== undefined && child.exitCode === null && child.signalCode === null)
      .map(child => ({ ProcessId: child.pid!, ExecutablePath: path.resolve(child.spawnfile), CommandLine: commandLine(child.spawnargs) })),
  ];
}

/**
 * child_process for the updater under test, for a vi.mock factory: execFile
 * records what it starts, and the busy check's PowerShell query is answered
 * from processTable unless its mode is 'real'. Everything else runs.
 */
export function childProcessForTests(actual: typeof ChildProcessModule): typeof ChildProcessModule {
  return {
    ...actual,
    execFile: ((file: string, ...rest: unknown[]) => {
      const options = rest.find(r => r && typeof r === 'object' && !Array.isArray(r)) as { windowsHide?: unknown } | undefined;
      started.push({ file, windowsHide: options?.windowsHide });
      const args = (Array.isArray(rest[0]) ? rest[0] : []) as string[];
      const query = /[\\/]powershell\.exe$/i.test(file) && args.some(a => a.includes('Win32_Process'));
      if (query && processTable.mode !== 'real') {
        const done = rest.find(r => typeof r === 'function') as ((err: Error | null, out: string, errOut: string) => void) | undefined;
        if (processTable.mode === 'broken') {
          setImmediate(() => done?.(Object.assign(new Error(`spawn ${file} ENOENT`), { code: 'ENOENT' }), '', ''));
        } else {
          const rows = JSON.stringify(processRows());
          setImmediate(() => done?.(null, rows, ''));
        }
        return {} as never;
      }
      return (actual.execFile as (...a: unknown[]) => unknown)(file, ...rest);
    }) as typeof actual.execFile,
  };
}

/** Ends every session a test started and waits for each to be gone, so its files can be removed. */
export async function endSessions(): Promise<void> {
  const sessions = processTable.sessions.splice(0);
  await Promise.all(sessions.map(child => new Promise<void>(resolve => {
    if (child.exitCode !== null || child.signalCode !== null || child.pid === undefined) return resolve();
    child.once('exit', () => resolve());
    child.kill();
  })));
}
