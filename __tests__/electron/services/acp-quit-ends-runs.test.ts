import { describe, it, expect, vi, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';

/**
 * Quitting Tars ends its delegated runs, before the app exits.
 *
 * Measured on #197 (2026-09-24, claude-agent-acp 0.81.1, app.quit() in a
 * sandbox Tars): before-quit did nothing for a delegated run. A run that still
 * answered ended by itself about 2.4 s after the quit, once its stdin closed.
 * A run whose adapter was wedged (SIGSTOP) was whole 14 s later, npm, adapter,
 * claude, zsh and sleep, reparented to launchd. The stop path cannot serve at
 * quit: it reads ps asynchronously and sends its SIGKILL two seconds on, and
 * neither outlives the process.
 *
 * How it fails, written before the code (2026-09-24):
 * 1. A run is left running when the quit returns: its processes outlive Tars.
 * 2. A stuck run (the process Tars spawned SIGSTOPped, commands ignoring
 *    SIGTERM) outlives it: only a SIGKILL, sent before the quit returns, ends it.
 * 3. The commands the CLI ran in process groups of their own outlive it.
 * 4. A run that ends on SIGTERM is held for the whole grace anyway, and the
 *    quit takes longer than it has to.
 * 5. The quit is held without bound by a run that will not die.
 * 6. Over-reach: a process group that is not a run's, or Tars's own, is signalled.
 * 7. Without ps, nothing is ended, where the process Tars spawned still has to go.
 * 8. The quit never calls it.
 * 9. (the Audit's gate of #199) A ps that hangs holds the quit for every read:
 *    three reads at 2 s each stretched it to 6.5 s. One deadline bounds them all.
 * 10. (same gate) With no run under way, ps is run anyway: the shortcut that
 *    skips it had no test, and a mutant that removed it survived.
 */

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tars-acp-quit-'));
const serverBundle = path.join(tmp, 'bundle.js');
fs.writeFileSync(serverBundle, '');

/**
 * An ACP agent that, asked for a turn, starts a command in a group of its own
 * which starts another in a third group. `stubborn`: the agent and both
 * commands ignore SIGTERM, as a wedged CLI and a command that traps it would.
 */
function agentWithDetachedWork(tag: string, stubborn: boolean): { command: string; args: string[]; pidFile: string } {
  const pidFile = path.join(tmp, `${tag}.pid`);
  const file = path.join(tmp, `${tag}.mjs`);
  const ignore = stubborn ? "process.on('SIGTERM', () => {});" : '';
  // The grandchild writes its pid, then the child writes both, then the agent all three.
  const grandchild = `${ignore} require('fs').writeFileSync(process.argv[1], String(process.pid)); setInterval(() => {}, 1000);`;
  const child = `${ignore}
    const { spawn } = require('child_process');
    const fs = require('fs');
    const g = spawn(process.execPath, ['-e', ${JSON.stringify(grandchild)}, process.argv[1] + '.g'], { detached: true, stdio: 'ignore' });
    const wait = setInterval(() => {
      if (!fs.existsSync(process.argv[1] + '.g')) return;
      clearInterval(wait);
      fs.writeFileSync(process.argv[1], process.pid + ' ' + g.pid);
    }, 20);
    setInterval(() => {}, 1000);`;
  fs.writeFileSync(file, `
import { spawn, execFileSync } from 'node:child_process';
import { writeFileSync, existsSync, readFileSync } from 'node:fs';
${ignore}
let buf = '';
const send = m => process.stdout.write(JSON.stringify(m) + '\\n');
process.stdin.on('data', chunk => {
  buf += chunk;
  let nl;
  while ((nl = buf.indexOf('\\n')) !== -1) {
    const line = buf.slice(0, nl).trim();
    buf = buf.slice(nl + 1);
    if (line) handle(JSON.parse(line));
  }
});
function handle(msg) {
  if (msg.method === 'initialize') return send({ jsonrpc: '2.0', id: msg.id, result: {} });
  if (msg.method === 'session/new') return send({ jsonrpc: '2.0', id: msg.id, result: { sessionId: 's1' } });
  if (msg.method === 'session/prompt') {
    const out = ${JSON.stringify(pidFile)} + '.c';
    spawn(process.execPath, ['-e', ${JSON.stringify(child)}, out], { detached: true, stdio: 'ignore' });
    const wait = setInterval(() => {
      if (!existsSync(out)) return;
      clearInterval(wait);
      writeFileSync(${JSON.stringify(pidFile)}, process.pid + ' ' + readFileSync(out, 'utf-8'));
    }, 20);
  }
}
`);
  return { command: process.execPath, args: [file], pidFile };
}

let launch: { command: string; args: string[] };
vi.mock('../../../electron/services/acp/registry', () => ({ acpLaunchFor: () => launch, loadAcpRegistry: async () => undefined }));
vi.mock('../../../electron/services/mcp-orchestrator', () => ({ getMcpOrchestratorPath: () => serverBundle, getMcpMemoryPath: () => serverBundle }));
vi.mock('../../../electron/providers', () => ({ getProvider: () => ({ getPtyEnvVars: () => ({}) }) }));
vi.mock('../../../electron/services/usage-ledger', () => ({ recordUsage: vi.fn() }));

/** ps, as the product runs it, unless a case takes it away. */
const psBroken = { value: false };
/** ps answers nothing until the caller's own timeout ends it. */
const psHung = { value: false };
/** How many times the product ran ps, while counted. */
const psRuns = { counting: false, count: 0 };
vi.mock('child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('child_process')>();
  return {
    ...actual,
    execFile: ((file: string, ...rest: unknown[]) => {
      if (psBroken.value && file === 'ps') {
        const done = rest.find(r => typeof r === 'function') as ((err: Error, out: string, errOut: string) => void) | undefined;
        setImmediate(() => done?.(Object.assign(new Error('spawn ps ENOENT'), { code: 'ENOENT' }), '', ''));
        return {} as never;
      }
      return (actual.execFile as (...a: unknown[]) => unknown)(file, ...rest);
    }) as typeof actual.execFile,
    execFileSync: ((file: string, ...rest: unknown[]) => {
      if (psRuns.counting && file === 'ps') psRuns.count++;
      if (psBroken.value && file === 'ps') throw Object.assign(new Error('spawn ps ENOENT'), { code: 'ENOENT' });
      if (psHung.value && file === 'ps') {
        const options = rest.find(r => r && typeof r === 'object' && !Array.isArray(r)) as { timeout?: number } | undefined;
        return (actual.execFileSync as (...a: unknown[]) => unknown)('sleep', ['30'], { timeout: options?.timeout ?? 30_000 });
      }
      return (actual.execFileSync as (...a: unknown[]) => unknown)(file, ...rest);
    }) as typeof actual.execFileSync,
  };
});

