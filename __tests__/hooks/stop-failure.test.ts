import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import * as http from 'node:http';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

/**
 * An agent whose turn failed says so, in the CLI's own words.
 *
 * The night of 2026-09-16, eleven sessions out of twenty-eight registered and
 * never did any work, five of them in the same minute, and Tars reported every
 * one as `running`. Measured afterwards with claude 2.1.268 in a HOME holding
 * no credential: the CLI does not exit, SessionStart fires, the task becomes a
 * turn and UserPromptSubmit fires, then the turn ends at once on "Not logged in
 * · Please run /login". Stop never fires. StopFailure does, and nothing listened
 * to it, so the agent kept the `running` its turn had begun with.
 *
 * These run the real hook script on the payload that CLI sent, hand what it
 * posts to the real status route, and assert on the agent record, with the real
 * agent-manager so that a later turn clearing the failure is the real code too.
 */

// As turn-started.test.ts: agent-manager is real, only what reaches outside the
// process is stubbed. saveAgents is inert until loadAgents has run.
vi.mock('node-pty', () => ({
  spawn: vi.fn(() => ({ onData: vi.fn(), onExit: vi.fn(), kill: vi.fn(), write: vi.fn() })),
}));
vi.mock('uuid', () => ({ v4: vi.fn(() => 'pty-1') }));
vi.mock('electron', () => ({
  app: { getPath: () => os.tmpdir(), getAppPath: () => process.cwd() },
  BrowserWindow: { getAllWindows: vi.fn(() => []) },
}));
vi.mock('../../electron/utils/broadcast', () => ({ broadcastToAllWindows: vi.fn() }));
vi.mock('../../electron/core/pty-manager', () => ({
  ptyProcesses: new Map(),
  writeProgrammaticInput: vi.fn(),
}));
vi.mock('../../electron/utils/path-builder', () => ({ buildFullPath: vi.fn(() => '/usr/bin') }));

import { registerHooksRoutes } from '../../electron/services/api-routes/hooks-routes';
import { agents } from '../../electron/core/agent-manager';
import { ClaudeProvider } from '../../electron/providers/claude-provider';
import type { RouteApp, RouteContext, RouteRequest } from '../../electron/services/api-routes/types';
import type { AgentStatus, AppSettings } from '../../electron/types';

const HOOKS_DIR = path.join(__dirname, '../../hooks');
const HOOK = path.join(HOOKS_DIR, 'stop-failure.sh');
const SESSION = 'd684e49b-3c9c-483b-a162-ea96d695ae01';
const CLI_MESSAGE = 'Not logged in · Please run /login';

/**
 * What claude 2.1.268 handed its StopFailure hook from a HOME with no
 * credential, field for field. Only the two paths are shortened; the script
 * reads neither.
 */
const MEASURED_STOP_FAILURE = {
  session_id: SESSION,
  transcript_path: `/private/tmp/nologin/home/.claude/projects/-private-tmp-nologin-proj/${SESSION}.jsonl`,
  cwd: '/private/tmp/nologin/proj',
  prompt_id: 'bead9762-d893-4869-a352-258c68caf2fb',
  effort: { level: 'high' },
  hook_event_name: 'StopFailure',
  error: 'authentication_failed',
  last_assistant_message: CLI_MESSAGE,
};

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tars-stop-failure-'));
let server: http.Server;
let port: number;
let received: { url: string; body: string }[] = [];

beforeAll(async () => {
  server = http.createServer((req, res) => {
    let body = '';
    req.on('data', c => { body += c; });
    req.on('end', () => {
      received.push({ url: req.url ?? '', body });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: true }));
    });
  });
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
  port = (server.address() as { port: number }).port;
});

afterAll(async () => {
  await new Promise<void>(r => { server.close(() => r()); });
  fs.rmSync(tmp, { recursive: true, force: true });
});

let ctx: RouteContext;

beforeEach(() => {
  received = [];
  agents.clear();
  const appSettings = {} as AppSettings;
  ctx = {
    mainWindow: { isDestroyed: () => false, webContents: { send: vi.fn() } } as never,
    appSettings,
    getAppSettings: () => appSettings,
    getTelegramBot: () => null,
    getSlackApp: () => null,
    slackResponseChannel: null,
    slackResponseThreadTs: null,
    handleStatusChangeNotificationCallback: vi.fn(),
    sendNotificationCallback: vi.fn(),
    initAgentPtyCallback: vi.fn(),
    agentStatusEmitter: new EventEmitter(),
  } as RouteContext;
});

function putAgent(over: Partial<AgentStatus> = {}): AgentStatus {
  const agent = {
    id: 'a1',
    name: 'Tars-Backend',
    status: 'running',
    projectPath: '/test',
    skills: [],
    output: [],
    currentSessionId: SESSION,
    lastActivity: new Date().toISOString(),
    ...over,
  } as AgentStatus;
  agents.set(agent.id, agent);
  return agent;
}

