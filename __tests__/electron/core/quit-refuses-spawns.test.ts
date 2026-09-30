/**
 * Once the quit has begun, nothing new is started, and nothing that ends is
 * news (the Audit's gate of #235, findings 2 and 4).
 *
 * The quit ends the terminals it holds, over a grace of up to two seconds,
 * while the API, the IPC and the bots still serve. Measured on #235: a /start
 * 200 ms into the quit answered 200 and spawned a CLI that was in no map,
 * which nothing signalled and nothing waited for; one that ignored SIGHUP held
 * the app in FreeEnvironment for ten minutes. A /delegate in that window
 * started an ACP run after the runs had been ended.
 *
 * How it fails, written before the code (2026-10-01):
 * 1. /start (and every route that starts a session through spawnAgentSession)
 *    spawns during the quit, or answers as if it had.
 * 2. spawnAgentPty, the one line every agent terminal starts on, spawns during
 *    the quit for a caller that did not ask (a bot, the IPC, main.ts).
 * 3. A delegated run starts during the quit.
 * 4. A terminal that is not an agent's (the user's shell panel, the pty:create
 *    terminal, the skill and plugin runners, the npx installer) starts during
 *    the quit: any pty.spawn not guarded.
 * 5. A terminal ended by the quit sets its agent `completed` or `error`, saves
 *    it and tells the window: any exit handler not going through
 *    agentStatusOnExit. Before the quit, an exit still is news.
 */
import { describe, it, expect, vi, beforeAll } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { EventEmitter } from 'events';

vi.mock('node-pty', () => ({ spawn: vi.fn(() => ({ onData: vi.fn(), onExit: vi.fn(), kill: vi.fn(), write: vi.fn(), pid: 1 })) }));
vi.mock('uuid', () => ({ v4: vi.fn(() => 'test-uuid') }));
vi.mock('electron', () => ({
  app: { getPath: () => '/Users/test' },
  BrowserWindow: Object.assign(vi.fn(), { getAllWindows: () => [] }),
}));
vi.mock('../../../electron/core/agent-manager', () => ({
  agents: new Map(),
  saveAgents: vi.fn(),
  initAgentPty: vi.fn(),
  killStalePty: vi.fn(),
  ensureProjectTrusted: vi.fn(),
  appendAgentOutput: vi.fn(),
  armTaskStartWatch: vi.fn(),
}));
vi.mock('../../../electron/core/pty-manager', () => ({
  ptyProcesses: new Map(),
  writeProgrammaticInput: vi.fn(),
  rememberTerminalOwner: vi.fn(),
}));
vi.mock('../../../electron/utils/path-builder', () => ({ buildFullPath: vi.fn(() => '/usr/bin') }));

import * as pty from 'node-pty';
import { beginQuit, isQuitting, agentStatusOnExit } from '../../../electron/core/quit-state';
import { registerAgentRoutes } from '../../../electron/services/api-routes/agent-routes';
import { spawnAgentPty } from '../../../electron/core/agent-pty';
import { delegateOverAcp } from '../../../electron/services/acp/delegate';
import { agents } from '../../../electron/core/agent-manager';
import type { RouteApp, RouteContext, RouteRequest } from '../../../electron/services/api-routes/types';
import type { AgentStatus, AppSettings } from '../../../electron/types';

const electronDir = path.join(__dirname, '../../../electron');
function sources(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap(e => {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) return e.name === 'dist' ? [] : sources(p);
    return e.name.endsWith('.ts') ? [p] : [];
  });
}

describe('before the quit', () => {
  it('5. an exit is its agent\'s news', () => {
    expect(isQuitting()).toBe(false);
    expect(agentStatusOnExit(0)).toBe('completed');
    expect(agentStatusOnExit(1)).toBe('error');
  });
});

