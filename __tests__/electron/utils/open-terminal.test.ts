import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { openTerminal, LINUX_TERMINALS, type OpenTerminalDeps } from '../../../electron/utils/open-terminal';

/**
 * shell:open-terminal on Linux (Noah, 2026-09-24: "l'app doit rester
 * compatible linux"). It ran osascript whatever the platform, which on Linux is
 * "spawn osascript ENOENT": the button did nothing and said so in words nobody
 * could act on.
 *
 * How it fails, written before the code (2026-09-24):
 * 1. Linux runs osascript, or nothing.
 * 2. The terminal opens somewhere else than the directory asked for.
 * 3. The directory reaches a shell: a name with a quote, `$(...)` or a
 *    backtick runs as a command. It must only ever be an argv entry or a cwd.
 * 4. The first terminal tried is missing (a desktop without Debian's
 *    x-terminal-emulator) and the others are never tried.
 * 5. None is installed, and the answer does not say what was looked for.
 * 6. A path that is not a directory, or does not exist, is handed to a
 *    terminal anyway.
 * 7. macOS stops doing what it did: Terminal.app through osascript, the
 *    directory escaped for the shell, then for AppleScript.
 * 8. Another platform throws, or runs something, instead of saying no.
 */

type Spawned = { file: string; args: string[]; options: Record<string, unknown> };

function fakeDeps(platform: NodeJS.Platform, installed: string[]): OpenTerminalDeps & { spawned: Spawned[]; executed: Spawned[] } {
  const spawned: Spawned[] = [];
  const executed: Spawned[] = [];
  return {
    platform,
    spawned,
    executed,
    launch: async (file, args, options) => {
      spawned.push({ file, args, options: options as Record<string, unknown> });
      if (!installed.includes(file)) {
        const err = new Error(`spawn ${file} ENOENT`) as NodeJS.ErrnoException;
        err.code = 'ENOENT';
        throw err;
      }
    },
    execFile: async (file, args, options) => {
      executed.push({ file, args, options: options as Record<string, unknown> });
    },
  };
}

const dir = fs.mkdtempSync(path.join(os.tmpdir(), `tars term 'q' $(id) \`id\` `));

describe('opening a terminal in a directory', () => {
  it('1, 2, 3. on Linux, starts the first terminal installed, in the directory, with no shell between', async () => {
    const deps = fakeDeps('linux', ['x-terminal-emulator']);

    const r = await openTerminal(dir, deps);

    expect(r).toEqual({ success: true, terminal: 'x-terminal-emulator' });
    expect(deps.spawned).toHaveLength(1);
    const [s] = deps.spawned;
    expect(s.file).toBe('x-terminal-emulator');
    expect(s.options.cwd).toBe(dir);
    expect(s.options.shell).toBeFalsy();
    expect(deps.executed).toEqual([]);
  });

  it('4. tries the next one when the first is missing, and passes the directory as an argument where the terminal takes one', async () => {
    const deps = fakeDeps('linux', ['gnome-terminal']);

    const r = await openTerminal(dir, deps);

    expect(r).toEqual({ success: true, terminal: 'gnome-terminal' });
    expect(deps.spawned.map(s => s.file)).toEqual(['x-terminal-emulator', 'gnome-terminal']);
    const gnome = deps.spawned[1];
    expect(gnome.args).toEqual([`--working-directory=${dir}`]);
    expect(gnome.options.cwd).toBe(dir);
  });

  it('4. reaches konsole and xterm in that order', async () => {
    const konsole = fakeDeps('linux', ['konsole']);
    expect((await openTerminal(dir, konsole)).terminal).toBe('konsole');
    expect(konsole.spawned.at(-1)!.args).toEqual(['--workdir', dir]);

    const xterm = fakeDeps('linux', ['xterm']);
    expect((await openTerminal(dir, xterm)).terminal).toBe('xterm');
    expect(xterm.spawned.map(s => s.file)).toEqual(LINUX_TERMINALS.map(t => t.file));
  });

  it('5. says which terminals it looked for when none is installed', async () => {
    const deps = fakeDeps('linux', []);

    const r = await openTerminal(dir, deps);

    expect(r.success).toBe(false);
    for (const t of LINUX_TERMINALS) expect(r.error).toContain(t.file);
  });

  it('6. refuses a path that does not exist, or is not a directory, and starts nothing', async () => {
    const file = path.join(dir, 'a-file');
    fs.writeFileSync(file, 'x');
    for (const target of [path.join(dir, 'missing'), file, '']) {
      const deps = fakeDeps('linux', ['x-terminal-emulator']);
      const r = await openTerminal(target, deps);
      expect(r.success).toBe(false);
      expect(deps.spawned).toEqual([]);
    }
  });

  it('7. on macOS, still asks Terminal.app through osascript, the directory escaped twice', async () => {
    const deps = fakeDeps('darwin', []);

    const r = await openTerminal(dir, deps);

    expect(r.success).toBe(true);
    expect(deps.spawned).toEqual([]);
    expect(deps.executed).toHaveLength(1);
    const [e] = deps.executed;
    expect(e.file).toBe('osascript');
    expect(e.args[0]).toBe('-e');
    const shellQuoted = `'${dir.replace(/'/g, "'\\''")}'`;
    expect(e.args[1]).toBe(`tell application "Terminal" to do script "${`cd ${shellQuoted}`.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`);
  });

  it('8. says no on a platform it does not know, and runs nothing', async () => {
    const deps = fakeDeps('win32', ['x-terminal-emulator']);

    const r = await openTerminal(dir, deps);

    expect(r.success).toBe(false);
    expect(r.error).toMatch(/win32/);
    expect(deps.spawned).toEqual([]);
    expect(deps.executed).toEqual([]);
  });
});

