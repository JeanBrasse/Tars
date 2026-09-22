import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { EventEmitter } from 'node:events';

/**
 * A message to an agent whose CLI is up is typed into that session; a new
 * session is started only where no CLI runs.
 *
 * /dispatch typed into `running` and `waiting` agents and started a new
 * session for every other status. But every turn ends on `idle` (the Stop
 * hook posts it) and a failed one on `error`, with the CLI still at its
 * prompt: the new session was spawned over it, which kills the terminal, and
 * with no `--resume`, the resume being spent once per run. Measured on
 * 2026-09-23 on the orchestrator itself: last Stop at 02:14:16, no idle_prompt
 * after it, a report dispatched at 02:22:24, its session ended and a blank one
 * registered two seconds later. #120 widens it: a Dashboard start and a
 * restart leave the agent `idle` at its prompt.
 *
 * The routes, the writer and cliRunningIn are the real ones. The terminals
 * come from spawnAgentPty, as every agent terminal does, over a node-pty that
 * records what is typed and names its foreground (`bash` at a shell, the
 * version number while claude runs).
 */

type FakePty = {
  pid: number; process: string; spawnedWith: string[];
  write: ReturnType<typeof vi.fn>; kill: ReturnType<typeof vi.fn>; resize: ReturnType<typeof vi.fn>;
  onData: ReturnType<typeof vi.fn>; onExit: ReturnType<typeof vi.fn>;
};
const spawned = vi.hoisted(() => [] as FakePty[]);

vi.mock('node-pty', () => ({
  spawn: vi.fn((file: string, args: string[]): FakePty => {
    const terminal: FakePty = {
      pid: 6000 + spawned.length, process: file, spawnedWith: args ?? [],
      write: vi.fn(), kill: vi.fn(), resize: vi.fn(), onData: vi.fn(), onExit: vi.fn(),
    };
    spawned.push(terminal);
    return terminal;
  }),
}));
let uuidCounter = 0;
vi.mock('uuid', () => ({ v4: vi.fn(() => `pty-spawned-${++uuidCounter}`) }));
vi.mock('electron', () => ({
  app: { getPath: () => os.tmpdir(), getAppPath: () => process.cwd() },
  BrowserWindow: { getAllWindows: () => [] },
}));
vi.mock('../../../../electron/utils/broadcast', () => ({ broadcastToAllWindows: vi.fn() }));
vi.mock('../../../../electron/utils/path-builder', () => ({ buildFullPath: vi.fn(() => '/usr/bin') }));
vi.mock('../../../../electron/services/memory-hub', () => ({
  needsPromptInjection: () => false,
  assembleDigest: async () => '',
  wrapDigestForPrompt: (d: string) => d,
}));
vi.mock('../../../../electron/services/acp/delegate', () => ({
  canDelegateOverAcp: () => false,
  delegateOverAcp: vi.fn(),
}));

import { registerAgentRoutes } from '../../../../electron/services/api-routes/agent-routes';
import { agents } from '../../../../electron/core/agent-manager';
import { ptyProcesses, resetTerminalInput } from '../../../../electron/core/pty-manager';
import { spawnAgentPty } from '../../../../electron/core/agent-pty';
import type { RouteApp, RouteContext, RouteRequest } from '../../../../electron/services/api-routes/types';
import type { AgentStatus, AppSettings } from '../../../../electron/types';

const project = fs.mkdtempSync(path.join(os.tmpdir(), 'tars-dispatch-live-'));

let routes: RouteApp;
let ctx: RouteContext;

async function call(method: string, url: string, body: Record<string, unknown>, caller: string) {
  const pathname = url.split('?')[0];
  for (const route of routes.routes) {
    if (route.method !== method) continue;
    const m = typeof route.pattern === 'string' ? (route.pattern === pathname ? [pathname] : null) : pathname.match(route.pattern);
    if (!m) continue;
    const answers: Array<{ data: Record<string, unknown>; status: number }> = [];
    const req = {
      method, pathname, url: new URL(`http://localhost${url}`), body,
      raw: { headers: {}, on: () => {} }, res: {}, params: m[1] ? { id: m[1] } : {},
      callerAgentId: caller,
    } as unknown as RouteRequest;
    await route.handler(req, (data, status = 200) => { answers.push({ data: data as Record<string, unknown>, status }); }, ctx);
    return answers.at(-1)!;
  }
  throw new Error(`no route for ${method} ${url}`);
}

/** The worker, with its terminal open and `foreground` in front: a CLI's version, or the shell. */
function worker(status: AgentStatus['status'], foreground: string): { agent: AgentStatus; terminal: FakePty } {
  const terminal = spawnAgentPty({
    binaryName: 'claude', shell: '/bin/bash', args: ['-l'], cwd: project, cols: 120, rows: 30,
    env: { CLAUDE_AGENT_ID: 'worker' },
  }) as unknown as FakePty;
  terminal.process = foreground;
  ptyProcesses.set('pty-worker', terminal as never);
  const agent = {
    id: 'worker', name: 'Tars-QA', status, projectPath: project, ptyCwd: project, provider: 'claude',
    skills: [], output: [], ptyId: 'pty-worker', currentSessionId: 'sess-live', resumableSessionId: 'sess-live',
    lastActivity: new Date().toISOString(), permissionMode: 'bypass',
  } as AgentStatus;
  agents.set('worker', agent);
  return { agent, terminal };
}

const typedInto = (terminal: FakePty) => terminal.write.mock.calls.map(c => String(c[0])).join('');

