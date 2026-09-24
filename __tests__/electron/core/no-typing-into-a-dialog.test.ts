import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { EventEmitter } from 'events';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

/**
 * Nothing Tars types goes into a dialog its CLI shows.
 *
 * Measured by the Audit on the 1.8.0 tree with real claude 2.1.280, and older
 * than it (1.7.9 has it): a bus message pasted into an open "Do you want to
 * proceed? 1. Yes" dialog, and its Enter said Yes: the command ran and the
 * message was lost. Bypass does not protect: an AskUserQuestion ("Delete the
 * build folder?") was answered "Yes, delete it" by Noah's room post.
 * AskUserQuestion fires PermissionRequest in bypass too, so Tars already knew
 * (waiting, permission): /message answered 409, and the bus, the delegation
 * notes, "send held" and the bots typed anyway (the Audit's census,
 * CENSUS-PERMISSION-WRITES.md).
 *
 * How it fails, written before the code (2026-09-24):
 * 1. A room message to an agent at a dialog is written, and its Enter answers.
 * 2. A delegation note to an orchestrator at a dialog is written.
 * 3. "Send held" (releaseBusMessagesNow) writes into a dialog: it checks no status.
 * 4. A message queued while the agent ran (behind a draft) goes out after a
 *    dialog opened: the check made when it was queued is stale by then.
 * 5. An AskUserQuestion in bypass is not taken for a dialog.
 * 6. What the dialog held back is lost, or delivered before the answer, or
 *    never delivered: it must go in once the agent runs again (PostToolUse).
 * 7. The guard reaches what it must not: a person's keys, and a launch typed
 *    into a bare shell.
 */

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tars-dialog-'));
vi.mock('../../../electron/constants', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../electron/constants')>();
  return {
    ...actual, DATA_DIR: tmp, AGENTS_FILE: path.join(tmp, 'agents.json'), BUS_FILE: path.join(tmp, 'bus.json'),
    dataPath: (f: string) => path.join(tmp, f),
  };
});
const ipcHandlers = new Map<string, (...args: unknown[]) => unknown>();
vi.mock('node-pty', () => ({ spawn: vi.fn() }));
vi.mock('electron', () => ({
  app: { getPath: () => tmp, getAppPath: () => process.cwd() },
  BrowserWindow: { getAllWindows: () => [] },
  ipcMain: { handle: (channel: string, handler: (...args: unknown[]) => unknown) => { ipcHandlers.set(channel, handler); } },
}));
vi.mock('../../../electron/utils/broadcast', () => ({ broadcastToAllWindows: vi.fn() }));

type AgentStatus = import('../../../electron/types').AgentStatus;
let store: typeof import('../../../electron/services/bus-store');
let watch: typeof import('../../../electron/services/agent-watch');
let manager: typeof import('../../../electron/core/agent-manager');
let pty: typeof import('../../../electron/core/pty-manager');
let events: typeof import('../../../electron/services/agent-events');

const ROOM = 'project:/tars';
type FakeTerminal = { written: string[]; readonly typed: string };

function terminalFor(id: string): FakeTerminal {
  const written: string[] = [];
  const fake = { write: (d: string) => { written.push(d); } };
  pty.ptyProcesses.set(`pty-${id}`, fake as never);
  pty.rememberTerminalOwner(fake as never, id);
  return { written, get typed() { return written.join(''); } };
}

function putAgent(over: Partial<AgentStatus> & { id: string }): AgentStatus {
  const agent = {
    name: over.id.toUpperCase(), status: 'idle', provider: 'claude', projectPath: '/tars', skills: [], output: [],
    ptyId: `pty-${over.id}`, currentSessionId: `sess-${over.id}`, lastActivity: new Date().toISOString(), ...over,
  } as AgentStatus;
  manager.agents.set(agent.id, agent);
  return agent;
}