describe('QA #177: the real launcher, with a stand-in terminal that records what it was given', () => {
  // Written by the QA at the gate of #177. The tests above hand openTerminal a
  // fake launcher, so the `shell: false` of the real one was never exercised:
  // `options.shell` is never set by openTerminal, and a real launcher that ran a
  // shell left them green. This goes through nodeLaunch, with a PATH that holds
  // only a stand-in gnome-terminal, so no real terminal can start, here or on
  // the CI. A shell anywhere on the way would run the `$(...)` and the backtick
  // in the directory's name, and leave a PWNED file.
  it('starts the program itself, in the directory, the directory one argument, and runs nothing it names', async () => {
    const { nodeLaunch, nodeExecFile } = await import('../../../electron/utils/open-terminal');
    const bin = fs.mkdtempSync(path.join(os.tmpdir(), 'qa177-bin-'));
    const log = path.join(bin, 'argv.json');
    fs.writeFileSync(path.join(bin, 'gnome-terminal'),
      `#!${process.execPath}\nrequire('fs').writeFileSync(${JSON.stringify(log)}, JSON.stringify({ argv: process.argv.slice(2), cwd: process.cwd() }));\n`,
      { mode: 0o755 });
    const target = fs.mkdtempSync(path.join(os.tmpdir(), "qa177 'q' $(touch PWNED) `touch PWNED` "));
    const saved = process.env.PATH;
    process.env.PATH = bin;
    try {
      const r = await openTerminal(target, { platform: 'linux', launch: nodeLaunch, execFile: nodeExecFile });
      expect(r).toEqual({ success: true, terminal: 'gnome-terminal' });
      for (let i = 0; i < 100 && !fs.existsSync(log); i++) await new Promise(res => setTimeout(res, 50));
      const seen = JSON.parse(fs.readFileSync(log, 'utf8'));
      expect(seen.argv).toEqual([`--working-directory=${target}`]);
      expect(seen.cwd).toBe(fs.realpathSync(target));
      for (const where of [target, bin, process.cwd(), os.tmpdir()]) {
        expect(fs.existsSync(path.join(where, 'PWNED')), `PWNED in ${where}`).toBe(false);
      }
    } finally {
      process.env.PATH = saved;
      fs.rmSync(bin, { recursive: true, force: true });
      fs.rmSync(target, { recursive: true, force: true });
    }
  });
});
