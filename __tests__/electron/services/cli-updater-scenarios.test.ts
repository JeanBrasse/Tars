import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { runCliUpdatePass, updateCli, startCliUpdates, CLI_UPDATES_LOG, type CliUpdateContext } from '../../../electron/services/cli-updater';
import type { AppSettings } from '../../../electron/types';

/**
 * What cli-updater.test.ts does not pin, written by QA at the gate of PR #119:
 * the 5 s and 30 min timers, one pass at a time, one CLI at a time, the first
 * pass naming what it leaves alone, and failure paths the other file does not
 * reach. Thirteen mutants of cli-updater.ts are killed here and nowhere else.
 * Fakes only, scratch folders only.
 */

const NODE_DIR = path.dirname(process.execPath);

// Every test here starts real processes (node scripts, lsof). The first one
// took 546 ms alone and 5036 ms beside two other runs on a loaded machine,
// past vitest's 5 s default: the time is spawning, not the code under test.
vi.setConfig({ testTimeout: 30_000 });

const SLOW_CLAUDE = `#!/usr/bin/env node
const fs = require('fs'), path = require('path');
const args = process.argv.slice(2);
const log = (x) => fs.appendFileSync(process.env.FAKE_CALLS, JSON.stringify(x) + '\\n');
log(['claude-start', args.join(' '), Date.now()]);
const link = path.join(process.env.HOME, '.local/bin/claude');
const versions = path.join(process.env.HOME, '.local/share/claude/versions');
const current = path.basename(fs.realpathSync(link));
Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Number(process.env.SLOW_MS || 0));
const mode = process.env.FAKE_CLAUDE_MODE || 'update';
if (args[0] === 'update' && mode === 'update') {
  const next = process.env.FAKE_NEXT || '1.0.1';
  fs.copyFileSync(path.join(versions, current), path.join(versions, next));
  fs.symlinkSync(path.join(versions, next), link + '.tmp');
  fs.renameSync(link + '.tmp', link);
  console.log('Successfully updated from ' + current + ' to version ' + next);
} else if (args[0] === 'update' && mode === 'current') {
  console.log('Claude Code is up to date (' + current + ')');
} else if (args[0] === 'update' && mode === 'unlink') {
  fs.unlinkSync(link);
  console.log('Successfully updated');
}
log(['claude-end', Date.now()]);
`;

const FAKE_NPM = `#!/usr/bin/env node
const fs = require('fs'), path = require('path');
const args = process.argv.slice(2);
const log = (x) => fs.appendFileSync(process.env.FAKE_CALLS, JSON.stringify(x) + '\\n');
log(['npm-start', args[0], args.includes('--global') ? 'global' : 'local', Date.now()]);
Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Number(process.env.NPM_SLOW_MS || 0));
const mode = process.env.FAKE_NPM_MODE || 'ok';
if (args[0] === 'view') { console.log(process.env.FAKE_LATEST); log(['npm-end', Date.now()]); process.exit(0); }
if (args[0] === 'install' && !args.includes('--global') && mode === 'download-fails') {
  console.error('npm error code E404'); log(['npm-end', Date.now()]); process.exit(1);
}
if (args[0] === 'install' && args.includes('--global') && mode !== 'no-change') {
  const spec = args[args.length - 1];
  const at = spec.lastIndexOf('@');
  const manifest = path.join(args[args.indexOf('--prefix') + 1], 'lib', 'node_modules', spec.slice(0, at), 'package.json');
  const m = JSON.parse(fs.readFileSync(manifest, 'utf8'));
  m.version = spec.slice(at + 1);
  fs.writeFileSync(manifest, JSON.stringify(m));
}
log(['npm-end', Date.now()]);
process.exit(0);
`;

let root: string;
let calls: string;

beforeEach(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'qa-cliupd-')));
  calls = path.join(root, 'calls.jsonl');
  fs.writeFileSync(calls, '');
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

