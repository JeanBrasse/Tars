import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mount, settle, type Mount } from './hook-runtime';
import { useElectronAgents } from '../../src/hooks/useElectron';
import { useKanbanAgentSync } from '../../src/hooks/useElectronKanban';
import type { AgentStatus, AgentTickItem } from '../../src/types/electron';
import type { KanbanTask, KanbanTaskUpdate } from '../../src/types/kanban';

vi.mock('react', async (importOriginal) => ({
  ...(await importOriginal<typeof import('react')>()),
  ...(await import('./hook-runtime')).hooks,
}));

/**
 * A stop, read whole, and no task's end. A stopped agent says who stopped it,
 * when and why (`stoppedBy`, `stoppedAt`, `stopReason`, core/agent-stop.ts),
 * which only its full record carries: the status event and the tick name the
 * status alone. The window read the record again only on agent:complete, which
 * comes when a stopped agent's terminal ends, so an agent stopped with no
 * terminal sent none and read "Stopped", by nobody, for no reason. And the
 * Kanban sync took that same agent:complete for the end of the agent's task,
 * and moved it to done with the terminal's last lines for a summary. Written
 * before the code. How it can fail:
 *
 * The list the pages read (useElectronAgents), as for an error:
 * 1. a status event saying stopped is patched, not read again: the stop's who,
 *    when and why never reach the page;
 * 2. the same through the tick, its event missed: an agent that has just
 *    entered stopped is patched, not read again;
 * 3. over-correction: an agent that stays stopped is read again on every
 *    tick, where entering stopped is read once.
 *
 * The Kanban sync (useKanbanAgentSync), which runs in the local board, and no
 * page mounts that board since Kanban became the Hermes board: these two pin
 * it without the app.
 * 4. agent:complete for a stopped agent moves its ongoing task to done, with a
 *    summary: a stop is no task's end, and the task stays where it is;
 * 5. over-correction: a terminal that ended on its own no longer moves its
 *    task to done.
 */

type Tick = (items: AgentTickItem[]) => void;
type Status = (event: { agentId: string; status: string; timestamp: string }) => void;
type Complete = (event: { agentId: string; exitCode: number }) => void;

const STOP = { stoppedBy: 'Project Lead', stoppedAt: '2026-10-05T18:40:00.000Z', stopReason: 'frozen on a file read for 40 minutes' };

function agent(over: Partial<AgentStatus> = {}): AgentStatus {
  return {
    id: 'a1', name: 'Frontend Engineer', status: 'running', projectPath: '/p', skills: [], output: [],
    lastActivity: '2026-10-05T18:00:00.000Z', currentTask: 'Build the page', provider: 'claude', cliRunning: true,
    ...over,
  } as AgentStatus;
}

function tickItem(a: AgentStatus, over: Partial<AgentTickItem> = {}): AgentTickItem {
  return {
    id: a.id, name: a.name ?? a.id, character: 'robot', status: a.status, displayStatus: 'working', statusLine: '',
    currentTask: a.currentTask ?? '', projectName: 'p', lastActivity: a.lastActivity, provider: 'claude',
    cliRunning: a.cliRunning, leftFullscreen: false, launching: false, ...over,
  } as AgentTickItem;
}

const g = globalThis as unknown as { window?: unknown };

