#!/usr/bin/env node
/**
 * `npm run build:renderer`: the renderer as a static export, for packaging. It
 * replaces this, which neither cmd.exe nor PowerShell can run (and whose
 * `bash`, on Windows, is WSL's):
 *
 *   set -e
 *   rm -rf .next out
 *   mv src/app/api src/app/_api_backup
 *   mv src/app/icon.tsx src/app/_icon_backup.tsx 2>/dev/null || true
 *   trap "mv src/app/_api_backup src/app/api; mv src/app/_icon_backup.tsx src/app/icon.tsx" EXIT
 *   ELECTRON_BUILD=1 next build
 *
 * next.config.ts switches to `output: 'export'` under ELECTRON_BUILD=1, and a
 * static export can hold neither route handlers nor a dynamic icon: both wait
 * aside while next build runs, and come back however it ends. The same steps,
 * in the same order, and the same exit code: next build's own, or, when a
 * signal stopped it, death by that same signal. Where it does more than the
 * shell did, it is where the shell lost work without a word:
 *   - an interrupted build (Ctrl+C, SIGTERM, a closed terminal) puts them back
 *     only once next build has stopped, and on POSIX a signal sent to this
 *     process alone is passed on to next build, which the shell left running;
 *   - a backup left by a build killed outright (SIGKILL: nothing can put it
 *     back) stops the build before anything moves. The shell moved
 *     src/app/api inside it;
 *   - a restore that fails is reported and fails the build. The shell's mv
 *     nested the folder or failed silently, and exited 0.
 *
 * Tested in __tests__/scripts/build-renderer.test.ts.
 */

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import { constants } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** What a static export cannot hold, and where it waits during the build. A checkout may have no icon. */
const ASIDE = [
  { from: 'src/app/api', to: 'src/app/_api_backup', required: true },
  { from: 'src/app/icon.tsx', to: 'src/app/_icon_backup.tsx', required: false },
];

const RECOVER = 'OPERATIONS.md, "Build the renderer for packaging", says how to put things back by hand';

const log = message => process.stderr.write(`build:renderer: ${message}\n`);

/** `next build`, as `npm run` would start it: this checkout's next, by the node running this script. */
export function nextBuild() {
  const require = createRequire(import.meta.url);
  const manifest = require.resolve('next/package.json');
  const { bin } = require(manifest);
  return { command: process.execPath, args: [path.join(path.dirname(manifest), typeof bin === 'string' ? bin : bin.next), 'build'] };
}

/**
 * Moves the routes and the icon aside, runs `build` in `root` with
 * ELECTRON_BUILD=1, and puts them back. Resolves to how the build ended,
 * `{ code, signal }`, as a child process reports it.
 */
export async function buildRenderer({ root = process.cwd(), build = nextBuild(), platform = process.platform } = {}) {
  const at = file => path.join(root, file);
  let child;

  // Caught from the start, so that nothing kills this process between a move
  // and its restore. On POSIX a signal can be meant for this process alone (a
  // kill, a parent tool), so it is passed on and next build stops. On Windows,
  // Ctrl+C, Ctrl+Break and closing the console reach every process of the
  // console, next build included, and child.kill would be a TerminateProcess
  // that leaves next's workers behind: there is nothing to pass on.
  const signals = platform === 'win32' ? ['SIGINT', 'SIGBREAK', 'SIGHUP'] : ['SIGINT', 'SIGTERM', 'SIGHUP'];
  const onSignal = signal => {
    if (platform !== 'win32' && child && child.exitCode === null && child.signalCode === null) child.kill(signal);
  };
  for (const signal of signals) process.on(signal, onSignal);

  const moved = [];
  let result;
  try {
    result = await (async () => {
      for (const dir of ['.next', 'out']) fs.rmSync(at(dir), { recursive: true, force: true });
      for (const { to } of ASIDE) {
        if (fs.existsSync(at(to))) {
          log(`${to} already exists: a build was stopped before it could put it back. Nothing was moved. ${RECOVER}.`);
          return { code: 1, signal: null };
        }
      }
      for (const { from, to, required } of ASIDE) {
        if (!fs.existsSync(at(from))) {
          if (!required) continue;
          log(`cannot move ${from} aside: it does not exist. Nothing was built.`);
          return { code: 1, signal: null };
        }
        fs.renameSync(at(from), at(to));
        moved.push({ from, to });
      }
      return new Promise(resolve => {
        child = spawn(build.command, build.args, { cwd: root, stdio: 'inherit', env: { ...process.env, ELECTRON_BUILD: '1' } });
        child.once('error', err => {
          log(`could not start next build: ${err.message}`);
          resolve({ code: 1, signal: null });
        });
        child.once('close', (code, signal) => resolve({ code, signal }));
      });
    })();
  } catch (err) {
    log(err.message);
    result = { code: 1, signal: null };
  }

  let restored = true;
  for (const { from, to } of moved) {
    try {
      fs.renameSync(at(to), at(from));
    } catch (err) {
      restored = false;
      log(`could not put ${to} back as ${from} (${err.code ?? err.message}): it is still there. ${RECOVER}.`);
    }
  }
  for (const signal of signals) process.off(signal, onSignal);
  return !restored && result.code === 0 ? { code: 1, signal: null } : result;
}

/** The command: exits as next build did, or dies of the signal that stopped it, as the shell did. */
export async function main(options) {
  const { code, signal } = await buildRenderer(options);
  if (signal) {
    process.exitCode = 128 + (constants.signals[signal] ?? 0);
    process.kill(process.pid, signal);
    return;
  }
  process.exitCode = code;
}

/** Run as a command, and not imported: Node runs a module from its real path, so argv[1] is compared resolved, as in release.mjs. */
function invokedDirectly() {
  try {
    return !!process.argv[1] && fs.realpathSync(process.argv[1]) === fileURLToPath(import.meta.url);
  } catch {
    return false;
  }
}

if (invokedDirectly()) {
  main().catch(err => {
    log(err.stack ?? String(err));
    process.exitCode = 1;
  });
}
