import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * The note the error triage sends a project's orchestrator when it has filed
 * Sentry's errors on that project's board (services/error-triage.ts). It is
 * Tars's own note, typed through the kanban's queue like the landing note of a
 * task an agent filed.
 *
 * How it can fail, written before the code:
 * 1. it reaches another project's orchestrator, or a worker of the project;
 * 2. it is typed under an agent's name, or under any sender but Tars;
 * 3. it is typed mid-turn or into a permission dialog, or it starts an
 *    orchestrator whose CLI is not running: a note waits for rest, and never
 *    starts anybody;
 * 4. a project named with a trailing slash reaches nobody, or a project with
 *    no orchestrator throws.
 */

vi.mock('../../../../electron/core/agent-manager', () => ({ agents: new Map(), saveAgents: vi.fn() }));
vi.mock('../../../../electron/utils/kanban-generate', () => ({ generateTaskFromPrompt: vi.fn() }));
vi.mock('../../../../electron/core/pty-manager', () => ({ ptyProcesses: new Map() }));
vi.mock('../../../../electron/core/agent-pty', () => ({ cliRunningIn: (pty: unknown) => !!pty }));
const dispatched = vi.hoisted(() => [] as Array<{ agentId: string; message: string; from: string; sender: unknown }>);
vi.mock('../../../../electron/services/api-routes/agent-routes', () => ({
  performDispatch: vi.fn(async (agent: { id: string }, opts: { message: string; from: string; sender: unknown }, _ctx: unknown, sendJson: (d: unknown, s?: number) => void) => {
    dispatched.push({ agentId: agent.id, message: opts.message, from: opts.from, sender: opts.sender });
    sendJson({ success: true }, 200);
  }),
}));

import { registerKanbanRoutes, tellOrchestratorAsTars } from '../../../../electron/services/api-routes/kanban-routes';
import { agents } from '../../../../electron/core/agent-manager';
import { ptyProcesses } from '../../../../electron/core/pty-manager';
import { agentStatusEmitter } from '../../../../electron/services/agent-events';
import type { RouteApp, RouteContext } from '../../../../electron/services/api-routes/types';
import type { AgentStatus } from '../../../../electron/types';

const TARS = '/work/tars';
const OTHER = '/work/other';
const NOTE = 'Sentry reported an error in Tars that nobody has looked at yet: kanban task t_1 (TARS-1), parked.';

function agent(id: string, projectPath: string, extra: Partial<AgentStatus> = {}): AgentStatus {
  return { id, name: id, projectPath, status: 'idle', ptyId: `pty-${id}`, ...extra } as AgentStatus;
}

function put(...list: AgentStatus[]) {
  for (const a of list) {
    agents.set(a.id, a);
    if (a.ptyId) (ptyProcesses as Map<string, unknown>).set(a.ptyId, { pid: 1 });
  }
}

beforeEach(() => {
  agents.clear();
  (ptyProcesses as Map<string, unknown>).clear();
  dispatched.length = 0;
  const app = { routes: [], add() {}, get() {}, post() {}, put() {}, delete() {} } as unknown as RouteApp;
  registerKanbanRoutes(app, {} as RouteContext);
});

describe("the error triage's note", () => {
  it("1, 2. reaches the project's orchestrator alone, as Tars", async () => {
    // The worker and the other project's orchestrator first: found first, they would be the ones told.
    put(
      agent('qa-tars', TARS, { role: 'worker' }),
      agent('orch-other', OTHER, { role: 'orchestrator' }),
      agent('orch-tars', TARS, { role: 'orchestrator' }),
    );

    tellOrchestratorAsTars(TARS, NOTE);

    await vi.waitFor(() => expect(dispatched).toHaveLength(1));
    expect(dispatched[0]).toEqual({ agentId: 'orch-tars', message: NOTE, from: 'Tars', sender: { kind: 'tars' } });
  });

  it('3. waits for a turn to end before it is typed', async () => {
    const orch = agent('orch-tars', TARS, { role: 'orchestrator', status: 'running' });
    put(orch);

    tellOrchestratorAsTars(TARS, NOTE);
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(dispatched).toEqual([]);

    orch.status = 'idle';
    agentStatusEmitter.emit('fleet-change', orch.id);
    await vi.waitFor(() => expect(dispatched).toHaveLength(1));
    expect(dispatched[0].agentId).toBe('orch-tars');
  });

  it('3. never starts an orchestrator whose CLI is not running', async () => {
    put(agent('orch-tars', TARS, { role: 'orchestrator', ptyId: undefined }));

    tellOrchestratorAsTars(TARS, NOTE);
    await new Promise(resolve => setTimeout(resolve, 20));

    expect(dispatched).toEqual([]);
  });

  it('4. finds the orchestrator of a project named with a trailing slash, and does nothing where there is none', async () => {
    put(agent('orch-tars', TARS, { role: 'orchestrator' }));

    expect(() => tellOrchestratorAsTars(OTHER, NOTE)).not.toThrow();
    tellOrchestratorAsTars(`${TARS}/`, NOTE);

    await vi.waitFor(() => expect(dispatched).toHaveLength(1));
    expect(dispatched[0].agentId).toBe('orch-tars');
  });
});