describe('useElectronAgents reads a stop whole', () => {
  let listed: AgentStatus[];
  let list: ReturnType<typeof vi.fn>;
  let tick: Tick | undefined;
  let status: Status | undefined;
  let hook: Mount<ReturnType<typeof useElectronAgents>>;

  beforeEach(async () => {
    listed = [agent(), agent({ id: 'a2', name: 'Writer', status: 'idle', cliRunning: false })];
    list = vi.fn(async () => listed);
    const noop = () => () => {};
    g.window = {
      electronAPI: {
        agent: {
          list,
          onOutput: noop, onError: noop, onComplete: noop,
          onStatus: (cb: Status) => { status = cb; return () => { status = undefined; }; },
          onTick: (cb: Tick) => { tick = cb; return () => { tick = undefined; }; },
        },
      },
    };
    hook = mount(() => useElectronAgents());
    await settle();
    expect(hook.result.agents.map(a => a.status)).toEqual(['running', 'idle']);
  });

  afterEach(() => {
    hook.unmount();
    delete g.window;
  });

  it('a status event saying stopped reads who stopped it, when and why (1)', async () => {
    // An agent stopped with no terminal: no agent:complete follows.
    listed = [listed[0], agent({ id: 'a2', name: 'Writer', status: 'stopped', cliRunning: false, ...STOP })];
    status!({ agentId: 'a2', status: 'stopped', timestamp: STOP.stoppedAt });
    await settle();
    expect(hook.result.agents[1]).toMatchObject({ status: 'stopped', ...STOP });
  });

  it('so does a tick on which the agent has just entered stopped, its event missed (2)', async () => {
    listed = [agent({ status: 'stopped', currentTask: undefined, cliRunning: false, ...STOP }), listed[1]];
    tick!(listed.map(a => tickItem(a)));
    await settle();
    expect(hook.result.agents[0]).toMatchObject({ status: 'stopped', ...STOP });
  });

  it('once: an agent that stays stopped is not read again on every tick (3)', async () => {
    listed = [agent({ status: 'stopped', currentTask: undefined, cliRunning: false, ...STOP }), listed[1]];
    tick!(listed.map(a => tickItem(a)));
    await settle();
    const reads = list.mock.calls.length;
    tick!(listed.map(a => tickItem(a)));
    tick!(listed.map(a => tickItem(a)));
    await settle();
    expect(list.mock.calls.length).toBe(reads);
  });
});

describe('the Kanban sync takes no stop for a task\'s end', () => {
  const TASK: KanbanTask = {
    id: 't1', title: 'Build the page', description: '', column: 'ongoing', projectId: 'p', projectPath: '/p',
    assignedAgentId: 'a1', agentCreatedForTask: false, requiredSkills: [], priority: 'medium', progress: 50,
    createdAt: '2026-10-05T08:00:00.000Z', updatedAt: '2026-10-05T08:00:00.000Z', order: 0, labels: [], attachments: [],
  };
  let complete: Complete | undefined;
  let record: Partial<AgentStatus>;
  let updates: KanbanTaskUpdate[];
  let moves: Array<[string, string]>;
  let hook: Mount<void>;

  beforeEach(async () => {
    updates = [];
    moves = [];
    g.window = {
      electronAPI: {
        agent: {
          onStatus: () => () => {},
          onComplete: (cb: Complete) => { complete = cb; return () => { complete = undefined; }; },
          get: vi.fn(async () => record),
        },
      },
    };
    hook = mount(() => useKanbanAgentSync(
      [TASK],
      async params => { updates.push(params); },
      async (id, column) => { moves.push([id, column]); },
    ));
    await settle();
  });

  afterEach(() => {
    hook.unmount();
    delete g.window;
  });

  it('a stopped agent\'s task stays where it is, and keeps no summary (4)', async () => {
    // The terminal a stop ended: its exit still sends agent:complete.
    record = agent({ status: 'stopped', currentTask: undefined, cliRunning: false, output: ['the last screen\r\n'], ...STOP });
    complete!({ agentId: 'a1', exitCode: 0 });
    await settle();
    expect(moves).toEqual([]);
    expect(updates).toEqual([]);
  });

  it('a terminal that ended on its own still moves its task to done (5)', async () => {
    record = agent({ status: 'completed', cliRunning: false, output: ['all tests pass\r\n'] });
    complete!({ agentId: 'a1', exitCode: 0 });
    await settle();
    expect(moves).toEqual([['t1', 'done']]);
    expect(updates[0]).toMatchObject({ id: 't1', progress: 100, completionSummary: 'all tests pass' });
  });
});
