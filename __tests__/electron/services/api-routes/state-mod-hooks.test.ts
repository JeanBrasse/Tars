/**
 * The hook routes when an agent's session runs the state mod
 * (electron/services/state-mod.ts, hooks-routes.ts).
 *
 * The mod posts what the four shell hooks post (SessionStart's registration,
 * UserPromptSubmit's running, Stop's output, idle and agent-stopped,
 * StopFailure's error), marked `via: 'mod'`, and the shell hooks still run
 * beside it, their posts marked with `hook`. One source per session: the
 * mod's, once it registered the session; the shell hooks' otherwise.
 *
 * How it fails, written before the code (2026-10-05):
 * 1. Both are applied: a status twice, and in the wrong order when the shell's
 *    curl lands after the mod's next post (a Stop's idle after the next
 *    turn's running).
 * 2. The shell hooks are ignored for a session the mod does not run: an
 *    agent whose mod did not load reports nothing at all.
 * 3. A post of another hook (a permission dialog's waiting, the
 *    Notification hook) is ignored because the mod runs: those are not the
 *    mod's in this step.
 * 4. A mod post from another session drives the agent (the stale guard).
 * 5. The heartbeat is taken from a session that is not the agent's current
 *    one, or without a usable session id.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EventEmitter } from 'events';

vi.mock('../../../../electron/core/agent-manager', () => ({
  agents: new Map(),
  saveAgents: vi.fn(),
  noteSessionRegistered: vi.fn(),
  noteTurnStarted: vi.fn(),
}));
vi.mock('electron', () => ({ BrowserWindow: { getAllWindows: vi.fn(() => []) } }));

import { registerHooksRoutes } from '../../../../electron/services/api-routes/hooks-routes';
import { agents } from '../../../../electron/core/agent-manager';
import { modRunsSession, modBeatFor, resetStateMod } from '../../../../electron/services/state-mod';
import type { RouteApp, RouteContext, RouteRequest } from '../../../../electron/services/api-routes/types';
import type { AgentStatus, AppSettings } from '../../../../electron/types';

const S1 = '11111111-1111-4111-8111-111111111111';
const S2 = '22222222-2222-4222-8222-222222222222';

let app: RouteApp;
let ctx: RouteContext;

function makeRouteApp(): RouteApp {
  return {
    routes: [],
    add(method, pattern, handler) { this.routes.push({ method, pattern, handler }); },
    get(pattern, handler) { this.add('GET', pattern, handler); },
    post(pattern, handler) { this.add('POST', pattern, handler); },
    put(pattern, handler) { this.add('PUT', pattern, handler); },
    delete(pattern, handler) { this.add('DELETE', pattern, handler); },
  };
}

async function post(pattern: string, body: Record<string, unknown>): Promise<Record<string, unknown>> {
  const route = app.routes.find(r => r.pattern === pattern);
  if (!route) throw new Error(`no route ${pattern}`);
  const sendJson = vi.fn();
  await route.handler({ body, params: {} } as RouteRequest, sendJson, ctx);
  return sendJson.mock.calls[0][0];
}

function agent(): AgentStatus {
  const a = { id: 'a1', status: 'idle', projectPath: '/p', skills: [], output: [], ptyId: 'pty-1', lastActivity: new Date().toISOString() } as AgentStatus;
  agents.set('a1', a);
  return a;
}

const register = (via: 'mod' | 'hook', session = S1) => post('/api/hooks/status', {
  agent_id: 'a1', session_id: session, status: 'idle', source: 'startup', ...(via === 'mod' ? { via: 'mod' } : { hook: 'SessionStart' }),
});

beforeEach(() => {
  agents.clear();
  resetStateMod();
  const appSettings = { notifyOnWaiting: true } as AppSettings;
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
  app = makeRouteApp();
  registerHooksRoutes(app, ctx);
});

describe('a session the mod registered', () => {
  it('is the mod\'s, and the shell hook\'s registration of it changes nothing', async () => {
    const a = agent();
    await register('mod');
    expect(a.currentSessionId).toBe(S1);
    expect(modRunsSession('a1', S1)).toBe(true);
    expect(await register('hook')).toMatchObject({ ignored: 'state-mod' });
  });

  it('1. takes its statuses from the mod alone: a shell Stop after the next turn started leaves it running', async () => {
    const a = agent();
    await register('mod');
    await post('/api/hooks/status', { agent_id: 'a1', session_id: S1, status: 'running', event: 'UserPromptSubmit', current_task: 'first', via: 'mod' });
    await post('/api/hooks/status', { agent_id: 'a1', session_id: S1, status: 'idle', via: 'mod' });
    await post('/api/hooks/status', { agent_id: 'a1', session_id: S1, status: 'running', event: 'UserPromptSubmit', current_task: 'second', via: 'mod' });
    // The first turn's shell Stop, landing late.
    expect(await post('/api/hooks/status', { agent_id: 'a1', session_id: S1, status: 'idle', hook: 'Stop' })).toMatchObject({ ignored: 'state-mod' });
    expect(await post('/api/hooks/output', { agent_id: 'a1', session_id: S1, output: 'late', hook: 'Stop' })).toMatchObject({ ignored: 'state-mod' });
    expect(a.status).toBe('running');
    expect(a.currentTask).toBe('second');
    expect(a.lastCleanOutput).toBeUndefined();
  });

  it('1. a shell StopFailure or UserPromptSubmit is ignored too, and the mod\'s error stands', async () => {
    const a = agent();
    await register('mod');
    expect(await post('/api/hooks/status', { agent_id: 'a1', session_id: S1, status: 'running', event: 'UserPromptSubmit', current_task: 'x', hook: 'UserPromptSubmit' })).toMatchObject({ ignored: 'state-mod' });
    expect(a.status).toBe('idle');
    await post('/api/hooks/status', { agent_id: 'a1', session_id: S1, status: 'error', event: 'StopFailure', error_kind: 'rate_limit', error_message: 'limit', via: 'mod' });
    expect(a.status).toBe('error');
  });

  it('3. still takes another hook\'s post: a permission dialog\'s waiting', async () => {
    const a = agent();
    await register('mod');
    await post('/api/hooks/status', { agent_id: 'a1', session_id: S1, status: 'running', event: 'UserPromptSubmit', current_task: 'x', via: 'mod' });
    await post('/api/hooks/status', { agent_id: 'a1', session_id: S1, status: 'waiting', waiting_reason: 'permission', opened_at: Date.now(), tool_name: 'Bash', tool_input: { command: 'ls' } });
    expect(a.status).toBe('waiting');
    expect(a.waitingReason).toBe('permission');
  });

  it('4. a mod post from another session is stale, and does not make that session the mod\'s', async () => {
    const a = agent();
    await register('mod');
    const answer = await post('/api/hooks/status', { agent_id: 'a1', session_id: S2, status: 'running', event: 'UserPromptSubmit', current_task: 'x', via: 'mod' });
    expect(answer).toMatchObject({ stale: true });
    expect(a.status).toBe('idle');
    expect(modRunsSession('a1', S2)).toBe(false);
  });
});

describe('a session the mod did not register', () => {
  it('2. takes the shell hooks as today', async () => {
    const a = agent();
    await register('hook');
    expect(modRunsSession('a1', S1)).toBe(false);
    await post('/api/hooks/status', { agent_id: 'a1', session_id: S1, status: 'running', event: 'UserPromptSubmit', current_task: 'x', hook: 'UserPromptSubmit' });
    expect(a.status).toBe('running');
    await post('/api/hooks/output', { agent_id: 'a1', session_id: S1, output: 'done', hook: 'Stop' });
    await post('/api/hooks/status', { agent_id: 'a1', session_id: S1, status: 'idle', hook: 'Stop' });
    expect(a.status).toBe('idle');
    expect(a.lastCleanOutput).toBe('done');
  });

  it('2. a mod registration of a newer session takes over from then on, and the old one goes back to nobody\'s', async () => {
    agent();
    await register('mod', S1);
    await register('hook', S2);
    expect(modRunsSession('a1', S2)).toBe(false);
    expect(await post('/api/hooks/status', { agent_id: 'a1', session_id: S2, status: 'running', event: 'UserPromptSubmit', current_task: 'x', hook: 'UserPromptSubmit' })).not.toMatchObject({ ignored: 'state-mod' });
  });
});

describe('the heartbeat', () => {
  it('5. is kept for the agent\'s current mod session, with the tool in flight', async () => {
    agent();
    await register('mod');
    expect(await post('/api/hooks/mod-beat', { agent_id: 'a1', session_id: S1, tool: 'Bash' })).toMatchObject({ success: true });
    expect(modBeatFor('a1')).toMatchObject({ sessionId: S1, tool: 'Bash' });
  });

  it('5. is refused from another session, with no session, or before the mod registered', async () => {
    agent();
    expect(await post('/api/hooks/mod-beat', { agent_id: 'a1', session_id: S1 })).toMatchObject({ success: false });
    await register('mod');
    expect(await post('/api/hooks/mod-beat', { agent_id: 'a1', session_id: S2 })).toMatchObject({ success: false });
    expect((await post('/api/hooks/mod-beat', { agent_id: 'a1' })).error).toBeTruthy();
    expect(modBeatFor('a1')?.tool).toBeNull();
  });
});