import { delegateOverAcp, endAcpRunsOnQuit } from '../../../electron/services/acp/delegate';
import type { AgentStatus, AppSettings } from '../../../electron/types';

const agent = (id: string) => ({
  id, name: id, status: 'running', projectPath: tmp, provider: 'claude', skills: [], output: [], lastActivity: new Date().toISOString(),
} as AgentStatus);
/** Alive, and not a zombie: the test process is the fake agent's parent and
 *  cannot reap it while the quit holds the thread, as Tars cannot either. */
const alive = (pid: number) => {
  try { return !execFileSync('ps', ['-o', 'stat=', '-p', String(pid)]).toString().trim().startsWith('Z'); } catch { return false; }
};
const until = async (what: string, test: () => boolean, ms = 10_000) => {
  const end = Date.now() + ms;
  while (!test()) { if (Date.now() > end) throw new Error(`timed out: ${what}`); await new Promise(r => setTimeout(r, 50)); }
};

const leftovers: number[] = [];
afterEach(() => {
  psBroken.value = false;
  psHung.value = false;
  psRuns.counting = false;
  for (const pid of leftovers.splice(0)) { try { process.kill(pid, 'SIGKILL'); } catch { /* gone */ } }
});

/** Starts a delegated run of `tag`, and never awaits it: the app quits under it. */
async function runStarted(tag: string, stubborn: boolean) {
  const a = agentWithDetachedWork(tag, stubborn);
  launch = a;
  void delegateOverAcp({ agent: agent(`agent-${tag}`), task: 'work', appSettings: {} as AppSettings, timeoutMs: 60_000 });
  await until('the run started its commands', () => fs.existsSync(a.pidFile) && fs.readFileSync(a.pidFile, 'utf-8').split(' ').length === 3);
  const [adapter, command, nested] = fs.readFileSync(a.pidFile, 'utf-8').split(' ').map(Number);
  leftovers.push(adapter, command, nested);
  const groupOf = (pid: number) => Number(execFileSync('ps', ['-o', 'pgid=', '-p', String(pid)]).toString().trim());
  expect(groupOf(command)).toBe(command);
  expect(groupOf(nested)).toBe(nested);
  return { adapter, command, nested };
}

