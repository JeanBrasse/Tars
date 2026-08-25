import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

/**
 * An orchestrator being told, without asking, that its agent has finished.
 *
 * Delegation only went one way: Tars knew an agent had reached a result and
 * had no idea who was waiting on it, so an orchestrator had to keep asking,
 * or arm a shell loop by hand. The day nobody armed one, a QA pass finished
 * and the thread stopped dead.
 *
 * These drive the real chain and assert on the bytes that reach the terminal:
 * the real agents map, the real agent-watch listener, the real pty-manager
 * and its real bracket-paste write. The only stand-in is the pseudo-terminal
 * itself, which is a native device, and it records what it was given.
 */

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tars-agent-watch-'));
vi.mock('../../../electron/constants', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../electron/constants')>();
  return { ...actual, DATA_DIR: tmp, AGENTS_FILE: path.join(tmp, 'agents.json'), dataPath: (f: string) => path.join(tmp, f) };
});

let watch: typeof import('../../../electron/services/agent-watch');
let agentManager: typeof import('../../../electron/core/agent-manager');
let ptyManager: typeof import('../../../electron/core/pty-manager');
let events: typeof import('../../../electron/services/agent-events');

/** Everything the terminal was told to display, in order. */
type FakeTerminal = { id: string; written: string[] };
const terminals: FakeTerminal[] = [];

function attachTerminal(ptyId: string): FakeTerminal {
  const terminal: FakeTerminal = { id: ptyId, written: [] };
  ptyManager.ptyProcesses.set(ptyId, {
    write: (data: string) => { terminal.written.push(data); },
  } as never);
  terminals.push(terminal);
  return terminal;
}

function putAgent(over: Partial<import('../../../electron/types').AgentStatus> & { id: string }): void {
  agentManager.agents.set(over.id, {
    status: 'idle',
    projectPath: '/tars',
    skills: [],
    output: [],
    lastActivity: new Date().toISOString(),
    ...over,
  } as never);
}

/** Move an agent and announce it exactly as the hooks and routes do. */
function move(id: string, status: import('../../../electron/types').AgentStatus['status']): void {
  const agent = agentManager.agents.get(id);
  if (!agent) throw new Error(`no agent ${id}`);
  agent.status = status;
  events.emitAgentStatus(id);
}