const recorded = (): unknown[][] => fs.readFileSync(calls, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l));
const logLines = (file: string): string[] => (fs.existsSync(file) ? fs.readFileSync(file, 'utf8').split('\n').filter(Boolean) : []);
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

function ctxFor(home: string, env: Record<string, string> = {}, dirs?: string[]): CliUpdateContext {
  return {
    home,
    logFile: path.join(root, 'cli-updates.log'),
    env: {
      HOME: home,
      PATH: (dirs ?? [path.join(home, '.local', 'bin'), NODE_DIR, '/usr/bin', '/bin', '/usr/sbin', '/sbin']).join(path.delimiter),
      FAKE_CALLS: calls,
      ...env,
    },
  };
}

function nativeClaude(home: string, version = '1.0.0'): void {
  const versions = path.join(home, '.local', 'share', 'claude', 'versions');
  fs.mkdirSync(versions, { recursive: true });
  fs.mkdirSync(path.join(home, '.local', 'bin'), { recursive: true });
  fs.writeFileSync(path.join(versions, version), SLOW_CLAUDE, { mode: 0o755 });
  fs.symlinkSync(path.join(versions, version), path.join(home, '.local', 'bin', 'claude'));
}

function npmAmp(prefix: string, version = '0.0.1'): string {
  const pkgDir = path.join(prefix, 'lib', 'node_modules', '@sourcegraph', 'amp');
  const binDir = path.join(pkgDir, 'node_modules', '@ampcode', 'cli', 'bin');
  fs.mkdirSync(binDir, { recursive: true });
  fs.writeFileSync(path.join(pkgDir, 'package.json'), JSON.stringify({ name: '@sourcegraph/amp', version }));
  fs.writeFileSync(path.join(binDir, 'amp.exe'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  fs.mkdirSync(path.join(prefix, 'bin'), { recursive: true });
  fs.symlinkSync(path.relative(path.join(prefix, 'bin'), path.join(binDir, 'amp.exe')), path.join(prefix, 'bin', 'amp'));
  fs.writeFileSync(path.join(prefix, 'bin', 'npm'), FAKE_NPM, { mode: 0o755 });
  return path.join(prefix, 'bin', 'amp');
}

type Captured = { fn: () => void; ms: number; unref: boolean };

function captureTimers(run: () => void): { timeouts: Captured[]; intervals: Captured[] } {
  const timeouts: Captured[] = [];
  const intervals: Captured[] = [];
  const fake = (into: Captured[]) => ((fn: () => void, ms: number) => {
    const t: Captured = { fn, ms, unref: false };
    into.push(t);
    return { unref() { t.unref = true; } };
  }) as never;
  const st = vi.spyOn(globalThis, 'setTimeout').mockImplementation(fake(timeouts));
  const si = vi.spyOn(globalThis, 'setInterval').mockImplementation(fake(intervals));
  try {
    run();
  } finally {
    st.mockRestore();
    si.mockRestore();
  }
  return { timeouts, intervals };
}

describe('QA #119: the schedule', () => {
  it('Q1 arms the first pass at 5 s and the next every 30 min, neither holding the app open', () => {
    const { timeouts, intervals } = captureTimers(() => startCliUpdates(() => ({}) as AppSettings));
    expect(timeouts.map(t => [t.ms, t.unref])).toEqual([[5000, true]]);
    expect(intervals.map(t => [t.ms, t.unref])).toEqual([[30 * 60 * 1000, true]]);
  });

  it('Q2 first pass updates claude and names an installed CLI it leaves alone; a tick during a pass starts nothing; the next tick runs', async () => {
    const home = os.homedir();
    nativeClaude(home, '1.0.0');
    const codexRan = path.join(root, 'codex-ran');
    fs.writeFileSync(path.join(home, '.local', 'bin', 'codex'), `#!/bin/sh\necho ran >> '${codexRan}'\n`, { mode: 0o755 });
    const keys = ['FAKE_CALLS', 'SLOW_MS', 'FAKE_NEXT', 'FAKE_CLAUDE_MODE'];
    Object.assign(process.env, { FAKE_CALLS: calls, SLOW_MS: '1500', FAKE_NEXT: '1.0.1' });
    // The scheduled pass searches the PATH the app has, and the directory that
    // holds node can hold real CLIs too (an nvm bin holds a global Amp): a
    // node on its own, so this pass sees the fakes and nothing real.
    const nodeOnly = path.join(root, 'node-only');
    fs.mkdirSync(nodeOnly);
    // A script, not a link: removing a link to the real node reads as a write
    // into the real home to the suite's isolation guard.
    fs.writeFileSync(path.join(nodeOnly, 'node'), `#!/bin/sh\nexec '${process.execPath}' "$@"\n`, { mode: 0o755 });
    const savedPath = process.env.PATH;
    process.env.PATH = [nodeOnly, '/usr/bin', '/bin', '/usr/sbin', '/sbin'].join(path.delimiter);
    try {
      const { timeouts, intervals } = captureTimers(() => startCliUpdates(() => ({ cliPaths: {} }) as unknown as AppSettings));
      const [first] = timeouts;
      const [tick] = intervals;

      first.fn();
      await sleep(400);
      tick.fn();
      await vi.waitFor(() => expect(logLines(CLI_UPDATES_LOG).some(l => / codex skipped/.test(l))).toBe(true), { timeout: 20_000, interval: 100 });
      await sleep(300);

      expect(recorded().filter(c => c[0] === 'claude-start')).toHaveLength(1);
      expect(fs.existsSync(codexRan)).toBe(false);
      const one = logLines(CLI_UPDATES_LOG);
      expect(one.filter(l => / claude updated 1\.0\.0 to 1\.0\.1: /.test(l))).toHaveLength(1);
      expect(one.filter(l => / codex skipped: installed through .*no update path for it has been measured/.test(l))).toHaveLength(1);
      expect(one.filter(l => / amp skipped: not installed: amp not found$/.test(l))).toHaveLength(1);

      Object.assign(process.env, { SLOW_MS: '0', FAKE_CLAUDE_MODE: 'current' });
      tick.fn();
      await vi.waitFor(() => expect(logLines(CLI_UPDATES_LOG).some(l => / claude unchanged 1\.0\.1: Claude Code is up to date/.test(l))).toBe(true), { timeout: 20_000, interval: 100 });
      await sleep(300);
      expect(recorded().filter(c => c[0] === 'claude-start')).toHaveLength(2);
      expect(logLines(CLI_UPDATES_LOG).filter(l => / codex /.test(l))).toHaveLength(1);
    } finally {
      for (const k of keys) delete process.env[k];
      process.env.PATH = savedPath;
      fs.rmSync(path.join(home, '.local'), { recursive: true, force: true });
    }
  }, 60_000);

  it('Q3 runs one CLI at a time within a pass', async () => {
    const home = path.join(root, 'home');
    nativeClaude(home);
    const amp = npmAmp(path.join(home, 'npm-global'), '0.0.1');
    await runCliUpdatePass([{ cli: 'claude', command: 'claude' }, { cli: 'amp', command: amp }], ctxFor(home, { SLOW_MS: '1200', FAKE_LATEST: '0.0.1' }));
    const c = recorded();
    const claudeEnd = c.find(x => x[0] === 'claude-end')![1] as number;
    const npmStart = c.find(x => x[0] === 'npm-start')![3] as number;
    expect(npmStart).toBeGreaterThanOrEqual(claudeEnd);
  }, 30_000);
});

describe('QA #119: what the log says', () => {
  it('Q4 logs two successive updates, one per pass', async () => {
    const home = path.join(root, 'home');
    nativeClaude(home);
    await runCliUpdatePass([{ cli: 'claude', command: 'claude' }], ctxFor(home, { FAKE_NEXT: '1.0.1' }));
    await runCliUpdatePass([{ cli: 'claude', command: 'claude' }], ctxFor(home, { FAKE_NEXT: '1.0.2' }));
    const lines = logLines(path.join(root, 'cli-updates.log'));
    expect(lines).toHaveLength(2);
    expect(lines[1]).toContain('claude updated 1.0.1 to 1.0.2');
  });

  it('Q8 reports a link that is gone after the update as a failure', async () => {
    const home = path.join(root, 'home');
    nativeClaude(home);
    const r = await updateCli('claude', 'claude', ctxFor(home, { FAKE_CLAUDE_MODE: 'unlink' }));
    expect(r.outcome).toBe('failed');
  });

  it('Q10 finds an install under a home reached through a symlink', async () => {
    const real = path.join(root, 'real-home');
    nativeClaude(real);
    const alias = path.join(root, 'alias-home');
    fs.symlinkSync(real, alias);
    const r = await updateCli('claude', 'claude', ctxFor(alias, {}, [path.join(alias, '.local', 'bin'), NODE_DIR, '/usr/bin', '/bin']));
    expect(r.outcome).toBe('updated');
  });

  it('Q11 moves a log past 256 KB to .1 and starts a new one', async () => {
    const home = path.join(root, 'home');
    nativeClaude(home);
    const log = path.join(root, 'cli-updates.log');
    fs.writeFileSync(log, 'x'.repeat(256 * 1024 + 1));
    await runCliUpdatePass([{ cli: 'claude', command: 'claude' }], ctxFor(home, { FAKE_CLAUDE_MODE: 'current' }));
    expect(fs.statSync(`${log}.1`).size).toBe(256 * 1024 + 1);
    expect(logLines(log)).toHaveLength(1);
  });
});

describe('QA #119: Amp paths the PR tests do not reach', () => {
  it('Q5 holds an update back when it cannot tell whether Amp is running (no lsof)', async () => {
    const home = path.join(root, 'home');
    const amp = npmAmp(path.join(home, 'npm-global'), '0.0.1');
    // lsof is in /usr/sbin on macOS and in /usr/bin on Linux: every folder that
    // holds one is left off, whichever machine this runs on.
    const dirs = [path.join(home, '.local', 'bin'), NODE_DIR, '/usr/bin', '/bin'].filter(dir => !fs.existsSync(path.join(dir, 'lsof')));
    expect(dirs, 'the folder that holds node was left off too: it holds an lsof').toContain(NODE_DIR);
    const r = await updateCli('amp', amp, ctxFor(home, { FAKE_LATEST: '0.0.2' }, dirs));
    expect(r.outcome).toBe('deferred');
    expect(r.detail).toContain('could not be checked');
    expect(recorded().some(c => c[0] === 'npm-start' && c[2] === 'global')).toBe(false);
  });

  it('Q6 installs nothing when the download fails', async () => {
    const home = path.join(root, 'home');
    const amp = npmAmp(path.join(home, 'npm-global'), '0.0.1');
    const r = await updateCli('amp', amp, ctxFor(home, { FAKE_LATEST: '0.0.2', FAKE_NPM_MODE: 'download-fails' }));
    expect(r.outcome).toBe('failed');
    expect(r.detail).toContain('downloading @sourcegraph/amp@0.0.2');
    expect(recorded().some(c => c[0] === 'npm-start' && c[2] === 'global')).toBe(false);
  });

  it('Q7 does not call an install that left the old version in place an update', async () => {
    const home = path.join(root, 'home');
    const amp = npmAmp(path.join(home, 'npm-global'), '0.0.1');
    const r = await updateCli('amp', amp, ctxFor(home, { FAKE_LATEST: '0.0.2', FAKE_NPM_MODE: 'no-change' }));
    expect(r.outcome).toBe('failed');
  }, 60_000);

  it('Q9 takes a minor release as newer', async () => {
    const home = path.join(root, 'home');
    const amp = npmAmp(path.join(home, 'npm-global'), '0.0.5');
    const r = await updateCli('amp', amp, ctxFor(home, { FAKE_LATEST: '0.1.0' }));
    expect(r).toMatchObject({ outcome: 'updated', from: '0.0.5', to: '0.1.0' });
  }, 60_000);
});
