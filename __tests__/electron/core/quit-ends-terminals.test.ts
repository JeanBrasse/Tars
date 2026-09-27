import { describe, it, expect, vi, afterEach } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';

vi.mock('node-pty', () => ({ spawn: vi.fn() }));
vi.mock('electron', () => ({ BrowserWindow: vi.fn() }));

import { endAllTerminals, isQuitting, ptyProcesses, quickPtyProcesses } from '../../../electron/core/pty-manager';
import type { IPty } from 'node-pty';

/**
 * What a quit does to the agents' terminals (the Orchestrator's brief after
 * #231; the crash report of #231's proof).
 *
 * killAllPty sent SIGHUP to each terminal's shell and returned, inside a
 * synchronous before-quit. The shell relays the hangup to its jobs, so the
 * CLIs died, 0.7 to 1.8 s later, measured in 21 quits; but nothing made sure
 * of it, and node-pty's exit callbacks, which need the event loop, came after
 * the quit had moved on: one of them was delivered during Electron's final
 * cleanup, threw from pty.node's ThreadSafeFunction, and aborted the app.
 *
 * Here each "terminal" is a real process group, standing where node-pty's
 * shell would: a leader and a child in a group of its own, as a CLI started
 * from an interactive shell is.
 *
 * How it fails, written before the code (2026-09-28):
 * 1. A CLI that does not die on the hangup outlives the quit.
 * 2. Its own children (an MCP server) outlive it, in its group.
 * 3. The quit waits the whole grace when everything ended at once.
 * 4. It returns before the terminals' exits were delivered, so they come
 *    during Electron's teardown (the abort).
 * 5. A process that is not in a terminal's tree is signalled.
 * 6. Over-correction: a CLI that ends on the hangup is killed before it has
 *    had its time, and loses what it writes when it exits.
 */

const started: ChildProcess[] = [];
afterEach(() => {
  for (const c of started.splice(0)) { try { process.kill(-c.pid!, 'SIGKILL'); } catch { /* gone */ } try { c.kill('SIGKILL'); } catch { /* gone */ } }
  ptyProcesses.clear();
  quickPtyProcesses.clear();
});

const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };

/**
 * A terminal: a shell-like leader that relays SIGHUP to its job, and the job
 * in a group of its own with a child of its own. `stubborn` makes the job and
 * its child ignore SIGHUP and SIGTERM.
 */
function terminal(stubborn: boolean): { pty: IPty; leader: ChildProcess; job: () => number; grandchild: () => number } {
  const trap = stubborn ? "trap '' HUP TERM;" : '';
  const script = `
    set -m
    sh -c '${trap} sleep 300 & echo $! > "$0.child"; wait' "$T" &
    job=$!
    echo $job > "$T.job"
    trap 'kill -HUP $job 2>/dev/null; exit 0' HUP
    wait
  `;
  const T = `${process.env.TMPDIR || '/tmp'}/tars-quit-${process.pid}-${Math.random().toString(36).slice(2)}`;
  const leader = spawn('/bin/sh', ['-c', script], { detached: true, stdio: 'ignore', env: { ...process.env, T } });
  started.push(leader);
  const read = (f: string) => { try { return Number(require('fs').readFileSync(f, 'utf-8').trim()); } catch { return 0; } };
  const exits: Array<(e: { exitCode: number }) => void> = [];
  leader.on('exit', code => { for (const cb of exits) cb({ exitCode: code ?? 0 }); });
  const pty = {
    pid: leader.pid!,
    kill: (signal = 'SIGHUP') => { process.kill(leader.pid!, signal as NodeJS.Signals); },
    onExit: (cb: (e: { exitCode: number }) => void) => { exits.push(cb); return { dispose: () => exits.splice(exits.indexOf(cb), 1) }; },
  } as unknown as IPty;
  return { pty, leader, job: () => read(`${T}.job`), grandchild: () => read(`${T}.child`) };
}

const settle = async (t: { job: () => number; grandchild: () => number }) => {
  for (let i = 0; i < 50 && !(t.job() && t.grandchild()); i++) await new Promise(r => setTimeout(r, 20));
};

describe('the quit, for the agents\' terminals', () => {
  it('1, 2. ends a CLI that ignores the hangup, and its children, within the grace', async () => {
    const t = terminal(true);
    ptyProcesses.set('pty-1', t.pty);
    await settle(t);
    const began = Date.now();

    await endAllTerminals(1_000);

    expect(Date.now() - began).toBeLessThan(2_500);
    expect(alive(t.job()), 'the CLI outlived the quit').toBe(false);
    expect(alive(t.grandchild()), 'its child outlived the quit').toBe(false);
    expect(alive(t.leader.pid!)).toBe(false);
    expect(isQuitting()).toBe(true);
  });

  it('3, 6. returns as soon as a CLI that ends on the hangup has ended, without killing it first', async () => {
    const t = terminal(false);
    quickPtyProcesses.set('pty-2', t.pty);
    await settle(t);
    const began = Date.now();

    await endAllTerminals(5_000);

    expect(Date.now() - began, 'waited the whole grace').toBeLessThan(2_000);
    expect(alive(t.job())).toBe(false);
  });

  it('4. resolves only once every terminal\'s exit was delivered', async () => {
    const t = terminal(false);
    ptyProcesses.set('pty-3', t.pty);
    await settle(t);
    let delivered = false;
    t.pty.onExit(() => { delivered = true; });

    await endAllTerminals(3_000);

    expect(delivered).toBe(true);
  });

  it('5. signals nothing outside the terminals\' trees', async () => {
    const t = terminal(true);
    ptyProcesses.set('pty-4', t.pty);
    const bystander = spawn('/bin/sh', ['-c', 'sleep 300'], { detached: true, stdio: 'ignore' });
    started.push(bystander);
    await settle(t);

    await endAllTerminals(500);

    expect(alive(bystander.pid!)).toBe(true);
  });
});

describe('main.ts, at quit', () => {
  const main = require('fs').readFileSync(require('path').join(__dirname, '../../../electron/main.ts'), 'utf-8') as string;
  const quit = main.slice(main.indexOf("app.on('before-quit'"), main.indexOf("app.on('before-quit'") + 3000);

  it('4. holds the quit until the terminals have ended, then quits again', () => {
    expect(quit).toMatch(/preventDefault\(\)/);
    expect(quit).toMatch(/endAllTerminals\(/);
    expect(quit).toMatch(/app\.quit\(\)/);
    expect(quit).not.toMatch(/\['killAllPty', killAllPty\]/);
  });
});
