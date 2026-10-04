import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * A kanban note held for an agent's rest, carried across a restart of Tars (RD-REDEMARRAGE.md, 2.3; Noah's yes of
 * 2026-10-05). The note that an agent filed a task, held while its orchestrator works, lived in kanban-routes' memory
 * only: a crash or a quit lost it.
 *
 * How it can fail, written before the code:
 * 19. A held note is not handed to whoever writes the carry-over (so it never reaches the disk), or it is not taken
 *     back at the next launch.
 * 20. Taken back, it is typed mid-turn, or never; or it reads as fresh when it is from before the restart; or it is
 *     handed to the carry-over again once typed.
 */

vi.mock('../../../../electron/core/agent-manager', () => ({ agents: new Map(), saveAgents: vi.fn() }));
vi.mock('../../../../electron/utils/kanban-generate', () => ({ generateTaskFromPrompt: vi.fn() }));
vi.mock('../../../../electron/core/pty-manager', () => ({ ptyProcesses: new Map() }));
vi.mock('../../../../electron/core/agent-pty', () => ({ cliRunningIn: (pty: unknown) => !!pty }));
const dispatched = vi.hoisted(() => [] as Array<{ agentId: string; message: string }>);
vi.mock('../../../../electron/services/api-routes/agent-routes', () => ({
  performDispatch: vi.fn(async (agent: { id: string }, opts: { message: string }, _ctx: unknown, sendJson: (d: unknown, s?: number) => void) => {
    dispatched.push({ agentId: agent.id, message: opts.message });
    sendJson({ success: true }, 200);
  }),
}));
vi.mock('../../../../electron/services/kanban-board', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../../electron/services/kanban-board')>();
  return {
    ...actual,
    createParkedTask: vi.fn(async () => ({ ok: true, value: { id: 't_42', title: 'Fix the flaky spec', status: 'scheduled', assignee: 'tars:unclaimed', projectPath: '/work/tars' } })),
  };
});

type Routes = typeof import('../../../../electron/services/api-routes/kanban-routes');
type Handler = (req: unknown, sendJson: (d: unknown, s?: number) => void) => Promise<void> | void;

let routes: Routes;
let agents: Map<string, Record<string, unknown>>;
let ptys: Map<string, unknown>;
let emitter: typeof import('../../../../electron/services/agent-events');
let handlers: Map<string, Handler>;
let changes: number;

async function start(carried: unknown[] = []): Promise<void> {
  vi.resetModules();
  routes = await import('../../../../electron/services/api-routes/kanban-routes');
  agents = (await import('../../../../electron/core/agent-manager')).agents as never;
  ptys = (await import('../../../../electron/core/pty-manager')).ptyProcesses as never;
  emitter = await import('../../../../electron/services/agent-events');
  agents.clear();
  ptys.clear();
  handlers = new Map();
  const app = {
    get: () => undefined, put: () => undefined, delete: () => undefined,
    post: (pattern: string | RegExp, h: Handler) => { handlers.set(String(pattern), h); },
  };
  routes.registerKanbanRoutes(app as never, {} as never);
  routes.carryKanban(carried as never);
  changes = 0;
  routes.setKanbanQueuesChangedHook(() => { changes += 1; });
}

function put(id: string, extra: Record<string, unknown>) {
  agents.set(id, { id, name: id, projectPath: '/work/tars', status: 'idle', ptyId: `pty-${id}`, ...extra });
  ptys.set(`pty-${id}`, { pid: 1 });
}
const rest = (id: string) => { agents.get(id)!.status = 'idle'; emitter.agentStatusEmitter.emit('fleet-change', id); };

beforeEach(async () => {
  dispatched.length = 0;
  await start();
});

describe('a kanban note held for a busy orchestrator', () => {
  it('19, 20. goes to the carry-over, comes back at the next launch, and is typed once at the rest, as from before', async () => {
    put('orch', { role: 'orchestrator', status: 'running' });
    put('worker', { role: 'worker' });
    await handlers.get('/api/kanban/tasks')!({ callerAgentId: 'worker', body: { title: 'Fix the flaky spec' } }, () => undefined);

    expect(dispatched).toEqual([]);
    expect(changes).toBeGreaterThan(0);
    const owed = routes.owedKanban();
    expect(owed).toEqual([expect.objectContaining({ agentId: 'orch', item: expect.objectContaining({ message: expect.stringContaining('t_42') }) })]);

    await start(JSON.parse(JSON.stringify(owed)));
    put('orch', { role: 'orchestrator', status: 'running' });
    emitter.agentStatusEmitter.emit('fleet-change', 'orch');
    await new Promise((r) => setTimeout(r, 10));
    expect(dispatched, '20. mid-turn: nothing').toEqual([]);

    rest('orch');
    await vi.waitFor(() => expect(dispatched).toHaveLength(1));
    expect(dispatched[0]).toMatchObject({ agentId: 'orch', message: expect.stringMatching(/t_42[\s\S]*|before Tars restarted/) });
    expect(dispatched[0].message).toMatch(/before Tars restarted/);
    expect(routes.owedKanban()).toEqual([]);

    rest('orch');
    await new Promise((r) => setTimeout(r, 10));
    expect(dispatched).toHaveLength(1);
  });
});