describe('once the quit has begun', () => {
  beforeAll(() => beginQuit());

  it('5. an exit is nobody\'s news', () => {
    expect(isQuitting()).toBe(true);
    expect(agentStatusOnExit(0)).toBeNull();
    expect(agentStatusOnExit(137)).toBeNull();
  });

  it('1. /start answers that Tars is quitting, and spawns nothing', async () => {
    vi.mocked(pty.spawn).mockClear();
    const agent = { id: 'a1', status: 'idle', projectPath: '/test/project', skills: [], output: [], lastActivity: '' } as unknown as AgentStatus;
    agents.set('a1', agent);
    const routes: { method: string; pattern: string; handler: (...a: unknown[]) => unknown }[] = [];
    const app = { add(method: string, pattern: string, handler: (...a: unknown[]) => unknown) { routes.push({ method, pattern, handler }); },
      get(p: string, h: never) { this.add('GET', p, h); }, post(p: string, h: never) { this.add('POST', p, h); },
      put(p: string, h: never) { this.add('PUT', p, h); }, delete(p: string, h: never) { this.add('DELETE', p, h); }, routes: [] } as unknown as RouteApp;
    const appSettings = {} as AppSettings;
    const ctx = { getAppSettings: () => appSettings, appSettings, agentStatusEmitter: new EventEmitter(), handleStatusChangeNotificationCallback: vi.fn() } as unknown as RouteContext;
    registerAgentRoutes(app, ctx);
    const start = routes.find(r => r.method === 'POST' && r.pattern.endsWith('/start'))!.handler;
    const sendJson = vi.fn();

    await start({ params: { id: 'a1' }, body: { prompt: 'work' }, callerAgentId: 'a1' } as unknown as RouteRequest, sendJson, ctx);

    expect(pty.spawn).not.toHaveBeenCalled();
    expect(sendJson).toHaveBeenCalledWith(expect.objectContaining({ quitting: true }), 503);
    expect(agent.status).toBe('idle');
  });

  it('2. spawnAgentPty refuses, whoever calls it', () => {
    vi.mocked(pty.spawn).mockClear();
    expect(() => spawnAgentPty({ binaryName: 'claude', shell: '/bin/bash', args: ['-l'], cwd: '/tmp', cols: 80, rows: 24, env: {} })).toThrow(/quitting/);
    expect(pty.spawn).not.toHaveBeenCalled();
  });

  it('3. a delegated run does not start', async () => {
    const result = await delegateOverAcp({ agent: { id: 'a2', provider: 'claude', projectPath: '/tmp' } as AgentStatus, task: 'work', appSettings: {} as AppSettings });
    expect(result).toMatchObject({ ok: false, started: false, error: expect.stringMatching(/quitting/) });
  });
});

describe('every spawn site and exit handler in electron/', () => {
  const files = sources(electronDir).map(f => ({ f: path.relative(electronDir, f), text: fs.readFileSync(f, 'utf-8') }));

  it('4. every pty.spawn, and the ACP child, is refused while quitting', () => {
    const unguarded: string[] = [];
    for (const { f, text } of files) {
      for (const m of text.matchAll(/\bpty\.spawn\(|\bspawn\(this\.launch\.command/g)) {
        const before = text.slice(Math.max(0, m.index! - 1500), m.index!);
        const fnStart = Math.max(before.lastIndexOf('function '), before.lastIndexOf('=> {'), before.lastIndexOf('async ('));
        if (!before.slice(fnStart).includes('refuseWhileQuitting(')) unguarded.push(`${f}:${text.slice(0, m.index!).split('\n').length}`);
      }
    }
    expect(files.some(({ text }) => /\bpty\.spawn\(/.test(text)), 'the scan found no spawn at all').toBe(true);
    expect(unguarded).toEqual([]);
  });

  it('5. every exit handler that sets an agent\'s status asks agentStatusOnExit', () => {
    const direct = files
      .filter(({ f }) => f !== path.join('core', 'quit-state.ts'))
      .flatMap(({ f, text }) => [...text.matchAll(/exitCode === 0 \?|exitCode !== 0 \?/g)].map(m => `${f}:${text.slice(0, m.index!).split('\n').length}`));
    expect(direct).toEqual([]);
    const users = files.filter(({ text }) => text.includes('agentStatusOnExit(')).map(({ f }) => f).sort();
    expect(users).toEqual(expect.arrayContaining([
      'main.ts', path.join('core', 'agent-manager.ts'), path.join('handlers', 'ipc-handlers.ts'), path.join('services', 'api-routes', 'agent-routes.ts'),
    ]));
  });
});
