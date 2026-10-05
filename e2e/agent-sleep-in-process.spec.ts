import { test, expect, _electron as electron } from '@playwright/test';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execFileSync } from 'child_process';
import { launchSandboxed, recordValues } from './fixture.mjs';
import { DEV_URL, apiPort } from './ports.mjs';

/**
 * What the sleep pass does to an agent at rest that is waiting on work its own CLI holds in-process, with nothing
 * under it in the process table (QA's gate of #322: its probe, red on #322 as first pushed, kept here as written).
 * The Stop hook's `session_crons` and `background_tasks`, which on-stop.sh counts for Tars, decide.
 *
 * - worker: at rest, nothing pending (the control: it sleeps);
 * - looper: its last turn set a ScheduleWakeup of 3600 s (/loop); Claude Code 2.1.289 hands the Stop hook
 *   `session_crons` for it, and holds no caffeinate while it waits (its presence status is idle);
 * - delegator: its last turn started a background Agent (`isAsync`, no completion note), and the Stop hook got
 *   `background_tasks`; no caffeinate under it, as on Linux, where Claude Code starts none;
 * - delegator-mac: the same, with the caffeinate Claude Code holds on macOS while a background agent runs
 *   (its presence status is busy while `delegatedActive`).
 */

type Agent = { id: string; status: string; cliRunning?: boolean; currentSessionId?: string; asleepSince?: string };
type Api = { electronAPI: { agent: {
  start(p: { id: string; prompt: string }): Promise<unknown>;
  list(): Promise<Agent[]>;
} } };

const HOOKS = path.resolve('hooks');

const STAND_IN = String.raw`
const fs = require('fs'), path = require('path'), crypto = require('crypto');
const { spawnSync, spawn } = require('child_process');
const id = process.env.CLAUDE_AGENT_ID;
const args = process.argv.slice(2);
const resumed = args.indexOf('--resume');
const sid = resumed === -1 ? crypto.randomUUID() : args[resumed + 1];
const dir = path.join(process.env.HOME, '.claude', 'projects', process.cwd().replace(/[/.]/g, '-'));
fs.mkdirSync(dir, { recursive: true });
const transcript = path.join(dir, sid + '.jsonl');
if (!fs.existsSync(transcript)) fs.writeFileSync(transcript, '');
const record = (file, o) => fs.appendFileSync(path.join(process.env.HOME, file), JSON.stringify({ at: new Date().toISOString(), id, ...o }) + '\n');
const dashes = args.indexOf('--');
const launchPrompt = dashes === -1 ? '' : args.slice(dashes + 1).join(' ');
record('launches.jsonl', { pid: process.pid, sid, resume: resumed === -1 ? null : args[resumed + 1], prompt: launchPrompt });
const hook = (name, payload) => spawnSync('/bin/bash', [path.join(HOOKS, name)], {
  input: JSON.stringify({ session_id: sid, cwd: process.cwd(), transcript_path: transcript, ...payload }), env: process.env, timeout: 20000,
});
const line = (o) => fs.appendFileSync(transcript, JSON.stringify(o) + '\n');
const now = () => new Date().toISOString();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function turn(prompt) {
  record('prompts.jsonl', { sid, prompt });
  hook('user-prompt-submit.sh', { hook_event_name: 'UserPromptSubmit', prompt });
  line({ type: 'user', timestamp: now(), message: { role: 'user', content: prompt } });
  const extra = { background_tasks: [], session_crons: [] };
  if (prompt.includes('GO>>') && id === 'looper') {
    line({ type: 'assistant', timestamp: now(), message: { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_wake', name: 'ScheduleWakeup', input: { delaySeconds: 3600, reason: 'the nightly CI takes an hour', prompt: '/loop watch the nightly CI' } }] } });
    line({ type: 'user', timestamp: now(), message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_wake', content: 'Wakeup scheduled in 3600s.' }] } });
    extra.session_crons = [{ id: 'loop1', schedule: '0 * * * *', recurring: false, prompt: '/loop watch the nightly CI' }];
  }
  if (prompt.includes('GO>>') && id.startsWith('delegator')) {
    line({ type: 'assistant', timestamp: now(), message: { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_agent', name: 'Agent', input: { description: 'audit the docs', prompt: 'audit the docs', run_in_background: true } }] } });
    line({ type: 'user', timestamp: now(), message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_agent', content: [{ type: 'text', text: 'Async agent launched successfully.' }] }] }, toolUseResult: { isAsync: true, status: 'async_launched', agentId: 'a1b2c3d4e5f6', description: 'audit the docs' } });
    extra.background_tasks = [{ id: 'a1b2c3d4e5f6', type: 'local_agent', status: 'running', description: 'audit the docs' }];
    // What Claude Code does on macOS while a background agent runs: caffeinate -i -t 300, renewed every 240 s.
    if (id === 'delegator-mac') spawn('caffeinate', ['-i', '-t', '300'], { stdio: 'ignore' });
  }
  line({ type: 'assistant', timestamp: now(), message: { role: 'assistant', content: [{ type: 'text', text: 'done' }] } });
  await sleep(300);
  hook('on-stop.sh', { hook_event_name: 'Stop', stop_hook_active: false, last_assistant_message: 'done', ...extra });
  record('stops.jsonl', { sid, extra });
}

process.stdin.setRawMode(true);
hook('session-start.sh', { hook_event_name: 'SessionStart', source: resumed === -1 ? 'startup' : 'resume' });
process.stdout.write('SCREEN-OF-' + id + ' session ' + sid + '\r\n> ');
let queue = Promise.resolve();
if (launchPrompt.trim()) queue = queue.then(() => turn(launchPrompt));
process.stdin.on('data', () => {});
process.stdin.resume();
`;

