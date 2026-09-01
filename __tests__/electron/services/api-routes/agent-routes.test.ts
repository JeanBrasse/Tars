import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EventEmitter } from 'events';

const mockPtyProcess = {
  onData: vi.fn(),
  onExit: vi.fn(),
  kill: vi.fn(),
  write: vi.fn(),
};

vi.mock('node-pty', () => ({
  spawn: vi.fn(() => mockPtyProcess),
}));

vi.mock('uuid', () => ({
  v4: vi.fn(() => 'test-uuid'),
}));

vi.mock('electron', () => ({
  app: { getPath: () => '/Users/test' },
  BrowserWindow: vi.fn(),
}));

vi.mock('../../../../electron/core/agent-manager', () => ({
  agents: new Map(),
  saveAgents: vi.fn(),
  initAgentPty: vi.fn(),
  killStalePty: vi.fn(),
  ensureProjectTrusted: vi.fn(),
  appendAgentOutput: vi.fn(),
  // Exported by agent-manager and imported by agent-routes: a mock that omits
  // it makes the spawn path throw on an undefined call.
  armTaskStartWatch: vi.fn(),
}));

vi.mock('../../../../electron/core/pty-manager', () => ({
  ptyProcesses: new Map(),
  writeProgrammaticInput: vi.fn(),
}));

vi.mock('../../../../electron/utils/path-builder', () => ({
  buildFullPath: vi.fn(() => '/usr/bin'),
}));

import { registerAgentRoutes } from '../../../../electron/services/api-routes/agent-routes';
import { agents, saveAgents, killStalePty } from '../../../../electron/core/agent-manager';
import { ptyProcesses, writeProgrammaticInput } from '../../../../electron/core/pty-manager';
import { RouteApp, RouteContext, RouteRequest, SendJson } from '../../../../electron/services/api-routes/types';
import { AgentStatus, AppSettings } from '../../../../electron/types';

function makeRouteApp(): RouteApp {
  const app: RouteApp = {
    routes: [],
    add(method, pattern, handler) { this.routes.push({ method, pattern, handler }); },
    get(pattern, handler) { this.add('GET', pattern, handler); },
    post(pattern, handler) { this.add('POST', pattern, handler); },
    put(pattern, handler) { this.add('PUT', pattern, handler); },
    delete(pattern, handler) { this.add('DELETE', pattern, handler); },
  };
  return app;
}

function makeAgent(overrides: Partial<AgentStatus> = {}): AgentStatus {
  return {
    id: 'agent-1',
    status: 'idle',
    projectPath: '/test/project',
    skills: [],
    output: [],
    lastActivity: new Date().toISOString(),
    ...overrides,
  };
}

function makeReq(overrides: Partial<RouteRequest> = {}): RouteRequest {
  return {
    method: 'GET',
    pathname: '',
    url: new URL('http://localhost/'),
    body: {},
    raw: {} as any,
    res: {} as any,
    params: {},
    ...overrides,
  };
}

let ctx: RouteContext;

beforeEach(() => {
  agents.clear();
  ptyProcesses.clear();
  vi.mocked(saveAgents).mockClear();
  vi.mocked(killStalePty).mockClear();
  vi.mocked(writeProgrammaticInput).mockClear();
  mockPtyProcess.onData.mockClear();
  mockPtyProcess.onExit.mockClear();
  mockPtyProcess.kill.mockClear();

  ctx = {
    mainWindow: { isDestroyed: () => false, webContents: { send: vi.fn() } } as any,
    appSettings: {} as AppSettings,
    getAppSettings: () => ({} as AppSettings),
    getTelegramBot: () => null,
    getSlackApp: () => null,
    slackResponseChannel: null,
    slackResponseThreadTs: null,
    handleStatusChangeNotificationCallback: vi.fn(),
    sendNotificationCallback: vi.fn(),
    initAgentPtyCallback: vi.fn(async () => 'new-pty-id'),
    agentStatusEmitter: new EventEmitter(),
  };
});

