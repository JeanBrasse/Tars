import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

/**
 * Every launch from a window, and the two the main process makes on its own,
 * run on the agent's model and effort, and a change to either applies by
 * itself, at a moment that cuts nothing.
 *
 * What happened on 2026-09-22 with 1.7.9: Noah moved every agent to Opus 5.5
 * in the Agents page. The CLIs went on running the old model, and the ones he
 * relaunched from the Dashboard came back on the model their previous session
 * had answered on: Opus 5 for four Tars agents and five Parallel ones, Opus
 * 4.8 for the Audit Engineer, read from a transcript a month old. Their argv
 * said so, process by process. Then every one of them sat in `running` with no
 * task in front of an idle prompt.
 *
 * The handlers here are the real ones (registered with registerIpcHandlers),
 * as are initAgentPty, spawnAgentPty, the draft guard and the restart; only
 * node-pty is replaced, by a terminal that records what is typed into it and
 * whose foreground can be set the way node-pty reports it (`bash` at a shell,
 * the version number while claude runs).
 */

const { tmpHome } = vi.hoisted(() => ({
  tmpHome: `${process.env.TMPDIR?.replace(/\/$/, '') || '/tmp'}/tars-launch-settings-${process.pid}-${Date.now()}`,
}));

type FakePty = {
  pid: number;
  process: string;
  write: ReturnType<typeof vi.fn>;
  kill: ReturnType<typeof vi.fn>;
  resize: ReturnType<typeof vi.fn>;
  onData: ReturnType<typeof vi.fn>;
  onExit: ReturnType<typeof vi.fn>;
};

const spawned = vi.hoisted(() => [] as FakePty[]);

vi.mock('os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('os')>();
  return { ...actual, homedir: () => tmpHome, default: { ...actual, homedir: () => tmpHome } };
});
vi.mock('node-pty', () => ({
  spawn: vi.fn((file: string): FakePty => {
    const terminal: FakePty = {
      pid: 4242 + spawned.length,
      process: file,
      write: vi.fn(),
      kill: vi.fn(),
      resize: vi.fn(),
      onData: vi.fn(),
      onExit: vi.fn(),
    };
    spawned.push(terminal);
    return terminal;
  }),
}));
vi.mock('electron-updater', () => ({
  autoUpdater: {
    autoDownload: false, autoInstallOnAppQuit: true,
    on: vi.fn(), checkForUpdates: vi.fn(), downloadUpdate: vi.fn(), quitAndInstall: vi.fn(),
  },
}));
vi.mock('electron', () => ({
  app: {
    getPath: () => tmpHome, getAppPath: () => process.cwd(), isPackaged: false,
    getVersion: () => '1.7.9', getName: () => 'Tars', on: vi.fn(), whenReady: vi.fn(),
  },
  BrowserWindow: Object.assign(vi.fn(), { getAllWindows: () => [] }),
  Notification: vi.fn(),
  ipcMain: { handle: (channel: string, handler: unknown) => { handlers.set(channel, handler as Handler); } },
  protocol: { handle: vi.fn(), registerSchemesAsPrivileged: vi.fn() },
  shell: { openExternal: vi.fn() },
  dialog: { showOpenDialog: vi.fn() },
}));
vi.mock('../../../electron/utils/broadcast', () => ({
  broadcastToAllWindows: (channel: string, payload: unknown) => {
    broadcasts.push({ channel, payload: JSON.parse(JSON.stringify(payload ?? null)) });
  },
}));

type Handler = (event: unknown, ...args: unknown[]) => Promise<unknown>;
const handlers = new Map<string, Handler>();
const broadcasts: Array<{ channel: string; payload: unknown }> = [];

import { registerIpcHandlers, type IpcHandlerDependencies } from '../../../electron/handlers/ipc-handlers';
import { agents, initAgentPty } from '../../../electron/core/agent-manager';
import { ptyProcesses, writeHumanInput, resetTerminalInput } from '../../../electron/core/pty-manager';
import { spawnAgentPty } from '../../../electron/core/agent-pty';
import { resetResumeTracking, encodeProjectDirName } from '../../../electron/utils/resume-session';
import { resetAgentRestarts } from '../../../electron/core/agent-restart';
import { resetLaunches } from '../../../electron/core/agent-launch';
import { emitAgentStatus } from '../../../electron/services/agent-events';
import { startAgentForTask } from '../../../electron/services/kanban-automation';
import { resetAgentWatch, queueBusMessage, deliverBusMessages, startAgentWatch, stopAgentWatch, holdsFor } from '../../../electron/services/agent-watch';
import { registerHooksRoutes } from '../../../electron/services/api-routes/hooks-routes';
import type { RouteApp, RouteContext, RouteRequest } from '../../../electron/services/api-routes/types';
import type { AgentStatus, AppSettings } from '../../../electron/types';