/** The PermissionRequest hook's post: a dialog is up (a permission, or an AskUserQuestion). */
function dialogOpens(id: string): void {
  const a = manager.agents.get(id)!;
  a.status = 'waiting';
  a.waitingReason = 'permission';
  events.emitAgentStatus(id);
}

/** Answered: PostToolUse posts `running`. */
function answered(id: string): void {
  const a = manager.agents.get(id)!;
  a.status = 'running';
  a.waitingReason = undefined;
  events.emitAgentStatus(id);
}

const settle = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

async function noahWrites(text: string, mentions: string[]): Promise<string> {
  const r = await ipcHandlers.get('bus:postMessage')!(null, { roomId: ROOM, text, mentions }) as { success: boolean; error?: string; messageId: string };
  expect(r.success, r.error).toBe(true);
  return r.messageId;
}

beforeEach(async () => {
  vi.resetModules();
  manager = await import('../../../electron/core/agent-manager');
  pty = await import('../../../electron/core/pty-manager');
  events = await import('../../../electron/services/agent-events');
  watch = await import('../../../electron/services/agent-watch');
  store = await import('../../../electron/services/bus-store');
  manager.agents.clear();
  // As main.ts wires it at startup.
  manager.wireDialogProbe();
  pty.ptyProcesses.clear();
  store.resetBusStore();
  fs.rmSync(path.join(tmp, 'bus.json'), { force: true });
  watch.resetAgentWatch();
  watch.startAgentWatch();
  ipcHandlers.clear();
  const { registerBusHandlers } = await import('../../../electron/handlers/bus-handlers');
  registerBusHandlers();
});

afterEach(() => {
  watch.stopAgentWatch();
});