const lines = (file: string) => (fs.existsSync(file) ? fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);
const alive = (pid: number) => {
  try { process.kill(pid, 0); } catch { return false; }
  try { return !String(execFileSync('ps', ['-o', 'stat=', '-p', String(pid)])).trim().startsWith('Z'); } catch { return false; }
};

test('an agent waiting on its own timer or background agent is not put to sleep; one with nothing pending is', async () => {
  test.setTimeout(300_000);
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dorothy-e2e-qa-sleep-bg-'));
  const project = path.join(home, 'projects', 'demo');
  const dir = path.join(home, '.dorothy');
  const bin = path.join(home, 'bin');
  for (const d of [project, dir, bin]) fs.mkdirSync(d, { recursive: true });
  const cli = path.join(bin, 'claude');
  fs.writeFileSync(cli, `#!${process.execPath}\nconst HOOKS = ${JSON.stringify(HOOKS)};\n${STAND_IN}`, { mode: 0o755 });
  const agent = (id: string, name: string) => ({
    id, name, character: 'robot', provider: 'claude', status: 'idle', role: 'worker', permissionMode: 'normal',
    projectPath: project, skills: [], cliPath: cli, createdAt: '2026-10-05T08:00:00.000Z', lastActivity: '2026-10-05T08:00:00.000Z',
  });
  const ids = ['worker', 'looper', 'delegator', 'delegator-mac'];
  fs.writeFileSync(path.join(dir, 'agents.json'), JSON.stringify([
    agent('worker', 'Build Worker'), agent('looper', 'CI Looper'), agent('delegator', 'Delegator'), agent('delegator-mac', 'Delegator Mac'),
  ], null, 2));
  fs.writeFileSync(path.join(dir, 'projects.json'), JSON.stringify([project]));
  fs.writeFileSync(path.join(dir, 'hermes-connection.json'), JSON.stringify({ mode: 'local', localPort: 9, authMode: 'token' }));
  fs.writeFileSync(path.join(dir, 'app-settings.json'), JSON.stringify({ autoStartAgentsOnLaunch: false, ollamaBaseUrl: 'http://127.0.0.1:9' }));
  const launchesFile = path.join(home, 'launches.jsonl');
  const stopsFile = path.join(home, 'stops.jsonl');
  const port = apiPort(31466);
  const dist = path.resolve('electron', 'dist');

  const app = await launchSandboxed(electron, home, {
    env: { NODE_ENV: 'development', DOROTHY_DEV_URL: DEV_URL, DOROTHY_API_PORT: port, DOROTHY_E2E: '1' },
  });
  try {
    const page = await app.firstWindow();
    await page.goto(`${DEV_URL}/agents`, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => !!(window as unknown as Partial<Api>).electronAPI);
    const list = () => page.evaluate(() => (window as unknown as Api).electronAPI.agent.list());

    for (const id of ids) {
      await page.evaluate((p) => (window as unknown as Api).electronAPI.agent.start(p), { id, prompt: id === 'worker' ? '' : 'GO>> start' });
    }
    await expect.poll(async () => (await list()).filter((a) => a.cliRunning && a.currentSessionId).length, { timeout: 90_000 }).toBe(4);
    await expect.poll(() => lines(stopsFile).length, { timeout: 60_000, message: 'the three turns ended' }).toBe(3);
    const first = Object.fromEntries(lines(launchesFile).map((l) => [l.id, l]));
    await expect.poll(() => String(execFileSync('ps', ['-A', '-o', 'ppid=,command='])).split('\n')
      .some((l) => l.trim().startsWith(`${first['delegator-mac'].pid} `) && /caffeinate/.test(l)), { timeout: 30_000, message: 'delegator-mac holds its caffeinate' }).toBe(true);

    /** What Tars itself can read of each agent's pending work, before anything is put to sleep. */
    const known = await app.evaluate(async (_e, { dist, ids }) => {
      const req = process.mainModule!.require;
      const { agents } = req(`${dist}/core/agent-manager.js`);
      const { pendingBackgroundWork } = req(`${dist}/services/agent-truth.js`);
      return Object.fromEntries(ids.map((id: string) => {
        const a = agents.get(id);
        return [id, { status: a.status, waitingReason: a.waitingReason, pendingBackgroundWork: pendingBackgroundWork(a, 0) }];
      }));
    }, { dist, ids });

    /** Every agent rested 40 minutes, then the pass that runs every minute, once. */
    const restAndCheck = () => app.evaluate(async (_e, { dist }) => {
      const req = process.mainModule!.require;
      const { agents } = req(`${dist}/core/agent-manager.js`);
      const fortyMinutesAgo = new Date(Date.now() - 40 * 60_000).toISOString();
      for (const a of agents.values()) {
        a.statusSince = fortyMinutesAgo;
        a.lastTurnStartedAt = undefined;
        a.workHandedAt = undefined;
      }
      return req(`${dist}/services/agent-sleep.js`).checkSleep() as Promise<Array<{ agentId: string; slept: boolean; why?: string }>>;
    }, { dist });

    // Passes until the control sleeps (what a turn just ended leaves under a CLI is busy for a moment), then three
    // more, so that each of the others has been looked at with nothing of its last turn left under it.
    const passes: Array<Array<{ agentId: string; slept: boolean; why?: string }>> = [];
    await expect.poll(async () => {
      const outcome = await restAndCheck();
      passes.push(outcome);
      return passes.flat().some((o) => o.agentId === 'worker' && o.slept);
    }, { timeout: 30_000, intervals: [500] }).toBe(true);
    for (let i = 0; i < 3; i++) {
      await new Promise((r) => setTimeout(r, 1_000));
      passes.push(await restAndCheck());
    }
    const verdict = Object.fromEntries(ids.map((id) => {
      const seen = passes.flat().filter((o) => o.agentId === id);
      const slept = seen.some((o) => o.slept);
      return [id, { slept, lastWhy: slept ? undefined : seen.at(-1)?.why }];
    }));
    const statuses = Object.fromEntries((await list()).map((a) => [a.id, a.status]));
    await new Promise((r) => setTimeout(r, 3_000));
    const cliAlive = Object.fromEntries(ids.map((id) => [id, alive(first[id].pid)]));
    recordValues({ known, stops: lines(stopsFile), passes, verdict, statuses, cliAlive });

    expect.soft(verdict.worker.slept, 'control: an agent at rest with nothing pending sleeps').toBe(true);
    expect.soft(verdict['delegator-mac'].slept, 'macOS: the caffeinate a running background agent keeps shows it busy').toBe(false);
    expect.soft(verdict.looper.slept, 'an agent waiting on its own ScheduleWakeup is not put to sleep').toBe(false);
    expect.soft(verdict.delegator.slept, 'an agent whose background Agent is still running (no caffeinate: Linux) is not put to sleep').toBe(false);
  } finally {
    await app.close().catch(() => { /* gone */ });
  }
});