const project = path.join(tmpHome, 'project');
const OLD_SESSION = '4ab31f00-ce51-4676-ab80-4023cf6e3f4e';

function deps(): IpcHandlerDependencies {
  const fixed: Record<string, unknown> = {
    agents,
    ptyProcesses,
    saveAgents: vi.fn(),
    getAppSettings: () => ({} as AppSettings),
    // The real one: a restart opens a new terminal, through the one function
    // that spawns an agent's pty.
    initAgentPty: (agent: AgentStatus) => initAgentPty(agent, null, vi.fn(), vi.fn()),
  };
  return new Proxy(fixed, {
    get(target, key: string) {
      if (key in target) return target[key];
      target[key] = key.endsWith('ptyProcesses') ? new Map() : vi.fn();
      return target[key];
    },
  }) as unknown as IpcHandlerDependencies;
}

/** The transcript of the agent's last session, which answered on `model`. */
function lastSessionAnsweredOn(model: string): void {
  const dir = path.join(tmpHome, '.claude', 'projects', encodeProjectDirName(project));
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${OLD_SESSION}.jsonl`), [
    JSON.stringify({ type: 'user', message: { content: 'hello' } }),
    JSON.stringify({ type: 'assistant', message: { model, content: [{ type: 'text', text: 'hi' }] } }),
  ].join('\n') + '\n');
}

/** An agent whose terminal is open, spawned the way every agent terminal is. */
function agentWithTerminal(opts: Partial<AgentStatus> & { foreground: string }): { agent: AgentStatus; terminal: FakePty } {
  const { foreground, ...fields } = opts;
  const terminal = spawnAgentPty({
    binaryName: 'claude', shell: '/bin/bash', args: ['-l'], cwd: project, cols: 120, rows: 30,
    env: { CLAUDE_AGENT_ID: 'agent-a' },
  }) as unknown as FakePty;
  terminal.process = foreground;
  ptyProcesses.set('pty-a', terminal as never);
  const agent = {
    id: 'agent-a', name: 'Planner', status: 'idle', provider: 'claude', projectPath: project,
    skills: [], output: [], lastActivity: new Date().toISOString(),
    ptyId: 'pty-a', ptyCwd: project, permissionMode: 'bypass',
    model: 'claude-opus-5-5', effort: 'max',
    ...fields,
  } as AgentStatus;
  agents.set(agent.id, agent);
  return { agent, terminal };
}

/** An agent with no terminal at all, as every agent is after the app starts. */
function agentAtRest(fields: Partial<AgentStatus> = {}): AgentStatus {
  const agent = {
    id: 'agent-a', name: 'Planner', status: 'idle', provider: 'claude', projectPath: project,
    skills: [], output: [], lastActivity: new Date().toISOString(),
    permissionMode: 'bypass', model: 'claude-opus-5-5', effort: 'max',
    ...fields,
  } as AgentStatus;
  agents.set(agent.id, agent);
  return agent;
}

const start = (id: string, prompt = '', options: Record<string, unknown> = { resume: true }) =>
  handlers.get('agent:start')!({}, { id, prompt, options }) as Promise<{ success: boolean; error?: string }>;
const update = (params: Record<string, unknown>) =>
  handlers.get('agent:update')!({}, params) as Promise<{ success: boolean }>;

/**
 * A launch, with the clock run past the half second a fresh terminal is given
 * before anything is typed into it: awaited first, it would wait on a timer
 * that never fires.
 */
async function settled<T>(launch: Promise<T>, ms = 600): Promise<T> {
  const outcome = launch.then(value => ({ value }), (error: unknown) => ({ error }));
  await vi.advanceTimersByTimeAsync(ms);
  const done = await outcome;
  if ('error' in done) throw done.error;
  return done.value;
}

/** POST /api/hooks/status, as a hook script sends it, through the real route. */
function hookStatus(body: Record<string, unknown>): Record<string, unknown> {
  const app: RouteApp = {
    routes: [],
    add(method, pattern, handler) { this.routes.push({ method, pattern, handler }); },
    get(pattern, handler) { this.add('GET', pattern, handler); },
    post(pattern, handler) { this.add('POST', pattern, handler); },
    put(pattern, handler) { this.add('PUT', pattern, handler); },
    delete(pattern, handler) { this.add('DELETE', pattern, handler); },
  };
  registerHooksRoutes(app, {
    getAppSettings: () => ({} as AppSettings),
    handleStatusChangeNotificationCallback: vi.fn(),
    sendNotificationCallback: vi.fn(),
  } as unknown as RouteContext);
  const route = app.routes.find(r => r.method === 'POST' && String(r.pattern) === '/api/hooks/status')!;
  let answer: Record<string, unknown> = {};
  void route.handler({ body, params: {} } as unknown as RouteRequest, (json) => { answer = json as Record<string, unknown>; });
  return answer;
}

/** Everything typed into a terminal, as one string. */
const typedInto = (terminal: FakePty) => terminal.write.mock.calls.map(call => String(call[0])).join('');

/** The terminal opened for the agent after `before` terminals existed. */
const newTerminal = (before: number) => spawned[before];

beforeEach(() => {
  vi.useFakeTimers();
  fs.rmSync(tmpHome, { recursive: true, force: true });
  fs.mkdirSync(project, { recursive: true });
  handlers.clear();
  broadcasts.length = 0;
  spawned.length = 0;
  agents.clear();
  ptyProcesses.clear();
  resetResumeTracking();
  resetAgentRestarts();
  resetAgentWatch();
  resetLaunches();
  registerIpcHandlers(deps());
});

afterEach(async () => {
  await vi.runAllTimersAsync();
  for (const terminal of spawned) resetTerminalInput(terminal as never);
  resetAgentRestarts();
  vi.useRealTimers();
});

describe('a start from the Dashboard', () => {
  it("runs on the agent's model, not on the one its last session answered on", async () => {
    // The Tars Orchestrator on 2026-09-22: record claude-opus-5-5, last
    // session on claude-opus-5, relaunched with `--model claude-opus-5`.
    lastSessionAnsweredOn('claude-opus-5');
    agentAtRest({ resumableSessionId: OLD_SESSION });

    const result = await settled(start('agent-a'));

    expect(result).toMatchObject({ success: true });
    const typed = typedInto(newTerminal(0));
    expect(typed).toContain(" --model 'claude-opus-5-5'");
    expect(typed).not.toContain("--model 'claude-opus-5'");
    expect(typed).toContain(' --effort max');
    // The first start of the run still picks the conversation back up, on the
    // agent's model: continued under its own id, as before this change.
    expect(typed).toContain(`--resume '${OLD_SESSION}'`);
    expect(typed).not.toContain('--fork-session');
  });

  it.each(['low', 'medium', 'high', 'xhigh', 'max'] as const)('passes effort %s as it is set', async (effort) => {
    agentAtRest({ effort });

    await settled(start('agent-a'));

    expect(typedInto(newTerminal(0))).toContain(` --effort ${effort} `);
  });

  it('passes no effort for an agent that has none, and no model for Default', async () => {
    agentAtRest({ effort: undefined, model: 'default' });

    await settled(start('agent-a'));

    const typed = typedInto(newTerminal(0));
    expect(typed).not.toContain('--effort');
    expect(typed).not.toContain('--model');
  });

  it('still lets a start name its own model', async () => {
    agentAtRest();

    await settled(start('agent-a', 'the task', { model: 'claude-sonnet-5' }));

    expect(typedInto(newTerminal(0))).toContain(" --model 'claude-sonnet-5'");
  });

  it('leaves an agent started without a task ready, not working', async () => {
    const agent = agentAtRest({ currentTask: 'what it did yesterday' });

    await settled(start('agent-a'));

    expect(agent.status).toBe('idle');
    expect(agent.currentTask).toBeUndefined();
    const said = broadcasts.filter(b => b.channel === 'agent:status').map(b => (b.payload as { status: string }).status);
    expect(said).toEqual(['idle']);
  });

  it('marks an agent started with a task as working, as before', async () => {
    const agent = agentAtRest();

    await settled(start('agent-a', 'Rebase onto main'));

    expect(agent.status).toBe('running');
    expect(agent.currentTask).toBe('Rebase onto main');
  });

  it('takes no session to resume from a window', async () => {
    // A session id lands on a command line: a window cannot name one.
    lastSessionAnsweredOn('claude-opus-5');
    agentAtRest();

    await settled(start('agent-a', '', { resumeSessionId: `${OLD_SESSION}'; touch /tmp/owned; '`, permissionMode: 'normal' }));

    const typed = typedInto(newTerminal(0));
    expect(typed).not.toContain('--resume');
    expect(typed).not.toContain('owned');
    expect(typed).toContain('--dangerously-skip-permissions');
  });
});

describe('a task started by the Kanban automation', () => {
  it("runs through the same launch, on the agent's model and effort, unattended", async () => {
    // It typed a bare `claude --dangerously-skip-permissions`: no model, no
    // effort, no MCP configuration.
    agentAtRest({ permissionMode: 'normal', effort: 'xhigh' });

    await settled(startAgentForTask('agent-a', '# Task: fix the flaky test'));

    const typed = typedInto(newTerminal(0));
    expect(typed).toContain(" --model 'claude-opus-5-5'");
    expect(typed).toContain(' --effort xhigh');
    expect(typed).toContain('--dangerously-skip-permissions');
    expect(typed).toContain("-- '# Task: fix the flaky test'");
    expect(agents.get('agent-a')!.status).toBe('running');
  });

  it('fails the task, as a failed start always did, when a CLI already runs in the terminal', async () => {
    agentWithTerminal({ foreground: '2.1.280' });

    await expect(settled(startAgentForTask('agent-a', '# Task: anything'))).rejects.toThrow(/still running a CLI/);
  });
});

describe('a changed model or effort', () => {
  it('restarts an agent between turns at once, on its conversation, under a new session id', async () => {
    lastSessionAnsweredOn('claude-opus-5');
    const { agent, terminal } = agentWithTerminal({
      foreground: '2.1.280', model: 'claude-opus-5', effort: 'high',
      currentSessionId: OLD_SESSION, resumableSessionId: OLD_SESSION, sessionPtyId: 'pty-a',
    });
    const before = spawned.length;

    await update({ id: agent.id, model: 'claude-opus-5-5', effort: 'max' });
    await vi.advanceTimersByTimeAsync(600);

    expect(terminal.kill).toHaveBeenCalled();
    const restarted = newTerminal(before);
    expect(restarted, 'no new terminal was opened').toBeDefined();
    const typed = typedInto(restarted);
    expect(typed).toContain(`--resume '${OLD_SESSION}' --fork-session`);
    expect(typed).toContain(" --model 'claude-opus-5-5'");
    expect(typed).toContain(' --effort max');
    // No task: nothing after `--`.
    expect(typed).not.toMatch(/ -- '/);
    // The session rule: the killed session is the tombstone, and the one that
    // registers next is a new id, so its posts are its own.
    expect(agent.lastKilledSessionId).toBe(OLD_SESSION);
    expect(agent.currentSessionId).toBeUndefined();
    expect(agent.ptyId).not.toBe('pty-a');
    expect(agent.status).toBe('idle');
  });

  it('keeps the conversation through two restarts with no turn between them', async () => {
    // A fork writes its transcript at its first turn. Measured in the app on
    // 2026-09-23: a second restart found no file for the fork it was
    // replacing and came up on a fresh session, the conversation gone.
    lastSessionAnsweredOn('claude-opus-5');
    const { agent } = agentWithTerminal({
      foreground: '2.1.280', model: 'claude-opus-5', effort: 'high',
      currentSessionId: OLD_SESSION, resumableSessionId: OLD_SESSION, sessionPtyId: 'pty-a',
    });
    const before = spawned.length;

    await update({ id: agent.id, model: 'claude-opus-5-5' });
    await vi.advanceTimersByTimeAsync(600);
    const first = newTerminal(before);
    expect(typedInto(first)).toContain(`--resume '${OLD_SESSION}' --fork-session`);

    // The fork registers, with an id of its own and no transcript yet.
    const FORK = '3b0f2a6f-15ee-487d-9e1a-728c0c122f53';
    agent.currentSessionId = FORK;
    agent.resumableSessionId = FORK;
    first.process = '2.1.280';

    await update({ id: agent.id, effort: 'max' });
    await vi.advanceTimersByTimeAsync(600);

    const second = newTerminal(before + 1);
    expect(second, 'the second change restarted nothing').toBeDefined();
    expect(typedInto(second)).toContain(`--resume '${OLD_SESSION}' --fork-session`);
    expect(typedInto(second)).toContain(' --effort max');
  });

  it('hands the agent to the restarted session, and refuses the one it replaced', async () => {
    lastSessionAnsweredOn('claude-opus-5');
    const { agent } = agentWithTerminal({
      foreground: '2.1.280', model: 'claude-opus-5',
      currentSessionId: OLD_SESSION, resumableSessionId: OLD_SESSION, sessionPtyId: 'pty-a',
    });
    await update({ id: agent.id, model: 'claude-opus-5-5' });
    await vi.advanceTimersByTimeAsync(600);

    // The negative control, and the reason for --fork-session: continued under
    // its own id, the restarted session is the tombstone, and even its
    // registration is refused.
    expect(hookStatus({ agent_id: agent.id, session_id: OLD_SESSION, status: 'idle', source: 'resume' }))
      .toMatchObject({ stale: true });
    expect(agent.currentSessionId).toBeUndefined();

    // Forked, it has an id of its own: it registers, and its posts count.
    const FORKED = '61200c3f-6bbe-44d5-b76e-016196479491';
    expect(hookStatus({ agent_id: agent.id, session_id: FORKED, status: 'idle', source: 'resume' }))
      .toMatchObject({ registered: true });
    expect(agent.currentSessionId).toBe(FORKED);
    expect(hookStatus({ agent_id: agent.id, session_id: FORKED, status: 'running', event: 'UserPromptSubmit' }))
      .toMatchObject({ success: true });
    expect(agent.status).toBe('running');

    // And the killed session's own hooks, still in flight, change nothing.
    expect(hookStatus({ agent_id: agent.id, session_id: OLD_SESSION, status: 'completed' }))
      .toMatchObject({ stale: true });
    expect(agent.status).toBe('running');
  });

  it('waits for a turn in progress to end, and restarts when it does', async () => {
    const { agent, terminal } = agentWithTerminal({ foreground: '2.1.280', status: 'running', model: 'claude-opus-5' });
    const before = spawned.length;

    await update({ id: agent.id, model: 'claude-opus-5-5' });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(terminal.kill).not.toHaveBeenCalled();
    expect(spawned.length).toBe(before);

    // The Stop hook: the turn is over.
    agent.status = 'idle';
    emitAgentStatus(agent.id);
    await vi.advanceTimersByTimeAsync(1_000);

    expect(terminal.kill).toHaveBeenCalled();
    expect(typedInto(newTerminal(before))).toContain(" --model 'claude-opus-5-5'");
  });

  it('waits while the agent asks a permission question', async () => {
    const { agent, terminal } = agentWithTerminal({
      foreground: '2.1.280', status: 'waiting', waitingReason: 'permission', model: 'claude-opus-5',
    });

    await update({ id: agent.id, model: 'claude-opus-5-5' });
    await vi.advanceTimersByTimeAsync(30_000);

    expect(terminal.kill).not.toHaveBeenCalled();
  });

  it('never throws away a draft: it waits for the field to be empty and left alone', async () => {
    const { agent, terminal } = agentWithTerminal({ foreground: '2.1.280', model: 'claude-opus-5' });
    writeHumanInput(terminal as never, 'je pense quil faut');
    const before = spawned.length;

    await update({ id: agent.id, model: 'claude-opus-5-5' });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(terminal.kill, 'the terminal was killed with a draft in it').not.toHaveBeenCalled();

    // Noah deletes what he typed, character by character.
    for (let i = 0; i < 'je pense quil faut'.length; i++) writeHumanInput(terminal as never, '\x7f');
    await vi.advanceTimersByTimeAsync(4_000);
    expect(terminal.kill, 'restarted less than five seconds after the last key').not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(2_000);

    expect(terminal.kill).toHaveBeenCalled();
    expect(typedInto(newTerminal(before))).toContain(" --model 'claude-opus-5-5'");
  });

  it('waits for a message owed to the agent to be typed in first', async () => {
    startAgentWatch();
    try {
      const { agent, terminal } = agentWithTerminal({
        foreground: '2.1.280', model: 'claude-opus-5', currentSessionId: OLD_SESSION,
      });
      // A room message held for the agent and not handed over yet. It is bound
      // to this session: a restart first would drop it for good.
      expect(queueBusMessage(agent.id, {
        messageId: 'm1', roomId: 'project:/p', threadId: 't1',
        authorKind: 'agent', authorName: 'QA', text: 'the gate is green',
      })).toBe(true);

      await update({ id: agent.id, model: 'claude-opus-5-5' });
      await vi.advanceTimersByTimeAsync(10_000);
      expect(terminal.kill, 'restarted over a message owed to the session').not.toHaveBeenCalled();

      // Handed over: it goes into the session it was owed to.
      deliverBusMessages(agent.id);
      await vi.advanceTimersByTimeAsync(1_000);
      expect(typedInto(terminal)).toContain('the gate is green');
      expect(terminal.kill, 'restarted over the turn the message has just started').not.toHaveBeenCalled();

      // Its turn ran and ended; now the restart goes ahead.
      agent.status = 'running';
      emitAgentStatus(agent.id);
      agent.status = 'idle';
      emitAgentStatus(agent.id);
      await vi.advanceTimersByTimeAsync(4_000);
      expect(terminal.kill).toHaveBeenCalled();
    } finally {
      stopAgentWatch();
    }
  });

  it('applies a second change saved while the CLI restarts, once it is up', async () => {
    const { agent } = agentWithTerminal({ foreground: '2.1.280', model: 'claude-opus-5', effort: 'high' });
    const before = spawned.length;

    await update({ id: agent.id, model: 'claude-opus-5-5' });
    await vi.advanceTimersByTimeAsync(600);
    const first = newTerminal(before);
    expect(typedInto(first)).toContain(' --effort high');

    // Saved again while the new terminal still runs its shell.
    await update({ id: agent.id, effort: 'max' });
    await vi.advanceTimersByTimeAsync(2_000);
    expect(first.kill, 'the second change was restarted into a CLI that was not up yet').not.toHaveBeenCalled();

    // The CLI is up: the second change restarts it.
    first.process = '2.1.280';
    await vi.advanceTimersByTimeAsync(2_000);
    expect(first.kill).toHaveBeenCalled();
    const second = newTerminal(before + 1);
    expect(typedInto(second)).toContain(" --model 'claude-opus-5-5'");
    expect(typedInto(second)).toContain(' --effort max');
  });

  it('drops a waiting restart once the agent was launched again on the new values', async () => {
    // Noah, impatient, stops and starts the agent himself while its restart
    // waits for the turn to end. The start already reads the new model.
    const { agent, terminal } = agentWithTerminal({ foreground: '2.1.280', status: 'running', model: 'claude-opus-5' });
    await update({ id: agent.id, model: 'claude-opus-5-5' });
    await vi.advanceTimersByTimeAsync(1_000);
    expect(terminal.kill).not.toHaveBeenCalled();

    await handlers.get('agent:stop')!({}, agent.id);
    await settled(start(agent.id));
    const relaunched = spawned[spawned.length - 1];
    expect(typedInto(relaunched)).toContain(" --model 'claude-opus-5-5'");
    relaunched.process = '2.1.280';
    const count = spawned.length;

    // Later, the agent is free: the restart has nothing left to apply.
    emitAgentStatus(agent.id);
    await vi.advanceTimersByTimeAsync(10_000);

    expect(relaunched.kill, 'restarted a CLI already on the new model').not.toHaveBeenCalled();
    expect(spawned.length).toBe(count);
  });

  it('waits for work the session left running in the background, and restarts once it reported back', async () => {
    // Measured on 2.1.280: asked to sleep 25, the CLI ran it in the background
    // and ended its turn ten seconds in. Tars saw `idle` and, without this,
    // killed the CLI with the sleep, and the turn waiting on it.
    const registered = Date.now() - 60_000;
    const { agent, terminal } = agentWithTerminal({
      foreground: '2.1.280', model: 'claude-opus-5', currentSessionId: OLD_SESSION,
      sessionRegisteredAt: new Date(registered).toISOString(),
    });
    const dir = path.join(tmpHome, '.claude', 'projects', encodeProjectDirName(project));
    fs.mkdirSync(dir, { recursive: true });
    const transcript = path.join(dir, `${OLD_SESSION}.jsonl`);
    const at = (ms: number) => new Date(registered + ms).toISOString();
    fs.writeFileSync(transcript, [
      JSON.stringify({ type: 'assistant', timestamp: at(5_000), message: { content: [{ type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'sleep 25', run_in_background: true } }] } }),
      JSON.stringify({ type: 'user', timestamp: at(6_000), toolUseResult: { backgroundTaskId: 'bgncs8rbv' }, message: { content: [{ type: 'tool_result', tool_use_id: 't1', content: 'Command running in background with ID: bgncs8rbv.' }] } }),
    ].join('\n') + '\n');

    await update({ id: agent.id, model: 'claude-opus-5-5' });
    await vi.advanceTimersByTimeAsync(10_000);
    expect(terminal.kill, 'killed the CLI with its background work still running').not.toHaveBeenCalled();

    // The work reports back, which is a turn of its own: then the turn ends.
    fs.appendFileSync(transcript, JSON.stringify({ type: 'user', timestamp: at(45_000), message: { content:
      '<task-notification>\n<task-id>bgncs8rbv</task-id>\n<status>completed</status>\n</task-notification>' } }) + '\n');
    agent.status = 'running';
    emitAgentStatus(agent.id);
    agent.status = 'idle';
    emitAgentStatus(agent.id);
    await vi.advanceTimersByTimeAsync(1_000);

    expect(terminal.kill).toHaveBeenCalled();
  });

  it('restarts nothing when no CLI runs: the next launch reads the new model', async () => {
    const { agent, terminal } = agentWithTerminal({ foreground: 'bash', model: 'claude-opus-5' });
    const before = spawned.length;

    await update({ id: agent.id, model: 'claude-opus-5-5' });
    await vi.advanceTimersByTimeAsync(10_000);

    expect(terminal.kill).not.toHaveBeenCalled();
    expect(spawned.length).toBe(before);
    expect(agent.model).toBe('claude-opus-5-5');
  });

  it('leaves a CLI that reports no turns alone until its next launch', async () => {
    const { agent, terminal } = agentWithTerminal({ foreground: 'codex', provider: 'codex', model: 'gpt-5.2-codex' });

    await update({ id: agent.id, model: 'gpt-5.3-codex' });
    await vi.advanceTimersByTimeAsync(10_000);

    expect(terminal.kill).not.toHaveBeenCalled();
  });

  it('restarts for nothing when the edit changed nothing the CLI reads at launch', async () => {
    const { agent, terminal } = agentWithTerminal({ foreground: '2.1.280' });

    await update({ id: agent.id, name: 'Planner', character: 'wizard', skills: ['x'] });
    await vi.advanceTimersByTimeAsync(10_000);

    expect(terminal.kill).not.toHaveBeenCalled();
  });

  it('restarts on a changed permission mode, and launches on the new one', async () => {
    // Noah's own sequence on 2026-09-22: the model, the effort and the bypass
    // level edited together. The app applied all three; no test said so for
    // the third.
    const { agent, terminal } = agentWithTerminal({ foreground: '2.1.280', permissionMode: 'bypass' });
    const before = spawned.length;

    await update({ id: agent.id, permissionMode: 'auto' });
    await vi.advanceTimersByTimeAsync(600);

    expect(terminal.kill).toHaveBeenCalled();
    const typed = typedInto(newTerminal(before));
    expect(typed).toContain(' --permission-mode auto');
    expect(typed).not.toContain('--dangerously-skip-permissions');
  });

  it('puts the agent in error, with the reason, when the restart cannot launch it', async () => {
    const { agent } = agentWithTerminal({ foreground: '2.1.280', model: 'claude-opus-5' });
    const pty = await import('node-pty');
    vi.mocked(pty.spawn).mockImplementationOnce(() => { throw new Error('posix_spawnp failed.'); });

    await update({ id: agent.id, model: 'claude-opus-5-5' });
    await vi.advanceTimersByTimeAsync(600);

    expect(agent.status).toBe('error');
    expect(agent.error).toContain('the restart failed');
    expect(agent.error).toContain('posix_spawnp failed.');
    expect(broadcasts.some(b => b.channel === 'agent:status' && (b.payload as { status?: string }).status === 'error')).toBe(true);
  });

  it('takes the terminal it killed out of the ones the app knows', async () => {
    const { agent, terminal } = agentWithTerminal({ foreground: '2.1.280', model: 'claude-opus-5' });

    await update({ id: agent.id, model: 'claude-opus-5-5' });
    await vi.advanceTimersByTimeAsync(600);

    expect(terminal.kill).toHaveBeenCalled();
    // Left there, it would be killed a second time at quit, and a route
    // reading the map could type into a terminal that is gone.
    expect([...ptyProcesses.values()]).not.toContain(terminal);
    expect(ptyProcesses.has('pty-a')).toBe(false);
  });

  it('waits while agent-watch is typing a message in, not only while it holds one', async () => {
    startAgentWatch();
    try {
      const { agent, terminal } = agentWithTerminal({
        foreground: '2.1.280', model: 'claude-opus-5', currentSessionId: OLD_SESSION,
      });
      expect(queueBusMessage(agent.id, {
        messageId: 'm1', roomId: 'project:/p', threadId: 't1',
        authorKind: 'agent', authorName: 'QA', text: 'the gate is green',
      })).toBe(true);
      deliverBusMessages(agent.id);
      // Typed, its carriage return not yet sent: nothing is held any more,
      // and the note is still going in.
      expect(typedInto(terminal)).toContain('the gate is green');
      expect(holdsFor(agent.id), 'a note being typed in is not owed to the agent').toBe(true);

      await update({ id: agent.id, model: 'claude-opus-5-5' });
      await vi.advanceTimersByTimeAsync(200);
      expect(terminal.kill, 'restarted while a note was being typed in').not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(400);
      expect(holdsFor(agent.id), 'still owed once the note had gone in').toBe(false);
    } finally {
      stopAgentWatch();
    }
  });

  it("adopts the restarted session's first post when its SessionStart never came", async () => {
    // The restart lets go of the session it ended. Kept as the owner, that id
    // is also the tombstone, and every post of the new session was refused as
    // stale, for good.
    lastSessionAnsweredOn('claude-opus-5');
    const { agent } = agentWithTerminal({
      foreground: '2.1.280', model: 'claude-opus-5',
      currentSessionId: OLD_SESSION, resumableSessionId: OLD_SESSION, sessionPtyId: 'pty-a',
    });
    await update({ id: agent.id, model: 'claude-opus-5-5' });
    await vi.advanceTimersByTimeAsync(600);

    const RESTARTED = 'a0e6a0a8-7d1e-4f67-9a6e-5f9d0f3b2c11';
    expect(hookStatus({ agent_id: agent.id, session_id: RESTARTED, status: 'running', event: 'UserPromptSubmit' }))
      .toMatchObject({ success: true });
    expect(agent.currentSessionId).toBe(RESTARTED);
    expect(agent.status).toBe('running');
  });

  it('restarts again when a change lands while the restarted CLI is being typed in', async () => {
    // The QA's case on #123. agent:start builds the command, gives a new shell
    // half a second, then types it: a change saved in that half second is not
    // in the command, and was noted as launched all the same.
    const { agent } = agentWithTerminal({ foreground: '2.1.280', model: 'claude-opus-5' });
    const before = spawned.length;

    await update({ id: agent.id, model: 'claude-sonnet-5' });
    await vi.advanceTimersByTimeAsync(100);
    await update({ id: agent.id, model: 'claude-opus-5-5' });
    for (let i = 0; i < 40; i++) {
      for (const terminal of spawned.slice(before)) terminal.process = '2.1.280';
      await vi.advanceTimersByTimeAsync(500);
    }

    const last = spawned[spawned.length - 1];
    expect(typedInto(last), 'the CLI was left on a model the record no longer has').toContain(" --model 'claude-opus-5-5'");
  });

  it('picks the conversation up on another vendor too, as it does on Claude', async () => {
    // The thirteen providers that point the claude binary elsewhere had no
    // resume: a changed setting started them on a new conversation.
    lastSessionAnsweredOn('qwen3-coder');
    const { agent, terminal } = agentWithTerminal({
      foreground: '2.1.280', provider: 'ollama', model: 'qwen3-coder', effort: 'high',
      currentSessionId: OLD_SESSION, resumableSessionId: OLD_SESSION, sessionPtyId: 'pty-a',
    });
    const before = spawned.length;

    await update({ id: agent.id, effort: 'max' });
    await vi.advanceTimersByTimeAsync(600);

    expect(terminal.kill).toHaveBeenCalled();
    const typed = typedInto(newTerminal(before));
    expect(typed).toContain(`--resume '${OLD_SESSION}' --fork-session`);
    expect(typed).toContain(' --effort max');
  });
});