beforeEach(() => {
  vi.useFakeTimers();
  agents.clear();
  ptyProcesses.clear();
  spawned.length = 0;
  routes = {
    routes: [],
    add(method, pattern, handler) { this.routes.push({ method, pattern, handler }); },
    get(pattern, handler) { this.add('GET', pattern, handler); },
    post(pattern, handler) { this.add('POST', pattern, handler); },
    put(pattern, handler) { this.add('PUT', pattern, handler); },
    delete(pattern, handler) { this.add('DELETE', pattern, handler); },
  };
  const settings = {} as AppSettings;
  ctx = {
    mainWindow: null, appSettings: settings, getAppSettings: () => settings,
    getTelegramBot: () => null, getSlackApp: () => null,
    slackResponseChannel: null, slackResponseThreadTs: null,
    handleStatusChangeNotificationCallback: vi.fn(), sendNotificationCallback: vi.fn(),
    initAgentPtyCallback: vi.fn(async () => 'unused'),
    agentStatusEmitter: new EventEmitter(),
  } as RouteContext;
  registerAgentRoutes(routes, ctx);
  agents.set('orch', {
    id: 'orch', name: 'Tars-Orchestrator', status: 'running', projectPath: project,
    skills: [], output: [], lastActivity: new Date().toISOString(),
  } as AgentStatus);
});

afterEach(() => {
  for (const terminal of spawned) resetTerminalInput(terminal as never);
  vi.useRealTimers();
});

describe('POST /dispatch to an agent whose CLI is up', () => {
  it.each(['idle', 'error', 'completed'] as const)('types into the session when the status says %s, instead of ending it', async (status) => {
    const { agent, terminal } = worker(status, '2.1.280');

    const answer = await call('POST', '/api/agents/worker/dispatch', { message: 'Gate PR #123' }, 'orch');
    await vi.advanceTimersByTimeAsync(400);

    expect(answer.status).toBe(200);
    expect(answer.data.mode).toBe('message');
    expect(terminal.kill, 'the session was ended').not.toHaveBeenCalled();
    expect(spawned, 'a second terminal was opened over the first').toHaveLength(1);
    expect(typedInto(terminal)).toContain('Gate PR #123');
    expect(agent.ptyId).toBe('pty-worker');
    expect(agent.currentSessionId).toBe('sess-live');
    expect(agent.lastKilledSessionId).toBeUndefined();
    expect(agent.status).toBe('running');
  });

  it('still types into a session that is starting, before its CLI is up', async () => {
    // A spawn runs its shell for a moment before claude: `running`, shell in front.
    const { terminal } = worker('running', 'bash');

    const answer = await call('POST', '/api/agents/worker/dispatch', { message: 'second task' }, 'orch');

    expect(answer.data.mode).toBe('message');
    expect(terminal.kill).not.toHaveBeenCalled();
  });
});

describe('POST /dispatch where no CLI runs', () => {
  it('starts a session in place of the shell, with the message as its task', async () => {
    const { agent, terminal } = worker('idle', 'bash');

    const answer = await call('POST', '/api/agents/worker/dispatch', { message: 'Gate PR #123' }, 'orch');

    expect(answer.data.mode).toBe('start');
    expect(terminal.kill).toHaveBeenCalled();
    expect(spawned).toHaveLength(2);
    expect(spawned[1].spawnedWith.join(' ')).toContain("-- '");
    expect(spawned[1].spawnedWith.join(' ')).toContain('Gate PR #123');
    expect(typedInto(terminal), 'the task was typed into a bare shell').not.toContain('Gate PR #123');
    expect(agent.ptyId).not.toBe('pty-worker');
  });
});

describe('POST /message', () => {
  it('types into a session at its prompt whatever the status says', async () => {
    const { terminal } = worker('idle', '2.1.280');

    const answer = await call('POST', '/api/agents/worker/message', { message: 'status?' }, 'orch');
    await vi.advanceTimersByTimeAsync(400);

    expect(answer.data.success).toBe(true);
    expect(terminal.kill).not.toHaveBeenCalled();
    expect(typedInto(terminal)).toContain('status?');
  });

  it('never types a message into a bare shell, where it would run as a command: it starts a session', async () => {
    const { terminal } = worker('idle', 'bash');

    await call('POST', '/api/agents/worker/message', { message: 'rm -rf dist and rebuild' }, 'orch');
    await vi.advanceTimersByTimeAsync(400);

    expect(typedInto(terminal)).not.toContain('rm -rf dist');
    expect(terminal.kill).toHaveBeenCalled();
    expect(spawned).toHaveLength(2);
  });
});

describe('POST /start', () => {
  it('refuses to end a session whose CLI is up, and says so', async () => {
    const { agent, terminal } = worker('idle', '2.1.280');

    const answer = await call('POST', '/api/agents/worker/start', { prompt: 'fresh task' }, 'orch');

    expect(answer.status).toBe(409);
    expect(answer.data.cliRunning).toBe(true);
    expect(terminal.kill).not.toHaveBeenCalled();
    expect(spawned).toHaveLength(1);
    expect(agent.currentSessionId).toBe('sess-live');
  });

  it('starts a session where only a shell runs, as before', async () => {
    const { terminal } = worker('idle', 'bash');

    const answer = await call('POST', '/api/agents/worker/start', { prompt: 'fresh task' }, 'orch');

    expect(answer.status).toBe(200);
    expect(terminal.kill).toHaveBeenCalled();
    expect(spawned).toHaveLength(2);
  });
});