describe('agent-routes', () => {
  function findHandler(app: RouteApp, method: string, patternStr: string) {
    return app.routes.find(r => r.method === method && String(r.pattern).includes(patternStr))!.handler;
  }

  describe('GET /api/agents', () => {
    it('returns list of agents', async () => {
      agents.set('a1', makeAgent({ id: 'a1', name: 'Agent A' }));
      agents.set('a2', makeAgent({ id: 'a2', name: 'Agent B' }));

      const app = makeRouteApp();
      registerAgentRoutes(app, ctx);
      const handler = app.routes.find(r => r.method === 'GET' && r.pattern === '/api/agents')!.handler;

      const sendJson = vi.fn();
      await handler(makeReq(), sendJson, ctx);

      expect(sendJson).toHaveBeenCalledTimes(1);
      const result = sendJson.mock.calls[0][0];
      expect(result.agents).toHaveLength(2);
    });
  });

  describe('GET /api/agents/:id', () => {
    it('returns projected agent without the raw output buffer', async () => {
      const agent = makeAgent({ id: 'a1', output: ['ansi-chunk-1', 'ansi-chunk-2'] });
      agents.set('a1', agent);

      const app = makeRouteApp();
      registerAgentRoutes(app, ctx);
      const handler = findHandler(app, 'GET', 'agents\\/([^/]+)$');

      const sendJson = vi.fn();
      await handler(makeReq({ params: { id: 'a1' }, url: new URL('http://localhost/api/agents/a1') }), sendJson, ctx);

      const result = sendJson.mock.calls[0][0] as { agent: Record<string, unknown> };
      // The ANSI output buffer (up to 10 000 chunks) must never be serialized
      // into MCP responses — it destroys the orchestrator's context window.
      expect(result.agent.output).toBeUndefined();
      expect(result.agent.outputChunks).toBe(2);
      expect(result.agent.id).toBe('a1');
    });

    it('returns the full agent with ?full=true', async () => {
      const agent = makeAgent({ id: 'a1', output: ['chunk'] });
      agents.set('a1', agent);

      const app = makeRouteApp();
      registerAgentRoutes(app, ctx);
      const handler = findHandler(app, 'GET', 'agents\\/([^/]+)$');

      const sendJson = vi.fn();
      await handler(makeReq({ params: { id: 'a1' }, url: new URL('http://localhost/api/agents/a1?full=true') }), sendJson, ctx);
      expect(sendJson).toHaveBeenCalledWith({ agent });
    });

    it('returns 404 for missing agent', async () => {
      const app = makeRouteApp();
      registerAgentRoutes(app, ctx);
      const handler = findHandler(app, 'GET', 'agents\\/([^/]+)$');

      const sendJson = vi.fn();
      await handler(makeReq({ params: { id: 'nope' } }), sendJson, ctx);
      expect(sendJson).toHaveBeenCalledWith({ error: 'Agent not found' }, 404);
    });
  });

  describe('GET /api/agents/:id/output', () => {
    it('returns agent output', async () => {
      const agent = makeAgent({ id: 'a1', output: ['line1', 'line2', 'line3'], status: 'running' });
      agents.set('a1', agent);

      const app = makeRouteApp();
      registerAgentRoutes(app, ctx);
      const handler = findHandler(app, 'GET', 'output');

      const sendJson = vi.fn();
      const url = new URL('http://localhost/api/agents/a1/output?lines=2');
      await handler(makeReq({ params: { id: 'a1' }, url }), sendJson, ctx);
      expect(sendJson).toHaveBeenCalledWith({ output: 'line2line3', status: 'running' });
    });
  });

  describe('POST /api/agents', () => {
    it('creates a new agent', async () => {
      const app = makeRouteApp();
      registerAgentRoutes(app, ctx);
      const handler = app.routes.find(r => r.method === 'POST' && r.pattern === '/api/agents')!.handler;

      const sendJson = vi.fn();
      await handler(makeReq({ body: { projectPath: '/my/project', name: 'Test Agent' } }), sendJson, ctx);

      expect(sendJson).toHaveBeenCalledTimes(1);
      const result = sendJson.mock.calls[0][0];
      expect(result.agent.name).toBe('Test Agent');
      expect(result.agent.status).toBe('idle');
      expect(agents.size).toBe(1);
      expect(saveAgents).toHaveBeenCalled();
    });

    it('returns 400 without projectPath', async () => {
      const app = makeRouteApp();
      registerAgentRoutes(app, ctx);
      const handler = app.routes.find(r => r.method === 'POST' && r.pattern === '/api/agents')!.handler;

      const sendJson = vi.fn();
      await handler(makeReq({ body: {} }), sendJson, ctx);
      expect(sendJson).toHaveBeenCalledWith({ error: 'projectPath is required' }, 400);
    });
  });

  describe('POST /api/agents/:id/stop', () => {
    it('stops a running agent', async () => {
      const mockPty = { kill: vi.fn() };
      ptyProcesses.set('pty-1', mockPty as any);
      const agent = makeAgent({ id: 'a1', status: 'running', ptyId: 'pty-1' });
      agents.set('a1', agent);

      const app = makeRouteApp();
      registerAgentRoutes(app, ctx);
      const handler = findHandler(app, 'POST', 'stop');

      const sendJson = vi.fn();
      await handler(makeReq({ params: { id: 'a1' } }), sendJson, ctx);

      expect(mockPty.kill).toHaveBeenCalled();
      expect(agent.status).toBe('idle');
      expect(sendJson).toHaveBeenCalledWith({ success: true });
    });
  });

  describe('POST /api/agents/:id/start', () => {
    it('kills existing PTY before spawning a new one', async () => {
      const existingPty = { kill: vi.fn() };
      ptyProcesses.set('existing-pty', existingPty as any);
      const agent = makeAgent({ id: 'a1', status: 'idle', ptyId: 'existing-pty' });
      agents.set('a1', agent);

      const app = makeRouteApp();
      registerAgentRoutes(app, ctx);
      const handler = findHandler(app, 'POST', 'start');

      const sendJson = vi.fn();
      await handler(makeReq({ params: { id: 'a1' }, body: { prompt: 'Do something' } }), sendJson, ctx);

      expect(existingPty.kill).toHaveBeenCalled();
      expect(ptyProcesses.has('existing-pty')).toBe(false);
      expect(sendJson).toHaveBeenCalledWith({ success: true, agent: { id: 'a1', status: 'running' } });
    });

    it('transitions waiting→error when PTY exits while agent is waiting', async () => {
      const agent = makeAgent({ id: 'a1', status: 'idle' });
      agents.set('a1', agent);

      const app = makeRouteApp();
      registerAgentRoutes(app, ctx);
      const handler = findHandler(app, 'POST', 'start');

      const sendJson = vi.fn();
      await handler(makeReq({ params: { id: 'a1' }, body: { prompt: 'Do something' } }), sendJson, ctx);

      // Simulate status being set to 'waiting' by a hook while the PTY is running
      agent.status = 'waiting';

      // Simulate PTY exit
      const exitHandler = mockPtyProcess.onExit.mock.calls[0][0] as (args: { exitCode: number }) => void;
      exitHandler({ exitCode: 1 });

      // After the 1500ms delay, status should become 'error' not stay 'waiting'
      await new Promise(r => setTimeout(r, 1600));
      expect(agent.status).toBe('error');
    });

    it('clears session ownership so stale hooks cannot flip the new task', async () => {
      const agent = makeAgent({
        id: 'a1',
        status: 'waiting',
        currentSessionId: 'old-sess',
        waitingReason: 'permission',
        lastCleanOutput: 'old output',
      });
      agents.set('a1', agent);

      const app = makeRouteApp();
      registerAgentRoutes(app, ctx);
      const handler = findHandler(app, 'POST', 'start');

      await handler(makeReq({ params: { id: 'a1' }, body: { prompt: 'new task' } }), vi.fn(), ctx);

      expect(agent.status).toBe('running');
      expect(agent.currentSessionId).toBeUndefined();
      expect(agent.waitingReason).toBeUndefined();
      expect(agent.lastCleanOutput).toBeUndefined();
      // The killed session is tombstoned so its in-flight hooks are rejected
      // even while currentSessionId is still undefined.
      expect(agent.lastKilledSessionId).toBe('old-sess');
    });

    it('removes a dead PTY from the live map immediately on exit', async () => {
      const agent = makeAgent({ id: 'a1', status: 'idle' });
      agents.set('a1', agent);

      const app = makeRouteApp();
      registerAgentRoutes(app, ctx);
      const handler = findHandler(app, 'POST', 'start');
      await handler(makeReq({ params: { id: 'a1' }, body: { prompt: 'work' } }), vi.fn(), ctx);
      expect(ptyProcesses.has('test-uuid')).toBe(true);

      // PTY dies: it must leave the map RIGHT AWAY (node-pty write on a dead
      // PTY is a silent no-op), not after the 1500ms status-delay — otherwise
      // /dispatch happily "types" the next task into a corpse.
      const exitHandler = mockPtyProcess.onExit.mock.calls.at(-1)![0] as (args: { exitCode: number }) => void;
      exitHandler({ exitCode: 0 });
      expect(ptyProcesses.has('test-uuid')).toBe(false);
      // Status change is still deferred for hook output capture.
      expect(agent.status).toBe('running');
    });
  });

  describe('POST /api/agents/:id/dispatch', () => {
    it('types into the live PTY when the agent is running and clears stale output', async () => {
      const mockPty = { write: vi.fn() };
      ptyProcesses.set('pty-1', mockPty as any);
      const agent = makeAgent({ id: 'a1', name: 'Worker', status: 'running', ptyId: 'pty-1', lastCleanOutput: 'previous task result' });
      agents.set('a1', agent);

      const app = makeRouteApp();
      registerAgentRoutes(app, ctx);
      const handler = findHandler(app, 'POST', 'dispatch');

      const sendJson = vi.fn();
      await handler(makeReq({ params: { id: 'a1' }, body: { message: 'next step' } }), sendJson, ctx);

      expect(writeProgrammaticInput).toHaveBeenCalledWith(mockPty, 'next step', true);
      // The previous task's output must not be mistaken for this task's result.
      expect(agent.lastCleanOutput).toBeUndefined();
      expect(sendJson).toHaveBeenCalledWith({
        success: true,
        mode: 'message',
        previousStatus: 'running',
        agent: { id: 'a1', name: 'Worker', status: 'running' },
      });
    });

    it('refuses to type into a blocking permission dialog (409)', async () => {
      const mockPty = { write: vi.fn() };
      ptyProcesses.set('pty-1', mockPty as any);
      const agent = makeAgent({ id: 'a1', status: 'waiting', waitingReason: 'permission', ptyId: 'pty-1' });
      agents.set('a1', agent);

      const app = makeRouteApp();
      registerAgentRoutes(app, ctx);
      const handler = findHandler(app, 'POST', 'dispatch');

      const sendJson = vi.fn();
      await handler(makeReq({ params: { id: 'a1' }, body: { message: 'yes go on' } }), sendJson, ctx);

      // Typing would be useless and the delayed \r could ACCEPT the pending
      // permission — the dispatch must be refused with the reason.
      expect(writeProgrammaticInput).not.toHaveBeenCalled();
      expect(sendJson.mock.calls[0][1]).toBe(409);
      expect((sendJson.mock.calls[0][0] as { waitingReason: string }).waitingReason).toBe('permission');
      expect(agent.status).toBe('waiting');
    });

    it('spawns a fresh session when the agent is idle', async () => {
      const agent = makeAgent({ id: 'a1', name: 'Worker', status: 'idle' });
      agents.set('a1', agent);

      const app = makeRouteApp();
      registerAgentRoutes(app, ctx);
      const handler = findHandler(app, 'POST', 'dispatch');

      const sendJson = vi.fn();
      await handler(makeReq({ params: { id: 'a1' }, body: { message: 'do the task' } }), sendJson, ctx);

      const pty = await import('node-pty');
      expect(pty.spawn).toHaveBeenCalled();
      expect(agent.status).toBe('running');
      expect(sendJson).toHaveBeenCalledWith({
        success: true,
        mode: 'start',
        previousStatus: 'idle',
        agent: { id: 'a1', name: 'Worker', status: 'running' },
      });
    });

    it('spawns fresh when status says waiting but the PTY is dead', async () => {
      // The "agent ne répond plus" scenario: status stuck at waiting with no
      // live PTY. Dispatch must NOT try to message a ghost — it respawns.
      const agent = makeAgent({ id: 'a1', status: 'waiting', ptyId: 'gone-pty' });
      agents.set('a1', agent);

      const app = makeRouteApp();
      registerAgentRoutes(app, ctx);
      const handler = findHandler(app, 'POST', 'dispatch');

      const sendJson = vi.fn();
      await handler(makeReq({ params: { id: 'a1' }, body: { message: 'retry task' } }), sendJson, ctx);

      expect(writeProgrammaticInput).not.toHaveBeenCalled();
      const result = sendJson.mock.calls[0][0] as { mode: string };
      expect(result.mode).toBe('start');
      expect(agent.status).toBe('running');
    });

    it('returns 400 without message', async () => {
      agents.set('a1', makeAgent({ id: 'a1' }));

      const app = makeRouteApp();
      registerAgentRoutes(app, ctx);
      const handler = findHandler(app, 'POST', 'dispatch');

      const sendJson = vi.fn();
      await handler(makeReq({ params: { id: 'a1' }, body: {} }), sendJson, ctx);
      expect(sendJson).toHaveBeenCalledWith({ error: 'message is required' }, 400);
    });
  });

  describe('identity bootstrap', () => {
    it('spawn command carries an identity header so agents know who they are', async () => {
      const agent = makeAgent({
        id: 'a1',
        name: 'Backend-Alpha',
        status: 'idle',
        role: 'worker',
        projectPath: '/proj/alpha',
        worktreePath: '/proj/alpha/.worktrees/feat/backend',
        branchName: 'feat/backend',
      });
      agents.set('a1', agent);

      const app = makeRouteApp();
      registerAgentRoutes(app, ctx);
      const handler = findHandler(app, 'POST', 'start');
      await handler(makeReq({ params: { id: 'a1' }, body: { prompt: 'fix the API' } }), vi.fn(), ctx);

      const pty = await import('node-pty');
      const command = (pty.spawn as any).mock.calls.at(-1)[1][2] as string;
      expect(command).toContain('you are agent "Backend-Alpha" (id a1), worker of project /proj/alpha');
      expect(command).toContain('worktree /proj/alpha/.worktrees/feat/backend');
      expect(command).toContain('fix the API');

      const spawnEnv = (pty.spawn as any).mock.calls.at(-1)[2].env;
      expect(spawnEnv.CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD).toBe('1');
    });

    it('GET /:id/bootstrap returns identity and same-project roster only', async () => {
      agents.set('orch', makeAgent({ id: 'orch', name: 'Orchestrator-Alpha', role: 'orchestrator', projectPath: '/proj/alpha' }));
      agents.set('w1', makeAgent({ id: 'w1', name: 'Frontend-Alpha', role: 'worker', projectPath: '/proj/alpha', branchName: 'feat/frontend' }));
      agents.set('w2', makeAgent({ id: 'w2', name: 'Tars-Worker', role: 'worker', projectPath: '/proj/beta' }));

      const app = makeRouteApp();
      registerAgentRoutes(app, ctx);
      const handler = findHandler(app, 'GET', 'bootstrap');

      const sendJson = vi.fn();
      await handler(makeReq({ params: { id: 'orch' }, url: new URL('http://localhost/api/agents/orch/bootstrap') }), sendJson, ctx);

      const context = (sendJson.mock.calls[0][0] as { context: string }).context;
      expect(context).toContain('You are "Orchestrator-Alpha"');
      expect(context).toContain('Frontend-Alpha');
      expect(context).not.toContain('Tars-Worker');
      expect(context).toContain('Delegate ONLY to the agents listed above');
    });

    it('GET /:id/health reports PTY liveness and session presence', async () => {
      const mockPty = { kill: vi.fn() };
      ptyProcesses.set('pty-live', mockPty as any);
      agents.set('alive', makeAgent({ id: 'alive', status: 'running', ptyId: 'pty-live', currentSessionId: 'sess' }));
      agents.set('ghost', makeAgent({ id: 'ghost', status: 'waiting', ptyId: 'pty-gone' }));

      const app = makeRouteApp();
      registerAgentRoutes(app, ctx);
      const handler = findHandler(app, 'GET', 'health');

      const sendAlive = vi.fn();
      await handler(makeReq({ params: { id: 'alive' }, url: new URL('http://localhost/api/agents/alive/health') }), sendAlive, ctx);
      expect(sendAlive.mock.calls[0][0]).toMatchObject({ ptyAlive: true, hasLiveSession: true, status: 'running' });

      const sendGhost = vi.fn();
      await handler(makeReq({ params: { id: 'ghost' }, url: new URL('http://localhost/api/agents/ghost/health') }), sendGhost, ctx);
      expect(sendGhost.mock.calls[0][0]).toMatchObject({ ptyAlive: false, hasLiveSession: false, status: 'waiting' });
    });
  });

  describe('project scoping', () => {
    function reqFromProject(project: string, overrides: Partial<RouteRequest> = {}): RouteRequest {
      return makeReq({
        raw: { headers: { 'x-dorothy-caller-project': project }, on: () => {} } as any,
        ...overrides,
      });
    }

    it('GET /api/agents returns only the caller project agents', async () => {
      agents.set('a1', makeAgent({ id: 'a1', projectPath: '/proj/alpha' }));
      agents.set('a2', makeAgent({ id: 'a2', projectPath: '/proj/beta' }));
      agents.set('a3', makeAgent({ id: 'a3', projectPath: '/proj/alpha' }));

      const app = makeRouteApp();
      registerAgentRoutes(app, ctx);
      const handler = app.routes.find(r => r.method === 'GET' && r.pattern === '/api/agents')!.handler;

      const sendJson = vi.fn();
      await handler(reqFromProject('/proj/alpha', { url: new URL('http://localhost/api/agents') }), sendJson, ctx);

      const result = sendJson.mock.calls[0][0] as { agents: { id: string }[]; scopedToProject?: string };
      expect(result.agents.map(a => a.id).sort()).toEqual(['a1', 'a3']);
      expect(result.scopedToProject).toBe('/proj/alpha');
    });

    it('GET /api/agents?all=true returns every project', async () => {
      agents.set('a1', makeAgent({ id: 'a1', projectPath: '/proj/alpha' }));
      agents.set('a2', makeAgent({ id: 'a2', projectPath: '/proj/beta' }));

      const app = makeRouteApp();
      registerAgentRoutes(app, ctx);
      const handler = app.routes.find(r => r.method === 'GET' && r.pattern === '/api/agents')!.handler;

      const sendJson = vi.fn();
      await handler(reqFromProject('/proj/alpha', { url: new URL('http://localhost/api/agents?all=true') }), sendJson, ctx);

      const result = sendJson.mock.calls[0][0] as { agents: unknown[] };
      expect(result.agents).toHaveLength(2);
    });

    it('rejects dispatch to an agent of another project with 403', async () => {
      agents.set('a1', makeAgent({ id: 'a1', name: 'Tars-Worker', projectPath: '/proj/beta' }));

      const app = makeRouteApp();
      registerAgentRoutes(app, ctx);
      const handler = findHandler(app, 'POST', 'dispatch');

      const pty = await import('node-pty');
      const spawnCallsBefore = (pty.spawn as any).mock.calls.length;

      const sendJson = vi.fn();
      await handler(reqFromProject('/proj/alpha', { params: { id: 'a1' }, body: { message: 'go' } }), sendJson, ctx);

      expect(sendJson.mock.calls[0][1]).toBe(403);
      expect(String((sendJson.mock.calls[0][0] as { error: string }).error)).toContain('Cross-project access denied');
      expect((pty.spawn as any).mock.calls.length).toBe(spawnCallsBefore);
    });

    it('allows cross-project dispatch with allowCrossProject: true', async () => {
      const agent = makeAgent({ id: 'a1', projectPath: '/proj/beta', status: 'idle' });
      agents.set('a1', agent);

      const app = makeRouteApp();
      registerAgentRoutes(app, ctx);
      const handler = findHandler(app, 'POST', 'dispatch');

      const sendJson = vi.fn();
      await handler(
        reqFromProject('/proj/alpha', { params: { id: 'a1' }, body: { message: 'go', allowCrossProject: true } }),
        sendJson,
        ctx
      );

      expect(agent.status).toBe('running');
      expect((sendJson.mock.calls[0][0] as { mode: string }).mode).toBe('start');
    });

    it('callers without identity headers (UI) are unrestricted', async () => {
      const agent = makeAgent({ id: 'a1', projectPath: '/proj/beta', status: 'idle' });
      agents.set('a1', agent);

      const app = makeRouteApp();
      registerAgentRoutes(app, ctx);
      const handler = findHandler(app, 'POST', 'start');

      const sendJson = vi.fn();
      await handler(makeReq({ params: { id: 'a1' }, body: { prompt: 'go' } }), sendJson, ctx);
      expect(agent.status).toBe('running');
    });
  });

  describe('POST /api/agents/:id/message', () => {
    it('sends message to agent PTY', async () => {
      const mockPty = { write: vi.fn() };
      ptyProcesses.set('pty-1', mockPty as any);
      const agent = makeAgent({ id: 'a1', status: 'running', ptyId: 'pty-1' });
      agents.set('a1', agent);

      const app = makeRouteApp();
      registerAgentRoutes(app, ctx);
      const handler = findHandler(app, 'POST', 'message');

      const sendJson = vi.fn();
      await handler(makeReq({ params: { id: 'a1' }, body: { message: 'hello' } }), sendJson, ctx);

      expect(writeProgrammaticInput).toHaveBeenCalledWith(mockPty, 'hello', true);
      expect(sendJson).toHaveBeenCalledWith({ success: true });
    });

    it('auto-respawns PTY with message as prompt when PTY is missing', async () => {
      const agent = makeAgent({ id: 'a1', status: 'waiting', projectPath: '/test/project' });
      agents.set('a1', agent);

      const app = makeRouteApp();
      registerAgentRoutes(app, ctx);
      const handler = findHandler(app, 'POST', 'message');

      const sendJson = vi.fn();
      await handler(makeReq({ params: { id: 'a1' }, body: { message: 'continue the task' } }), sendJson, ctx);

      // Should NOT call the legacy initAgentPtyCallback (bare bash shell)
      expect(ctx.initAgentPtyCallback).not.toHaveBeenCalled();
      // Should have spawned a new one-shot PTY
      const pty = await import('node-pty');
      expect(pty.spawn).toHaveBeenCalled();
      // Agent should be running and PTY registered
      expect(agent.status).toBe('running');
      expect(agent.ptyId).toBe('test-uuid');
      expect(ptyProcesses.has('test-uuid')).toBe(true);
      expect(sendJson).toHaveBeenCalledWith({ success: true });
    });

    it('BUG 4: calls killStalePty before reusing existing PTY', async () => {
      const mockPty = { write: vi.fn() };
      ptyProcesses.set('pty-1', mockPty as any);
      const agent = makeAgent({
        id: 'a1',
        status: 'running',
        ptyId: 'pty-1',
        projectPath: '/test/project',
        worktreePath: '/test/project/.worktrees/feat/backend',
        ptyCwd: '/test/project/.worktrees/feat/backend',
      });
      agents.set('a1', agent);

      const app = makeRouteApp();
      registerAgentRoutes(app, ctx);
      const handler = findHandler(app, 'POST', 'message');

      await handler(makeReq({ params: { id: 'a1' }, body: { message: 'hi' } }), vi.fn(), ctx);

      // killStalePty must be called on every /message so stale cwd is caught
      expect(killStalePty).toHaveBeenCalledWith(agent);
    });

    it('BUG 4: reconnect path records worktreePath as ptyCwd', async () => {
      const agent = makeAgent({
        id: 'a1',
        status: 'waiting',
        projectPath: '/test/project',
        worktreePath: '/test/project/.worktrees/feat/backend',
      });
      agents.set('a1', agent);

      const app = makeRouteApp();
      registerAgentRoutes(app, ctx);
      const handler = findHandler(app, 'POST', 'message');

      await handler(makeReq({ params: { id: 'a1' }, body: { message: 'go' } }), vi.fn(), ctx);

      // ptyCwd must match the worktree path — this is the cwd bash/claude
      // actually inherits from pty.spawn. Without it, killStalePty can't
      // detect a later worktree change.
      expect(agent.ptyCwd).toBe('/test/project/.worktrees/feat/backend');

      // pty.spawn must receive the raw path (not the shell-escaped version)
      // so it works for paths that legitimately contain a single quote.
      const pty = await import('node-pty');
      expect(pty.spawn).toHaveBeenCalled();
      const spawnOpts = (pty.spawn as any).mock.calls.at(-1)[2];
      expect(spawnOpts.cwd).toBe('/test/project/.worktrees/feat/backend');
    });

    it('reconnect path applies the skills prefix like /start does', async () => {
      // The old reconnect path rebuilt the claude command from scratch and
      // silently dropped the skills prefix — reconnected agents "forgot" their
      // skills. Both paths now share spawnAgentSession.
      const agent = makeAgent({ id: 'a1', status: 'waiting', skills: ['frontend-design'] });
      agents.set('a1', agent);

      const app = makeRouteApp();
      registerAgentRoutes(app, ctx);
      const handler = findHandler(app, 'POST', 'message');

      await handler(makeReq({ params: { id: 'a1' }, body: { message: 'continue' } }), vi.fn(), ctx);

      const pty = await import('node-pty');
      const command = (pty.spawn as any).mock.calls.at(-1)[1][2] as string;
      expect(command).toContain('Use these skills for this session: frontend-design');
    });
  });

  describe('BUG 4 cwd invariants', () => {
    it('POST /start uses worktreePath as raw spawn cwd and records ptyCwd', async () => {
      const agent = makeAgent({
        id: 'a1',
        status: 'idle',
        projectPath: '/test/project',
        worktreePath: '/test/project/.worktrees/feat/backend',
      });
      agents.set('a1', agent);

      const app = makeRouteApp();
      registerAgentRoutes(app, ctx);
      const handler = findHandler(app, 'POST', 'start');

      await handler(makeReq({ params: { id: 'a1' }, body: { prompt: 'work' } }), vi.fn(), ctx);

      // ptyCwd must match the logical worktree path so killStalePty has
      // ground truth to compare against when worktreePath later changes.
      expect(agent.ptyCwd).toBe('/test/project/.worktrees/feat/backend');

      // pty.spawn must receive the raw (non-shell-escaped) worktree path.
      // Passing the escaped form would break paths containing single quotes.
      const pty = await import('node-pty');
      const spawnOpts = (pty.spawn as any).mock.calls.at(-1)[2];
      expect(spawnOpts.cwd).toBe('/test/project/.worktrees/feat/backend');
    });
  });

  describe('DELETE /api/agents/:id', () => {
    it('deletes agent and kills PTY', async () => {
      const mockPty = { kill: vi.fn() };
      ptyProcesses.set('pty-1', mockPty as any);
      const agent = makeAgent({ id: 'a1', ptyId: 'pty-1' });
      agents.set('a1', agent);

      const app = makeRouteApp();
      registerAgentRoutes(app, ctx);
      const handler = findHandler(app, 'DELETE', 'agents');

      const sendJson = vi.fn();
      await handler(makeReq({ params: { id: 'a1' } }), sendJson, ctx);

      expect(mockPty.kill).toHaveBeenCalled();
      expect(agents.has('a1')).toBe(false);
      expect(sendJson).toHaveBeenCalledWith({ success: true });
    });
  });

  describe('GET /api/agents/:id/wait', () => {
    it('returns immediately for terminal state', async () => {
      const agent = makeAgent({ id: 'a1', status: 'completed', lastCleanOutput: 'done' });
      agents.set('a1', agent);

      const app = makeRouteApp();
      registerAgentRoutes(app, ctx);
      const handler = findHandler(app, 'GET', 'wait');

      const sendJson = vi.fn();
      const url = new URL('http://localhost/api/agents/a1/wait');
      await handler(makeReq({ params: { id: 'a1' }, url }), sendJson, ctx);

      expect(sendJson).toHaveBeenCalledWith({
        status: 'completed',
        lastCleanOutput: 'done',
        error: undefined,
      });
    });
  });
});
