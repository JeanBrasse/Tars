import * as path from 'node:path';
import type { FsProbe } from '../../../electron/platform/fs-probe';

/**
 * A Windows disk in memory, and the shim formats npm and Node write, for the
 * tests of electron/providers/cli-exec.ts and its callers. The shim texts are
 * the ones __tests__/electron/platform/cli-binary.test.ts copied from this
 * machine (%APPDATA%\npm\codex.cmd, %APPDATA%\npm\claude.cmd, Node's npx.cmd).
 */

export const CMD_SHIM_NODE = (script: string) => [
  '@ECHO off', 'GOTO start', ':find_dp0', 'SET dp0=%~dp0', 'EXIT /b', ':start', 'SETLOCAL', 'CALL :find_dp0', '',
  'IF EXIST "%dp0%\\node.exe" (', '  SET "_prog=%dp0%\\node.exe"', ') ELSE (', '  SET "_prog=node"', '  SET PATHEXT=%PATHEXT:;.JS;=;%', ')', '',
  `endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\\${script}" %*`, '',
].join('\r\n');

export const CMD_SHIM_EXE = (exe: string) => [
  '@ECHO off', 'GOTO start', ':find_dp0', 'SET dp0=%~dp0', 'EXIT /b', ':start', 'SETLOCAL', 'CALL :find_dp0',
  `"%dp0%\\${exe}"   %*`, '',
].join('\r\n');

export const NODE_DIST_NPX = [
  ':: Created by npm, please don\'t edit manually.', '@ECHO OFF', '', 'SETLOCAL', '',
  'SET "NODE_EXE=%~dp0\\node.exe"', 'IF NOT EXIST "%NODE_EXE%" (', '  SET "NODE_EXE=node"', ')', '',
  'SET "NPM_PREFIX_JS=%~dp0\\node_modules\\npm\\bin\\npm-prefix.js"',
  'SET "NPX_CLI_JS=%~dp0\\node_modules\\npm\\bin\\npx-cli.js"',
  'FOR /F "delims=" %%F IN (\'CALL "%NODE_EXE%" "%NPM_PREFIX_JS%"\') DO (',
  '  SET "NPM_PREFIX_NPX_CLI_JS=%%F\\node_modules\\npm\\bin\\npx-cli.js"', ')',
  'IF EXIST "%NPM_PREFIX_NPX_CLI_JS%" (', '  SET "NPX_CLI_JS=%NPM_PREFIX_NPX_CLI_JS%"', ')', '',
  '"%NODE_EXE%" "%NPX_CLI_JS%" %*', '',
].join('\r\n');

/** The POSIX script npm writes beside every .cmd, which Windows cannot start. */
export const SH_SHIM = '#!/bin/sh\nbasedir=$(dirname "$(echo "$0" | sed -e \'s,\\\\,/,g\')")\nexec node "$basedir/node_modules/x/cli.js" "$@"\n';

/** gcloud.cmd is a batch file of the Cloud SDK that runs python: no npm shim. */
export const GCLOUD_CMD = '@echo off\r\nsetlocal\r\n"%CLOUDSDK_PYTHON%" "%~dp0\\..\\lib\\gcloud.py" %*\r\n';

const isDriveOrUnc = (p: string) => /^([a-z]:\\|\\\\)/i.test(p);

/**
 * Case-insensitive, backslash paths, contents readable. A relative path is
 * recorded: nothing here should ever ask the disk about one.
 */
export function fakeWinFs(files: Record<string, string>): FsProbe & { relativeProbes: string[]; probes: string[] } {
  const map = new Map(Object.entries(files).map(([k, v]) => [k.toLowerCase(), v]));
  const relativeProbes: string[] = [];
  const probes: string[] = [];
  const onDisk = (p: string) => {
    probes.push(p);
    if (isDriveOrUnc(p)) return p;
    relativeProbes.push(p);
    return path.win32.resolve('C:\\cwd-plant', p);
  };
  return {
    relativeProbes,
    probes,
    isFile: (p) => map.has(onDisk(p).toLowerCase()),
    readFile: (p) => {
      const v = map.get(onDisk(p).toLowerCase());
      if (v === undefined) throw Object.assign(new Error(`ENOENT ${p}`), { code: 'ENOENT' });
      return v;
    },
  };
}

/** Run with process.platform reading `platform`, as it does on that host. */
export function pinPlatform(platform: NodeJS.Platform): () => void {
  const original = Object.getOwnPropertyDescriptor(process, 'platform')!;
  Object.defineProperty(process, 'platform', { ...original, value: platform });
  return () => Object.defineProperty(process, 'platform', original);
}
