import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EventEmitter } from 'events';

// ============================================================================
// Concurrency: can two dispatches for the same idle agent, arriving close
// together (two orchestrators delegating to the same agent at once), both
// win the "no live session, spawn a fresh one" race and produce two live
// PTYs for one agent record?
//
// spawnAgentSession only yields to the event loop (a real `await`) for
// providers whose CLI needs the prompt-injected memory digest
// (`needsPromptInjection` true - every non-claude CLI). For those, there is
// a real window between "no live PTY yet" and "PTY spawned, ptyId recorded"
// during which a second dispatch can observe the same pre-spawn state.
// ============================================================================

const mockPtyInstances: { onData: ReturnType<typeof vi.fn>; onExit: ReturnType<typeof vi.fn>; kill: ReturnType<typeof vi.fn> }[] = [];

vi.mock('node-pty', () => ({
  spawn: vi.fn(() => {
    const inst = { onData: vi.fn(), onExit: vi.fn(), kill: vi.fn(), write: vi.fn() };
    mockPtyInstances.push(inst);
    return inst;
  }),
}));

let uuidCounter = 0;
vi.mock('uuid', () => ({
  v4: vi.fn(() => `pty-${++uuidCounter}`),
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
  // Exported by agent-manager and imported by agent-routes: a mock that
  // omits it makes the spawn path throw on an undefined call.
  armTaskStartWatch: vi.fn(),
}));

vi.mock('../../../../electron/core/pty-manager', () => ({
  ptyProcesses: new Map(),
  writeProgrammaticInput: vi.fn(),
}));

vi.mock('../../../../electron/utils/path-builder', () => ({
  buildFullPath: vi.fn(() => '/usr/bin'),
}));

// A real network/fs-bound async gap: the memory digest genuinely suspends
// spawnAgentSession with a macrotask (setTimeout), exactly like the real
// hermes fetch or fs work assembleDigest does, instead of the microtask-only
// delay a resolved-promise mock would give us (which the single-threaded
// event loop would drain before ever touching the second request).
vi.mock('../../../../electron/services/memory-hub', () => ({
  needsPromptInjection: () => true,
  assembleDigest: () => new Promise(resolve => setTimeout(() => resolve('memory'), 5)),
  wrapDigestForPrompt: (d: string) => d,
}));

import { registerAgentRoutes, performDispatch } from '../../../../electron/services/api-routes/agent-routes';
import { agents, saveAgents } from '../../../../electron/core/agent-manager';
import { ptyProcesses } from '../../../../electron/core/pty-manager';
import { RouteApp, RouteContext } from '../../../../electron/services/api-routes/types';
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

let ctx: RouteContext;

beforeEach(() => {
  agents.clear();
  ptyProcesses.clear();
  mockPtyInstances.length = 0;
  uuidCounter = 0;
  vi.mocked(saveAgents).mockClear();

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

describe('concurrent dispatch to the same idle agent (non-claude provider)', () => {
  it('spawns only one PTY when two dispatches race for the same idle codex agent', async () => {
    const agent: AgentStatus = {
      id: 'a1',
      name: 'Codex Worker',
      status: 'idle',
      provider: 'codex' as any,
      projectPath: '/test/project',
      skills: [],
      output: [],
      lastActivity: new Date().toISOString(),
    };
    agents.set('a1', agent);

    // registerAgentRoutes is only needed to prove the route wiring calls
    // performDispatch the same way; we call performDispatch directly twice,
    // unawaited between calls, exactly like two near-simultaneous incoming
    // HTTP requests would reach it once their bodies are parsed.
    const app = makeRouteApp();
    registerAgentRoutes(app, ctx);

    const sendJson1 = vi.fn();
    const sendJson2 = vi.fn();

    await Promise.all([
      performDispatch(agent, { message: 'task A' }, ctx, sendJson1),
      performDispatch(agent, { message: 'task B' }, ctx, sendJson2),
    ]);

    const pty = await import('node-pty');
    // Whichever wins, only ONE PTY should exist for this agent - the other
    // dispatch must have observed the live session and messaged it instead
    // of spawning a second, orphaned process.
    expect((pty.spawn as any).mock.calls.length).toBe(1);
  });
});