describe('a dialog open in the CLI', { timeout: 30_000 }, () => {
  it('1, 6. holds a room message, never delivered while it is up, and delivers it once the agent runs again', async () => {
    const alpha = terminalFor('alpha');
    putAgent({ id: 'alpha', status: 'idle' });
    dialogOpens('alpha');

    const id = await noahWrites('Clean the build folder, please.', ['alpha']);
    await settle(1500);

    expect(alpha.written, 'typed into the dialog').toEqual([]);
    expect(store.deliveriesOf(id)[0].state).toBe('queued');

    answered('alpha');
    await settle(2500);
    expect(alpha.typed).toContain('Clean the build folder, please.');
    expect(store.deliveriesOf(id)[0].state).toBe('delivered');
  });

  it('2. holds a delegation note to an orchestrator at a dialog', async () => {
    const orch = terminalFor('orch');
    putAgent({ id: 'orch', status: 'idle' });
    putAgent({ id: 'w', name: 'Worker', status: 'running', requestedBy: { agentId: 'orch', ptyId: 'pty-w' } });
    dialogOpens('orch');

    manager.agents.get('w')!.status = 'completed';
    events.emitAgentStatus('w');
    await settle(1500);

    expect(orch.written, 'the note answered the dialog').toEqual([]);
    answered('orch');
    await settle(2500);
    expect(orch.typed).toContain('Worker');
  });

  it('3. writes nothing when "send held" is pressed while a dialog is up', async () => {
    const alpha = terminalFor('alpha');
    putAgent({ id: 'alpha', status: 'idle' });
    dialogOpens('alpha');

    const r = await watch.releaseBusMessagesNow('alpha', [{
      messageId: 'm1', roomId: ROOM, threadId: 't1', authorKind: 'human', authorName: 'Noah', text: 'held for you',
    }]);

    expect(r.written).toEqual([]);
    expect(alpha.written).toEqual([]);
  });

  it('4. does not write, when its turn comes, a message queued before the dialog opened', async () => {
    const alpha = terminalFor('alpha');
    putAgent({ id: 'alpha', status: 'running' });
    const ptyProcess = pty.ptyProcesses.get('pty-alpha')!;
    // Somebody was typing: the message waits for the pause.
    pty.writeHumanInput(ptyProcess, 'x');
    const outcome = pty.writeProgrammaticInput(ptyProcess, 'queued before the dialog', true, { agentId: 'alpha', from: 'QA' });
    expect(outcome).toBe('held');

    dialogOpens('alpha');
    pty.writeHumanInput(ptyProcess, '\x03');
    await settle(pty.TYPING_PAUSE_MS + 1500);

    expect(alpha.typed).not.toContain('queued before the dialog');
    answered('alpha');
    await settle(2500);
    expect(alpha.typed).toContain('queued before the dialog');
    pty.resetTerminalInput(ptyProcess);
  });

  it('5. takes an AskUserQuestion in bypass, as the hook reports it, for a dialog', async () => {
    const alpha = terminalFor('alpha');
    putAgent({ id: 'alpha', status: 'running', permissionMode: 'bypass' });
    const { registerHooksRoutes } = await import('../../../electron/services/api-routes/hooks-routes');
    const routes: Array<{ pattern: unknown; handler: (...a: unknown[]) => unknown }> = [];
    const app = {
      routes, add(_m: string, pattern: unknown, handler: (...a: unknown[]) => unknown) { routes.push({ pattern, handler }); },
      get(p: unknown, h: (...a: unknown[]) => unknown) { this.add('GET', p, h); },
      post(p: unknown, h: (...a: unknown[]) => unknown) { this.add('POST', p, h); },
      put(p: unknown, h: (...a: unknown[]) => unknown) { this.add('PUT', p, h); },
      delete(p: unknown, h: (...a: unknown[]) => unknown) { this.add('DELETE', p, h); },
    };
    const ctx = {
      mainWindow: null, appSettings: {}, getAppSettings: () => ({}), handleStatusChangeNotificationCallback: vi.fn(),
      sendNotificationCallback: vi.fn(), agentStatusEmitter: new EventEmitter(),
    };
    registerHooksRoutes(app as never, ctx as never);
    await routes.find(r => r.pattern === '/api/hooks/status')!.handler({ body: {
      agent_id: 'alpha', session_id: 'sess-alpha', status: 'waiting', waiting_reason: 'permission', tool_name: 'AskUserQuestion',
    }, params: {} }, vi.fn(), ctx);

    await noahWrites('Keep going.', ['alpha']);
    await settle(1500);

    expect(alpha.typed, 'Noah\'s post answered the question').not.toContain('Keep going.');
  });

  it('8. goes in after a person answers the dialog with the arrows and Enter, whose keys never reached the field', async () => {
    // Found by the in-app proof: the keys that answered the question (an arrow,
    // then Enter) were read as keys typed in the field, which the draft model
    // then could not vouch for, and the message waited for ever.
    const alpha = terminalFor('alpha');
    putAgent({ id: 'alpha', status: 'idle' });
    dialogOpens('alpha');
    await noahWrites('After your answer.', ['alpha']);
    const ptyProcess = pty.ptyProcesses.get('pty-alpha')!;

    pty.writeHumanInput(ptyProcess, '\x1b[B');
    pty.writeHumanInput(ptyProcess, '\r');
    answered('alpha');
    await settle(pty.TYPING_PAUSE_MS + 2500);

    expect(alpha.typed).toContain('After your answer.');
    pty.resetTerminalInput(ptyProcess);
  });

  it('7. still passes a person\'s keys, and a launch typed into a bare shell', () => {
    const alpha = terminalFor('alpha');
    putAgent({ id: 'alpha', status: 'idle' });
    dialogOpens('alpha');
    const ptyProcess = pty.ptyProcesses.get('pty-alpha')!;

    pty.writeHumanInput(ptyProcess, '1');
    expect(alpha.written).toEqual(['1']);

    pty.writeProgrammaticInput(ptyProcess, "cd '/tars' && claude", false);
    expect(alpha.typed).toContain("cd '/tars' && claude\r");
    pty.resetTerminalInput(ptyProcess);
  });
});
