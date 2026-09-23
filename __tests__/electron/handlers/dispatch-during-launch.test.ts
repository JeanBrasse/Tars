import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

/**
 * A message that lands while an agent's CLI is being launched waits for it.
 *
 * Measured by the Audit on 2026-09-23 (re-gate of #120 and #126): a restart
 * kills the CLI, opens a terminal, gives its shell half a second, types the
 * launch, and the CLI execs a moment later. A /dispatch in that time found no
 * CLI and started a session over the launch, without --resume: the
 * conversation was lost (WORD=NONE at +0.3 s and at +0.49 s), and at +0.49 s
 * the killed CLI's late SessionStart then took the agent from the live one.
 * Scripted senders land there: the bots, the Hermes webhook, the overseer.
 *
 * What follows is the harness of start-launch-settings.test.ts: every launch from a window, and the two the main process makes on its own,
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
import { ptyProcesses, resetTerminalInput } from '../../../electron/core/pty-manager';
import { spawnAgentPty } from '../../../electron/core/agent-pty';
import { resetResumeTracking, encodeProjectDirName } from '../../../electron/utils/resume-session';
import { resetAgentRestarts } from '../../../electron/core/agent-restart';
import { resetLaunches, CLI_BOOT_MS } from '../../../electron/core/agent-launch';
import { registerAgentRoutes } from '../../../electron/services/api-routes/agent-routes';
import { EventEmitter } from 'node:events';
import { resetAgentWatch } from '../../../electron/services/agent-watch';
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

const update = (params: Record<string, unknown>) =>
  handlers.get('agent:update')!({}, params) as Promise<{ success: boolean }>;

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


/** POST /api/agents/:id/dispatch through the real route, from another agent of the project. */
function dispatch(id: string, message: string, endpoint: 'dispatch' | 'message' = 'dispatch'): Promise<{ status: number; body: Record<string, unknown> }> {
  const app: RouteApp = {
    routes: [],
    add(method, pattern, handler) { this.routes.push({ method, pattern, handler }); },
    get(pattern, handler) { this.add('GET', pattern, handler); },
    post(pattern, handler) { this.add('POST', pattern, handler); },
    put(pattern, handler) { this.add('PUT', pattern, handler); },
    delete(pattern, handler) { this.add('DELETE', pattern, handler); },
  };
  registerAgentRoutes(app, {
    mainWindow: null, appSettings: {} as AppSettings, getAppSettings: () => ({} as AppSettings),
    getTelegramBot: () => null, getSlackApp: () => null, slackResponseChannel: null, slackResponseThreadTs: null,
    handleStatusChangeNotificationCallback: vi.fn(), sendNotificationCallback: vi.fn(),
    initAgentPtyCallback: vi.fn(async () => 'unused'), agentStatusEmitter: new EventEmitter(),
  } as unknown as RouteContext);
  const pathname = `/api/agents/${id}/${endpoint}`;
  const route = app.routes.find(r => r.method === 'POST' && typeof r.pattern !== 'string' && r.pattern.test(pathname))!;
  let answer = { status: 200, body: {} as Record<string, unknown> };
  return Promise.resolve(route.handler({
    method: 'POST', pathname, url: new URL(`http://localhost${pathname}`), body: { message },
    raw: { headers: {}, on: () => {} }, res: {}, params: { id }, callerAgentId: 'orch',
  } as unknown as RouteRequest, (json, status = 200) => { answer = { status, body: json as Record<string, unknown> }; }, {} as RouteContext))
    .then(() => answer);
}

/** The session the restarted CLI registers, a fork of the one it resumes. */
const FORK = '61200c3f-6bbe-44d5-b76e-016196479491';

/** The agent at rest, its CLI up, a conversation behind it, and an orchestrator in the project. */
function agentMidConversation() {
  lastSessionAnsweredOn('claude-opus-5-5');
  agents.set('orch', {
    id: 'orch', name: 'Orchestrator', status: 'running', provider: 'claude', projectPath: project,
    skills: [], output: [], lastActivity: new Date().toISOString(),
  } as AgentStatus);
  return agentWithTerminal({
    foreground: '2.1.280', effort: 'high',
    currentSessionId: OLD_SESSION, resumableSessionId: OLD_SESSION, sessionPtyId: 'pty-a',
  });
}

describe('a dispatch that lands while a restart launches the CLI', () => {
  it.each([
    ['after the kill, while the new shell starts', 300],
    ['just after the launch was typed, before the CLI runs', 550],
  ])('waits for the CLI and goes into the resumed session (%s)', async (_when, at) => {
    const { agent, terminal } = agentMidConversation();
    const before = spawned.length;

    await update({ id: agent.id, effort: 'max' });
    await vi.advanceTimersByTimeAsync(at);
    expect(terminal.kill, 'the restart did not begin').toHaveBeenCalled();
    const answered = dispatch(agent.id, 'WORD?');
    await vi.advanceTimersByTimeAsync(800 - at);
    // The restarted CLI takes its terminal, and its session registers.
    newTerminal(before).process = '2.1.280';
    await vi.advanceTimersByTimeAsync(500);
    expect(typedInto(newTerminal(before)), 'typed before the CLI took keys').not.toContain('WORD?');
    hookStatus({ agent_id: agent.id, session_id: FORK, status: 'idle', source: 'resume' });
    await vi.advanceTimersByTimeAsync(1_000);
    const answer = await answered;

    expect(answer.body.mode, JSON.stringify(answer.body)).toBe('message');
    expect(spawned.length, 'a session was started over the launch').toBe(before + 1);
    const restarted = newTerminal(before);
    expect(typedInto(restarted)).toContain(`--resume '${OLD_SESSION}' --fork-session`);
    expect(typedInto(restarted)).toContain('WORD?');
    expect(agent.ptyId).not.toBe('pty-a');
  });

  it('holds a /message the same way, which the MCP send_message uses', async () => {
    const { agent } = agentMidConversation();
    const before = spawned.length;

    await update({ id: agent.id, effort: 'max' });
    await vi.advanceTimersByTimeAsync(300);
    const answered = dispatch(agent.id, 'WORD?', 'message');
    await vi.advanceTimersByTimeAsync(500);
    newTerminal(before).process = '2.1.280';
    hookStatus({ agent_id: agent.id, session_id: FORK, status: 'idle', source: 'resume' });
    await vi.advanceTimersByTimeAsync(1_000);
    await answered;

    expect(spawned.length, 'a session was started over the launch').toBe(before + 1);
    expect(typedInto(newTerminal(before))).toContain('WORD?');
  });

  it('gives up on a launch whose CLI never comes up, and starts a session', async () => {
    const { agent } = agentMidConversation();
    const before = spawned.length;

    await update({ id: agent.id, effort: 'max' });
    await vi.advanceTimersByTimeAsync(300);
    const answered = dispatch(agent.id, 'WORD?');
    // The launch was typed and nothing ever took the terminal.
    await vi.advanceTimersByTimeAsync(CLI_BOOT_MS + 1_000);
    const answer = await answered;

    expect(answer.body.mode).toBe('start');
    expect(spawned.length).toBe(before + 2);
  });
});
