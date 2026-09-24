import * as fs from 'fs';
import * as path from 'path';
import { DATA_DIR } from '../constants';

/**
 * The program Tars's own MCP servers run on: the Node inside the app.
 *
 * Every registration used to name `node`, and the CLI that starts a server
 * looks that up on its own PATH. An agent's terminal is `/bin/bash -l`, and on
 * macOS /etc/profile runs path_helper, which puts /etc/paths, /usr/local/bin
 * first, ahead of the PATH Tars hands the shell. Measured on 2026-09-24: the
 * live Tars's servers ran /usr/local/bin/node, Node 18.16, end of life, though
 * the settings named a Node 22 and nvm had 22 and 24. And a machine with no
 * Node at all, which claude's native installer does not need, got no Tars tools.
 *
 * The app's binary is a Node when ELECTRON_RUN_AS_NODE=1 is set, the version
 * Tars ships and runs its own main process on; the seven bundles answered
 * `tools/list` on it in the installed Tars 1.8 (Electron 43, Node 24.18). A
 * checked minimum among the machine's Nodes was the other way: it still leaves
 * a machine with none, or only an old one, without the tools.
 *
 * The CLIs take a command and arguments and no environment of Tars's choosing
 * (and the same files are read by the user's own sessions), so the variable is
 * set by a launcher, ~/.dorothy/bin/tars-mcp-node, which names the app binary.
 * Rewritten when the app has moved (an AppImage mounts somewhere new at each
 * launch), left alone otherwise. This relies on Electron's RunAsNode fuse,
 * which is on by default and which Tars does not turn off; turning it off
 * means giving these servers another runtime first.
 *
 * Windows has no such script to run: `node` there, as before. So is a launcher
 * that cannot be written.
 */
export function mcpNodeCommand(appBinary: string = process.execPath, platform: NodeJS.Platform = process.platform): string {
  if (platform === 'win32') return 'node';
  const launcher = path.join(DATA_DIR, 'bin', 'tars-mcp-node');
  const quoted = `'${appBinary.replace(/'/g, `'\\''`)}'`;
  const script = [
    '#!/bin/sh',
    '# Written by Tars at each start: its MCP servers run on the Node inside the app.',
    `ELECTRON_RUN_AS_NODE=1 exec ${quoted} "$@"`,
    '',
  ].join('\n');
  try {
    let current: string | undefined;
    try { current = fs.readFileSync(launcher, 'utf-8'); } catch { /* not written yet */ }
    if (current !== script) {
      fs.mkdirSync(path.dirname(launcher), { recursive: true, mode: 0o700 });
      const tmp = `${launcher}.tmp`;
      fs.rmSync(tmp, { force: true });
      fs.writeFileSync(tmp, script, { flag: 'wx', mode: 0o700 });
      fs.renameSync(tmp, launcher);
    }
    fs.chmodSync(launcher, 0o700);
    return launcher;
  } catch (err) {
    console.warn('[mcp] the launcher for the MCP servers could not be written, they run on `node`:', err);
    return 'node';
  }
}