/** What the orchestrator's terminal actually received, paste markers removed. */
function received(terminal: FakeTerminal): string {
  return terminal.written.join('').replace(/\x1b\[20[01]~/g, '');
}

beforeEach(async () => {
  vi.resetModules();
  terminals.length = 0;
  agentManager = await import('../../../electron/core/agent-manager');
  ptyManager = await import('../../../electron/core/pty-manager');
  events = await import('../../../electron/services/agent-events');
  watch = await import('../../../electron/services/agent-watch');
  agentManager.agents.clear();
  ptyManager.ptyProcesses.clear();
  watch.resetAgentWatch();
  watch.startAgentWatch();
});

afterEach(() => {
  watch.stopAgentWatch();
  vi.useRealTimers();
});

describe('an agent that was dispatched by another', () => {
  it('tells the orchestrator when it finishes, with nobody having asked', () => {
    const terminal = attachTerminal('pty-orch');
    putAgent({ id: 'orch', name: 'Orchestrator', status: 'idle', ptyId: 'pty-orch' });
    putAgent({ id: 'qa', name: 'QA-Tars', status: 'running', requestedBy: 'orch' });

    move('qa', 'completed');

    const text = received(terminal);
    expect(text).toContain('QA-Tars');
    expect(text).toContain('qa');
    expect(text).toContain('completed');
    // No wait_for_agent, no polling loop: one status transition was enough.
    expect(terminal.written.length).toBeGreaterThan(0);
  });

  it('says so when it fails, not only when it succeeds', () => {
    const terminal = attachTerminal('pty-orch');
    putAgent({ id: 'orch', name: 'Orchestrator', status: 'idle', ptyId: 'pty-orch' });
    putAgent({ id: 'w', name: 'Worker', status: 'running', requestedBy: 'orch' });

    move('w', 'error');

    expect(received(terminal)).toContain('error');
  });

  it('says so when it is blocked on a question', () => {
    const terminal = attachTerminal('pty-orch');
    putAgent({ id: 'orch', name: 'Orchestrator', status: 'idle', ptyId: 'pty-orch' });
    putAgent({ id: 'w', name: 'Worker', status: 'running', requestedBy: 'orch' });

    move('w', 'waiting');

    expect(received(terminal)).toContain('waiting');
  });

  it('stays silent when nobody dispatched it', () => {
    const terminal = attachTerminal('pty-orch');
    putAgent({ id: 'orch', name: 'Orchestrator', status: 'idle', ptyId: 'pty-orch' });
    putAgent({ id: 'lone', name: 'Started by hand', status: 'running' });

    move('lone', 'completed');

    expect(terminal.written).toEqual([]);
  });

  it('never writes to itself', () => {
    const terminal = attachTerminal('pty-self');
    putAgent({ id: 'self', name: 'Self', status: 'running', ptyId: 'pty-self', requestedBy: 'self' });

    move('self', 'completed');

    expect(terminal.written).toEqual([]);
  });

  it('says nothing twice for one transition', () => {
    const terminal = attachTerminal('pty-orch');
    putAgent({ id: 'orch', name: 'Orchestrator', status: 'idle', ptyId: 'pty-orch' });
    putAgent({ id: 'w', name: 'Worker', status: 'running', requestedBy: 'orch' });

    move('w', 'completed');
    const after = terminal.written.length;
    // The hooks post status more than once for the same state.
    events.emitAgentStatus('w');
    events.emitAgentStatus('w');

    expect(terminal.written.length).toBe(after);
  });
});

describe('an orchestrator that is in the middle of something', () => {
  it('is not interrupted, and is told the moment it is free', () => {
    const terminal = attachTerminal('pty-orch');
    putAgent({ id: 'orch', name: 'Orchestrator', status: 'running', ptyId: 'pty-orch' });
    putAgent({ id: 'qa', name: 'QA-Tars', status: 'running', requestedBy: 'orch' });

    move('qa', 'completed');

    // Writing into a busy TUI is what the orchestrator's own rules forbid:
    // it lands in the input box of a turn that is already under way.
    expect(terminal.written).toEqual([]);

    move('orch', 'idle');

    expect(received(terminal)).toContain('QA-Tars');
  });

  it('gets one message for several agents rather than one interruption each', () => {
    const terminal = attachTerminal('pty-orch');
    putAgent({ id: 'orch', name: 'Orchestrator', status: 'running', ptyId: 'pty-orch' });
    putAgent({ id: 'qa', name: 'QA-Tars', status: 'running', requestedBy: 'orch' });
    putAgent({ id: 'fe', name: 'Frontend', status: 'running', requestedBy: 'orch' });
    putAgent({ id: 'be', name: 'Backend', status: 'running', requestedBy: 'orch' });

    move('qa', 'completed');
    move('fe', 'error');
    move('be', 'completed');
    expect(terminal.written).toEqual([]);

    move('orch', 'waiting');

    const text = received(terminal);
    expect(text).toContain('QA-Tars');
    expect(text).toContain('Frontend');
    expect(text).toContain('Backend');
    expect(text).toContain('3 agents');
    // One paste, not three.
    expect(text.split('[Tars]')).toHaveLength(2);
  });

  it('collapses an agent that flaps instead of queueing every flap', () => {
    const terminal = attachTerminal('pty-orch');
    putAgent({ id: 'orch', name: 'Orchestrator', status: 'running', ptyId: 'pty-orch' });
    putAgent({ id: 'w', name: 'Worker', status: 'running', requestedBy: 'orch' });

    for (let i = 0; i < 5; i++) {
      move('w', 'waiting');
      move('w', 'running');
    }
    move('w', 'completed');

    move('orch', 'idle');

    const text = received(terminal);
    // The latest state, once, not eleven lines of history.
    expect(text).toContain('completed');
    expect(text).not.toContain('3 agents');
    expect(text.match(/Worker/g) || []).toHaveLength(1);
  });

  it('does not keep delivering after the queue is drained', () => {
    const terminal = attachTerminal('pty-orch');
    putAgent({ id: 'orch', name: 'Orchestrator', status: 'running', ptyId: 'pty-orch' });
    putAgent({ id: 'w', name: 'Worker', status: 'running', requestedBy: 'orch' });

    move('w', 'completed');
    move('orch', 'idle');
    const delivered = terminal.written.length;

    // The notification wakes the orchestrator up, and it goes round again.
    move('orch', 'running');
    move('orch', 'idle');
    move('orch', 'running');
    move('orch', 'idle');

    expect(terminal.written.length).toBe(delivered);
  });
});

describe('an orchestrator that is gone', () => {
  it('does not throw, and does not hand its results to whatever replaced it', () => {
    putAgent({ id: 'orch', name: 'Orchestrator', status: 'idle', ptyId: 'pty-dead' });
    putAgent({ id: 'w', name: 'Worker', status: 'running', requestedBy: 'orch' });

    // Session killed: the agent record survives, the terminal does not.
    expect(() => move('w', 'completed')).not.toThrow();

    // A fresh session takes the same slot. The dead session's results are not
    // its business, so it must not receive them.
    const replacement = attachTerminal('pty-new');
    const orch = agentManager.agents.get('orch')!;
    orch.ptyId = 'pty-new';
    move('orch', 'idle');

    expect(replacement.written).toEqual([]);
  });

  it('does not throw when the agent record itself is gone', () => {
    putAgent({ id: 'orch', name: 'Orchestrator', status: 'idle', ptyId: 'pty-orch' });
    putAgent({ id: 'w', name: 'Worker', status: 'running', requestedBy: 'orch' });
    agentManager.agents.delete('orch');

    expect(() => move('w', 'completed')).not.toThrow();
  });
});
