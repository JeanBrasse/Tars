import { describe, it, expect, afterEach } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import { Leftovers } from './leftover-processes';

/**
 * The witness for leftover-processes.ts, which the ACP tests end their
 * leftover processes through.
 *
 * How it can fail:
 *  1. a process the test saw, still running, is left running;
 *  2. win32: a process that holds an id only since the test saw it, which
 *     Windows handed out again once the one the test meant had exited, is
 *     ended: any process of the machine, a vitest worker included;
 *  3. an id that is not a positive integer is signalled: 0 is the caller's
 *     own process on Windows and its whole process group elsewhere, -1 every
 *     process the account may signal.
 */

const started: ChildProcess[] = [];
afterEach(() => { for (const child of started.splice(0)) child.kill(); });

function running(): Promise<ChildProcess> {
  const child = spawn(process.execPath, ['-e', "console.log('ready'); setInterval(() => {}, 1000)"], { stdio: ['ignore', 'pipe', 'ignore'] });
  started.push(child);
  return new Promise((resolve, reject) => {
    child.stdout!.once('data', () => resolve(child));
    child.once('error', reject);
  });
}

const exited = (child: ChildProcess) => new Promise<boolean>(resolve => {
  if (child.exitCode !== null || child.signalCode !== null) return resolve(true);
  const timer = setTimeout(() => resolve(false), 5_000);
  child.once('exit', () => { clearTimeout(timer); resolve(true); });
});

describe('the leftovers a test ends', { timeout: 60_000 }, () => {
  it('ends a process it saw that still runs (1)', async () => {
    const child = await running();
    const leftovers = new Leftovers();
    leftovers.push(child.pid!);

    leftovers.end();

    expect(await exited(child)).toBe(true);
  });

  it.runIf(process.platform === 'win32')('leaves a process created after its id was seen, which is not the one seen (2)', async () => {
    const child = await running();
    // Seen a minute before this process existed: the id was another's then.
    const leftovers = new Leftovers(() => Date.now() - 60_000);
    leftovers.push(child.pid!);

    leftovers.end();

    expect(await exited(child)).toBe(false);
  });

  it('never keeps an id that is not a positive integer (3)', () => {
    const leftovers = new Leftovers();
    expect(leftovers.push(0, -1, Number.NaN, 1.5, Number(''))).toBe(0);
    // Were 0 kept, this would end this very worker on Windows, and the file
    // would report nothing.
    leftovers.end();
  });
});