/** A post to /api/hooks/status, handled by the real route. */
function post(body: Record<string, unknown>): void {
  const app = { routes: [] as RouteApp['routes'] } as RouteApp;
  app.add = (method, pattern, handler) => { app.routes.push({ method, pattern, handler }); };
  app.get = (p, h) => app.add('GET', p, h);
  app.post = (p, h) => app.add('POST', p, h);
  app.put = (p, h) => app.add('PUT', p, h);
  app.delete = (p, h) => app.add('DELETE', p, h);
  registerHooksRoutes(app, ctx);
  const route = app.routes.find(r => r.pattern === '/api/hooks/status');
  if (!route) throw new Error('/api/hooks/status is not registered');
  route.handler({ body, params: {} } as RouteRequest, vi.fn(), ctx);
}

/**
 * Run the real script the way the CLI does, pointed at the capturing server
 * through the variable Tars puts in every agent's environment, then deliver
 * each post it made to the real route.
 */
async function failTurn(payload: Record<string, unknown>): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn('/bin/bash', [HOOK], {
      env: { ...process.env, CLAUDE_MGR_API_URL: `http://127.0.0.1:${port}`, CLAUDE_AGENT_ID: 'a1', HOME: tmp },
    });
    child.stdout.resume();
    child.stderr.resume();
    child.on('error', reject);
    child.on('exit', () => resolve());
    child.stdin.end(JSON.stringify(payload));
  });
  for (const { url, body } of received) {
    expect(url).toBe('/api/hooks/status');
    post(JSON.parse(body));
  }
}

describe('a turn that fails on an API error', () => {
  it('puts the agent in error with the words the CLI wrote instead of an answer', async () => {
    const agent = putAgent();
    // The order the CLI measured: the turn begins, then fails.
    post({ agent_id: 'a1', session_id: SESSION, status: 'running', event: 'UserPromptSubmit' });
    expect(agent.status).toBe('running');

    await failTurn(MEASURED_STOP_FAILURE);

    expect(received, 'the hook made no post, so the failure stays invisible').toHaveLength(1);
    expect(agent.status).toBe('error');
    // The text itself, not only the status: the task-start watch and the
    // delivery check can also put an agent in error, with sentences of their
    // own, and a status alone would let either of them pass for this.
    expect(agent.error).toBe(CLI_MESSAGE);
    // What turns it into the desktop notification, whose body is agent.error.
    expect(ctx.handleStatusChangeNotificationCallback).toHaveBeenCalledWith(agent, 'error');
  });

  it('carries a message with quotes and line breaks through unchanged', async () => {
    const agent = putAgent();
    const message = 'API Error: 529 {"type":"error","error":{"type":"overloaded_error"}}\nTry again in a moment';

    await failTurn({ ...MEASURED_STOP_FAILURE, error: 'server_error', last_assistant_message: message });

    expect(agent.status).toBe('error');
    expect(agent.error).toBe(message);
  });

  it('names the failure when the CLI gives it no message', async () => {
    const agent = putAgent();
    const withoutMessage: Record<string, unknown> = { ...MEASURED_STOP_FAILURE, error: 'rate_limit' };
    delete withoutMessage.last_assistant_message;

    await failTurn(withoutMessage);

    expect(agent.status).toBe('error');
    expect(agent.error).toContain('rate_limit');
  });

  it('changes nothing when it comes from a session that no longer owns the agent', async () => {
    // /api/hooks/* needs no token, so ownership is the only thing standing
    // between a killed session's hooks and the agent that replaced it.
    const agent = putAgent({ currentSessionId: 'live-session' });

    await failTurn(MEASURED_STOP_FAILURE);

    expect(received).toHaveLength(1);
    expect(agent.status).toBe('running');
    expect(agent.error).toBeUndefined();
  });

  it('drops a delivery still pending, rather than typing it into a CLI that cannot run it', async () => {
    const agent = putAgent({
      pendingDelivery: { ptyId: 'pty-1', task: 'rebase onto main', dispatchedAt: new Date().toISOString() },
    });

    await failTurn(MEASURED_STOP_FAILURE);

    expect(agent.status).toBe('error');
    expect(agent.pendingDelivery).toBeUndefined();
  });

  it('leaves the failure behind once the next turn begins', async () => {
    const agent = putAgent();
    await failTurn(MEASURED_STOP_FAILURE);
    expect(agent.error).toBe(CLI_MESSAGE);

    // Noah runs /login in that terminal and sends the task again.
    post({ agent_id: 'a1', session_id: SESSION, status: 'running', event: 'UserPromptSubmit' });

    expect(agent.status).toBe('running');
    expect(agent.error).toBeUndefined();
  });
});

describe('the hook reaches every claude-family CLI', () => {
  it('is registered for StopFailure in the settings they all read', async () => {
    const home = fs.mkdtempSync(path.join(tmp, 'home-'));
    const realHome = process.env.HOME;
    process.env.HOME = home;
    try {
      const provider = new ClaudeProvider();
      // This writes a settings file. Refuse to write the real one.
      expect(provider.configDir.startsWith(home), `would have written into ${provider.configDir}`).toBe(true);

      await provider.configureHooks(HOOKS_DIR);

      const settings = JSON.parse(fs.readFileSync(path.join(provider.configDir, 'settings.json'), 'utf-8'));
      expect(settings.hooks.StopFailure?.[0]?.hooks?.[0]?.command).toBe(HOOK);
    } finally {
      process.env.HOME = realHome;
    }
  });

  it('is executable, since the CLI runs it by path', () => {
    expect(fs.statSync(HOOK).mode & 0o111).not.toBe(0);
  });
});
