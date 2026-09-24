import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { EventEmitter } from 'events';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

/**
 * AgentStatus.waitingOn: what a waiting agent waits on (#159, "allow npx
 * playwright test?"), from the hook that reports the dialog.
 *
 * How it fails, written before the code (2026-09-24):
 * 1. A permission dialog reads only `waitingReason: permission`: the page can
 *    say the agent waits, not for what.
 * 2. A question (AskUserQuestion) reads as a permission, or without its words.
 * 3. It outlives the wait: the agent went back to work, or idle, and still
 *    says it waits on "npx playwright test". Twelve lines clear waitingReason
 *    by hand; one that forgets this field leaves it standing.
 * 4. The idle prompt, which is a wait on nobody in particular, is given a text.
 * 5. The text is the agent's to choose (a command, a question), so it can carry
 *    terminal controls or a bidirectional override that turns the sentence
 *    around on screen, or be as long as a file. It is flattened and cut.
 * 6. It never reaches the renderer: agents:tick names its fields one by one.
 */

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tars-waiting-on-'));
vi.mock('../../../electron/constants', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return { ...actual, DATA_DIR: tmp, AGENTS_FILE: path.join(tmp, 'agents.json') };
});
vi.mock('electron', () => ({
  app: { getPath: () => tmp, getAppPath: () => tmp, getVersion: () => '1.8.0' },
  BrowserWindow: { getAllWindows: () => [] },
  ipcMain: { handle: () => undefined, on: () => undefined },
  Notification: vi.fn(),
}));
const pushed = vi.hoisted(() => [] as Array<{ channel: string; payload: unknown }>);
vi.mock('../../../electron/utils/broadcast', () => ({
  broadcastToAllWindows: (channel: string, payload: unknown) => { pushed.push({ channel, payload }); },
}));

type AgentStatus = import('../../../electron/types').AgentStatus;
type RouteApp = import('../../../electron/services/api-routes/types').RouteApp;
type RouteContext = import('../../../electron/services/api-routes/types').RouteContext;
let manager: typeof import('../../../electron/core/agent-manager');
let post: (body: Record<string, unknown>) => Promise<void>;

beforeEach(async () => {
  vi.resetModules();
  pushed.length = 0;
  manager = await import('../../../electron/core/agent-manager');
  manager.agents.clear();
  manager.agents.set('a1', {
    id: 'a1', name: 'Worker', status: 'running', projectPath: tmp, output: [], skills: [], provider: 'claude',
    lastActivity: new Date().toISOString(), currentSessionId: 'sess-1',
  } as AgentStatus);
  const { registerHooksRoutes } = await import('../../../electron/services/api-routes/hooks-routes');
  const app: RouteApp = {
    routes: [],
    add(method, pattern, handler) { this.routes.push({ method, pattern, handler }); },
    get(pattern, handler) { this.add('GET', pattern, handler); },
    post(pattern, handler) { this.add('POST', pattern, handler); },
    put(pattern, handler) { this.add('PUT', pattern, handler); },
    delete(pattern, handler) { this.add('DELETE', pattern, handler); },
  };
  const ctx = {
    mainWindow: null, appSettings: {}, getAppSettings: () => ({}), getTelegramBot: () => null, getSlackApp: () => null,
    slackResponseChannel: null, slackResponseThreadTs: null, handleStatusChangeNotificationCallback: vi.fn(),
    sendNotificationCallback: vi.fn(), initAgentPtyCallback: vi.fn(), agentStatusEmitter: new EventEmitter(),
  } as unknown as RouteContext;
  registerHooksRoutes(app, ctx);
  const route = app.routes.find(r => r.pattern === '/api/hooks/status')!;
  post = async body => { await route.handler({ body: { agent_id: 'a1', session_id: 'sess-1', ...body }, params: {} } as never, vi.fn(), ctx); };
});

afterEach(() => {
  manager.stopAgentAutosave();
});

const a1 = () => manager.agents.get('a1')!;

describe('what a waiting agent waits on', () => {
  it('names the command a permission dialog asks about', async () => {
    await post({ status: 'waiting', waiting_reason: 'permission', tool_name: 'Bash', tool_input: { command: 'npx playwright test' } });

    expect(a1().status).toBe('waiting');
    expect(a1().waitingOn).toEqual({ kind: 'permission', text: 'npx playwright test' });
  });

  it('names the file an edit asks about, and the tool when there is nothing else to name', async () => {
    await post({ status: 'waiting', waiting_reason: 'permission', tool_name: 'Write', tool_input: { file_path: '/repo/a.ts', content: 'x' } });
    expect(a1().waitingOn).toEqual({ kind: 'permission', text: 'Write /repo/a.ts' });

    a1().status = 'running';
    await post({ status: 'waiting', waiting_reason: 'permission', tool_name: 'mcp__tars__send_message', tool_input: {} });
    expect(a1().waitingOn).toEqual({ kind: 'permission', text: 'mcp__tars__send_message' });
  });

  it('gives a question its words, and says how many more there are', async () => {
    await post({
      status: 'waiting', waiting_reason: 'permission', tool_name: 'AskUserQuestion',
      tool_input: { questions: [{ question: 'Which port?' }, { question: 'Which name?' }] },
    });

    expect(a1().waitingOn).toEqual({ kind: 'question', text: 'Which port? (and 1 more)' });
  });

  it('is gone once the agent stops waiting, whichever line moved it', async () => {
    await post({ status: 'waiting', waiting_reason: 'permission', tool_name: 'Bash', tool_input: { command: 'ls' } });
    await post({ status: 'running', event: 'PostToolUse' });
    expect(a1().waitingOn).toBeUndefined();

    await post({ status: 'waiting', waiting_reason: 'permission', tool_name: 'Bash', tool_input: { command: 'ls' } });
    a1().status = 'idle';
    expect(a1().waitingOn).toBeUndefined();
  });

  it('is not set for the idle prompt', async () => {
    a1().status = 'idle';
    await post({ status: 'waiting', waiting_reason: 'idle' });

    expect(a1().status).toBe('waiting');
    expect(a1().waitingOn).toBeUndefined();
  });

  it('flattens controls and direction overrides, and cuts a long text', async () => {
    await post({
      status: 'waiting', waiting_reason: 'permission', tool_name: 'Bash',
      tool_input: { command: `echo ‮evil‬\x1b[31m red\nnext\t${'x'.repeat(400)}` },
    });

    const text = a1().waitingOn!.text;
    expect(text).not.toMatch(/[\u0000-\u001f\u007f-\u009f‎‏‪-‮⁦-⁩]/);
    expect(text.startsWith('echo evil [31m red next ')).toBe(true);
    expect(text.length).toBeLessThanOrEqual(200);
  });

  it('reaches the renderer on agents:tick', async () => {
    vi.useFakeTimers();
    try {
      await post({ status: 'waiting', waiting_reason: 'permission', tool_name: 'Bash', tool_input: { command: 'npx playwright test' } });
      const { scheduleTick } = await import('../../../electron/utils/agents-tick');
      scheduleTick();
      await vi.advanceTimersByTimeAsync(600);
    } finally {
      vi.useRealTimers();
    }
    const tick = pushed.filter(p => p.channel === 'agents:tick').at(-1)!.payload as Array<{ id: string; waitingOn?: unknown }>;
    expect(tick.find(t => t.id === 'a1')?.waitingOn).toEqual({ kind: 'permission', text: 'npx playwright test' });
  });
});