describe('quitting Tars with delegated runs under way', { timeout: 30_000 }, () => {
  it('1, 2, 3, 5. ends a stuck run, and what its CLI started, before the quit returns', async () => {
    const { adapter, command, nested } = await runStarted('stuck', true);
    process.kill(adapter, 'SIGSTOP');

    const began = Date.now();
    expect(endAcpRunsOnQuit()).toBe(1);
    const took = Date.now() - began;

    expect([adapter, command, nested].filter(alive), 'alive when the quit returned').toEqual([]);
    expect(took, 'the quit was held too long').toBeLessThan(2_500);
  });

  it('4. lets a run that ends on SIGTERM go without waiting out the grace', async () => {
    const { adapter, command, nested } = await runStarted('polite', false);

    const began = Date.now();
    endAcpRunsOnQuit();
    const took = Date.now() - began;

    expect([adapter, command, nested].filter(alive)).toEqual([]);
    expect(took).toBeLessThan(800);
  });

  it('6. leaves a process group that is not a run\'s alone', async () => {
    const outsider = spawn(process.execPath, ['-e', "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)"], { detached: true, stdio: 'ignore' });
    leftovers.push(outsider.pid!);
    await runStarted('neighbour', true);

    endAcpRunsOnQuit();

    expect(alive(outsider.pid!)).toBe(true);
    expect(alive(process.pid)).toBe(true);
  });

  it('7. still ends the process Tars spawned when ps cannot be run', async () => {
    const { adapter } = await runStarted('nops', true);
    psBroken.value = true;

    endAcpRunsOnQuit();

    expect(alive(adapter)).toBe(false);
  });

  it('10. returns at once when no run is under way, without running ps', () => {
    psRuns.counting = true;
    psRuns.count = 0;
    const began = Date.now();
    expect(endAcpRunsOnQuit()).toBe(0);
    expect(Date.now() - began).toBeLessThan(100);
    expect(psRuns.count, 'ps was run for no run').toBe(0);
  });

  it('9. holds the quit a bounded time when ps hangs, and still ends the process Tars spawned', async () => {
    const { adapter } = await runStarted('hungps', true);
    psHung.value = true;

    const began = Date.now();
    endAcpRunsOnQuit();
    const took = Date.now() - began;
    psHung.value = false;

    expect(took, 'every read waited out its own timeout').toBeLessThan(2_500);
    expect(alive(adapter)).toBe(false);
  });
});

describe('the app', () => {
  it('8. ends the delegated runs when it quits', () => {
    const main = fs.readFileSync(path.join(process.cwd(), 'electron', 'main.ts'), 'utf-8');
    const quit = main.slice(main.indexOf("app.on('before-quit'"));
    const body = quit.slice(0, quit.indexOf('\n});') + 4);

    expect(body, 'not in the before-quit steps').toMatch(/endAcpRunsOnQuit/);
  });
});
