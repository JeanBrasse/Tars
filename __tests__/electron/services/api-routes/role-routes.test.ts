import { describe, it, expect, vi, beforeEach, afterAll, beforeAll } from 'vitest';
import { EventEmitter } from 'events';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

/**
 * The API reads the role, never the name (core/agent-role.ts).
 *
 * spawnAgentSession, which every /start, /dispatch, /message reconnect and the
 * Hermes webhook go through, decided an orchestrator by the role or the name;
 * so did the bootstrap every session reads at start, and POST /api/agents set
 * the role of a new agent from its name. A worker called "Tars-Orchestrator"
 * was launched with the orchestration instructions and without its editing
 * tools, and an orchestrator renamed lost both on its next spawn.
 */

const mockPtyProcess = { onData: vi.fn(), onExit: vi.fn(), kill: vi.fn(), write: vi.fn() };

vi.mock('node-pty', () => ({ spawn: vi.fn(() => mockPtyProcess) }));
vi.mock('electron', () => ({
  app: { getPath: () => '/Users/test', getAppPath: () => process.cwd() },
  BrowserWindow: Object.assign(vi.fn(), { getAllWindows: () => [] }),
}));
vi.mock('../../../../electron/core/agent-manager', () => ({
  agents: new Map(),
  saveAgents: vi.fn(),
  initAgentPty: vi.fn(),
  killStalePty: vi.fn(),
  ensureProjectTrusted: vi.fn(),
  appendAgentOutput: vi.fn(),
  armTaskStartWatch: vi.fn(),
}));
vi.mock('../../../../electron/core/pty-manager', () => ({
  ptyProcesses: new Map(),
  writeProgrammaticInput: vi.fn(),
  rememberTerminalOwner: vi.fn(),
}));
vi.mock('../../../../electron/core/agent-restart', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../../electron/core/agent-restart')>()),
  noteLaunch: vi.fn(),
  restartForSettings: vi.fn(),
}));
vi.mock('../../../../electron/utils/path-builder', () => ({ buildFullPath: vi.fn(() => '/usr/bin') }));

import * as pty from 'node-pty';
import { registerAgentRoutes } from '../../../../electron/services/api-routes/agent-routes';
import { agents } from '../../../../electron/core/agent-manager';
import { ptyProcesses } from '../../../../electron/core/pty-manager';
import { restartForSettings } from '../../../../electron/core/agent-restart';
import { getSuperAgentInstructionsPath } from '../../../../electron/utils';
import type { RouteApp, RouteContext, RouteRequest } from '../../../../electron/services/api-routes/types';
import type { AgentStatus, AppSettings } from '../../../../electron/types';

// The launch these hold is darwin and linux's: a line typed into the shell, or
// `bash -l -c`. On a Windows host they read it as linux; the win32 launch (the
// CLI as the terminal's process) is held by launch-call-sites.test.ts and
// agent-terminal-win32.test.ts.
const hostPlatform = Object.getOwnPropertyDescriptor(process, 'platform')!;
beforeAll(() => {
  if (process.platform === 'win32') Object.defineProperty(process, 'platform', { ...hostPlatform, value: 'linux' });
});
afterAll(() => { Object.defineProperty(process, 'platform', hostPlatform); });


const project = fs.mkdtempSync(path.join(os.tmpdir(), 'tars-role-routes-'));
const TOOL_BLOCK = '--disallowed-tools "Edit" "Write" "NotebookEdit" "Task"';

afterAll(() => fs.rmSync(project, { recursive: true, force: true }));

function routes(): RouteApp {
  const app: RouteApp = {
    routes: [],
    add(method, pattern, handler) { this.routes.push({ method, pattern, handler }); },
    get(pattern, handler) { this.add('GET', pattern, handler); },
    post(pattern, handler) { this.add('POST', pattern, handler); },
    put(pattern, handler) { this.add('PUT', pattern, handler); },
    delete(pattern, handler) { this.add('DELETE', pattern, handler); },
  };
  registerAgentRoutes(app, {
    mainWindow: null,
    appSettings: {} as AppSettings,
    getAppSettings: () => ({} as AppSettings),
    getTelegramBot: () => null,
    getSlackApp: () => null,
    slackResponseChannel: null,
    slackResponseThreadTs: null,
    handleStatusChangeNotificationCallback: vi.fn(),
    sendNotificationCallback: vi.fn(),
    initAgentPtyCallback: vi.fn(async () => 'unused'),
    agentStatusEmitter: new EventEmitter(),
  } as RouteContext);
  return app;
}

function agent(id: string, fields: Partial<AgentStatus> = {}): AgentStatus {
  const record = {
    id, name: id, status: 'idle', projectPath: project, skills: [], output: [],
    lastActivity: new Date().toISOString(), provider: 'claude', permissionMode: 'bypass',
    role: 'worker', orchestratorMode: false, ...fields,
  } as AgentStatus;
  agents.set(id, record);
  return record;
}

async function call(method: string, match: (pattern: string) => boolean, pathname: string,
  params: Record<string, string>, body: Record<string, unknown>, callerAgentId: string) {
  const route = routes().routes.find(r => r.method === method && match(String(r.pattern)))!;
  const answers: Array<{ body: Record<string, unknown>; status?: number }> = [];
  await route.handler({
    method, pathname, url: new URL(`http://localhost${pathname}`), body, raw: {} as never, res: {} as never,
    params, callerAgentId,
  } as unknown as RouteRequest, (json, status) => { answers.push({ body: json as Record<string, unknown>, status }); });
  return answers[0];
}

