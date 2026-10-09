/**
 * How a script runs npm or npx with no shell, on every platform.
 *
 * On macOS and Linux, npm and npx are executables on the PATH and a script
 * spawns them by name: that stays exactly as it was. On Windows they are
 * npm.cmd and npx.cmd, batch shims: spawn cannot find them without a shell
 * (ENOENT), and with one every argument would be read again by cmd.exe
 * (CVE-2024-27980). So on Windows the command is node itself, running npm's
 * own JavaScript entry point: the npm that started this script when
 * npm_execpath names it, otherwise the npm installed beside this node.
 * Nothing found is an error that says where it looked, never a bare name.
 *
 * Tested in __tests__/scripts/npm-command.test.ts.
 */

import { existsSync } from 'node:fs';
import path from 'node:path';

/**
 * @param {'npm' | 'npx'} tool
 * @param {readonly string[]} args
 * @param {{ platform?: string, env?: Record<string, string | undefined>, execPath?: string, exists?: (file: string) => boolean }} [on]
 * @returns {{ command: string, args: string[] }} what to hand to spawn or execFile, without `shell`
 */
export function npmCommand(tool, args, { platform = process.platform, env = process.env, execPath = process.execPath, exists = existsSync } = {}) {
  if (tool !== 'npm' && tool !== 'npx') throw new TypeError(`npmCommand runs npm or npx, not ${tool}`);
  if (platform !== 'win32') return { command: tool, args: [...args] };

  const { basename, dirname, join } = path.win32;
  const entry = `${tool}-cli.js`;
  const places = [];
  // npm sets npm_execpath to its own entry point for the scripts it runs; yarn and pnpm set it to theirs.
  const started = env.npm_execpath;
  if (started && ['npm-cli.js', 'npx-cli.js'].includes(basename(started))) places.push(join(dirname(started), entry));
  // Where the Windows installer, nvm-windows and the zip all put it: node_modules\npm next to node.exe.
  places.push(join(dirname(execPath), 'node_modules', 'npm', 'bin', entry));

  const found = places.find(place => exists(place));
  if (!found) throw new Error(`cannot find ${entry} to run ${tool} without a shell: looked at ${places.join(' and ')}`);
  return { command: execPath, args: [found, ...args] };
}