/** The command a /dispatch to an agent with no session typed into its new terminal. */
async function dispatchedCommand(id: string): Promise<string> {
  const answer = await call('POST', p => p.includes('dispatch'), `/api/agents/${id}/dispatch`,
    { id }, { message: 'Rebase onto main' }, id);
  expect(answer?.status ?? 200, JSON.stringify(answer?.body)).toBe(200);
  const spawn = vi.mocked(pty.spawn).mock.calls.at(-1)!;
  return (spawn[1] as string[])[2];
}

const bootstrap = async (id: string) =>
  (await call('GET', p => p.includes('bootstrap'), `/api/agents/${id}/bootstrap`, { id }, {}, id))!.body.context as string;

const createAgent = (body: Record<string, unknown>, caller: string) =>
  call('POST', p => p === '/api/agents', '/api/agents', {}, { projectPath: project, ...body }, caller);

beforeEach(() => {
  agents.clear();
  ptyProcesses.clear();
  vi.mocked(pty.spawn).mockClear();
  vi.mocked(restartForSettings).mockClear();
});

describe('a session the API starts', () => {
  it('launches an orchestrator with its instructions and without editing tools, whatever its name', async () => {
    agent('lead', { name: 'Tars-Lead', role: 'orchestrator', orchestratorMode: true });

    const command = await dispatchedCommand('lead');

    expect(command).toContain(`--append-system-prompt-file '${getSuperAgentInstructionsPath()}'`);
    expect(command).toContain(TOOL_BLOCK);
    expect(command).toContain('orchestrator of project');
  });

  it('launches a worker as a worker, even one called orchestrator', async () => {
    agent('named', { name: 'Tars-Orchestrator' });

    const command = await dispatchedCommand('named');

    expect(command).not.toContain('--append-system-prompt-file');
    expect(command).not.toContain('--disallowed-tools');
    expect(command).toContain('worker of project');
    expect(command).toContain('an orchestrator reads your final message');
  });
});

describe('the bootstrap a session reads at start', () => {
  it('gives the orchestration rules to the role, not to the name', async () => {
    agent('lead', { name: 'Tars-Lead', role: 'orchestrator', orchestratorMode: true });
    agent('named', { name: 'Tars-Orchestrator' });

    const lead = await bootstrap('lead');
    const named = await bootstrap('named');

    expect(lead).toContain('## Orchestration rules');
    expect(lead).toContain('orchestrator of project');
    expect(named).toContain('## Working rules');
    expect(named).not.toContain('## Orchestration rules');
  });
});

describe('POST /api/agents', () => {
  it('creates a worker whatever the name says', async () => {
    agent('caller');

    const answer = await createAgent({ name: 'Build Orchestrator' }, 'caller');

    expect(answer!.status ?? 200).toBe(200);
    expect(answer!.body.agent).toMatchObject({ role: 'worker', orchestratorMode: false });
  });

  // The QA's gate of #123: a worker's own token made itself a "Rogue"
  // orchestrator, which demoted and restarted the current one, and with
  // allowCrossProject did the same in another project, in bypass. Only the
  // Agents page makes or unmakes an orchestrator.
  it.each([
    ['a worker', 'caller'],
    ['the orchestrator itself', 'current'],
  ])('refuses to make an orchestrator for %s, and the current one keeps the role', async (_who, caller) => {
    agent('caller');
    const current = agent('current', { role: 'orchestrator', orchestratorMode: true });

    const answer = await createAgent({ name: 'Rogue', role: 'orchestrator' }, caller);

    expect(answer!.status).toBe(403);
    expect(String(answer!.body.error)).toContain('Agents page');
    expect(agents.size, 'an agent was created').toBe(2);
    expect(current).toMatchObject({ role: 'orchestrator', orchestratorMode: true });
    expect(restartForSettings).not.toHaveBeenCalled();
  });

  it("refuses the toggle's old field the same way", async () => {
    const current = agent('current', { role: 'orchestrator', orchestratorMode: true });
    agent('caller');

    const answer = await createAgent({ name: 'Rogue', orchestratorMode: true }, 'caller');

    expect(answer!.status).toBe(403);
    expect(agents.size).toBe(2);
    expect(current.role).toBe('orchestrator');
  });

  it('refuses it in another project too, crossing on purpose and in bypass', async () => {
    agent('caller');
    const elsewhere = path.join(path.dirname(project), 'other-project');
    fs.mkdirSync(elsewhere, { recursive: true });
    const theirs = agent('theirs', { projectPath: elsewhere, role: 'orchestrator', orchestratorMode: true });

    const answer = await createAgent(
      { name: 'Rogue3', role: 'orchestrator', projectPath: elsewhere, allowCrossProject: true, permissionMode: 'bypass' },
      'caller',
    );

    expect(answer!.status).toBe(403);
    expect(String(answer!.body.error)).toContain('Agents page');
    expect(theirs.role).toBe('orchestrator');
    expect(restartForSettings).not.toHaveBeenCalled();
  });

  it('refuses a role that is neither, and creates nothing', async () => {
    agent('caller');

    const answer = await createAgent({ name: 'X', role: 'boss' }, 'caller');

    expect(answer).toEqual({ body: { error: 'Invalid role: boss' }, status: 400 });
    expect(agents.size).toBe(1);
  });
});
