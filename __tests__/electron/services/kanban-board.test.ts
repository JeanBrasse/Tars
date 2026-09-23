import { describe, it, expect, beforeEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  PARKED, TARS_LANE, laneOf, columnOf,
  listTasks, getTask, createParkedTask, claimTask, reportProgress, completeTask, moveTask, deleteTask,
  migrateLocalTasks, type KanbanHermes, type KanbanCaller,
} from '../../../electron/services/kanban-board';

/**
 * The agents' kanban, on the Hermes board.
 *
 * The board lives in Hermes. What Tars adds is where an agent's task sits on it
 * and who may move it. Measured against Hermes 0.21.1's own code, in a throwaway
 * HERMES_HOME (scratchpad kanban/probe_hermes.py):
 * - the dispatcher spawns `ready` tasks whose assignee is a Hermes profile;
 * - it promotes `todo` (and `blocked` with no block event) to `ready` on its own;
 * - the gateway decomposes `triage` tasks with its aux model (`auto_decompose`,
 *   on in Noah's config);
 * - `scheduled` is never dispatched or promoted: only an explicit unblock
 *   moves it;
 * - a `ready` task assigned to something that cannot be a Hermes profile
 *   (profile ids are `[a-z0-9][a-z0-9_-]*`, so never with a colon) is skipped
 *   as `skipped_nonspawnable`;
 * - the API refuses `running`, and `done` from `scheduled`.
 *
 * So a parked task is `scheduled` on the Tars lane, and a claimed one is
 * `ready` on its agent's lane (`tars:<agent id>`): Hermes takes neither.
 *
 * How this can fail, written before the code:
 * 1. a task an agent creates is left where Hermes takes it: ready, todo or triage,
 *    or ready on no lane in the moment between its creation and its parking;
 * 2. two agents claim the same parked task at the same time and both are told it is theirs;
 * 3. a claim leaves the task, even for one request, ready with no lane or on a Hermes profile;
 * 4. an agent claims, completes, moves or deletes a task of another project, one another
 *    agent holds, or one Noah handed to Hermes;
 * 5. moving a task to planned hands it to Hermes from an agent: that is Noah's choice;
 * 6. completing a parked task fails on Hermes's refusal instead of saying to claim it;
 * 7. releasing a task (back to backlog) passes through ready with no lane;
 * 8. Hermes not configured or unreachable: a fallback to the local file, or an error
 *    that says nothing the agent can act on;
 * 9. an id prefix picks a task of another project, or one of two it matches;
 * 10. the migration of the local board duplicates tasks when run twice, moves done
 *     tasks, touches the local file, or leaves a task where Hermes takes it;
 * 11. assigning a task to another agent: a target of another project or unknown is
 *     accepted, or the claim is made and the task never reaches the agent.
 */

// ── A Hermes board that answers the way the measured one does ─────────────

interface FakeTask {
  id: string; title: string; body: string | null; status: string; assignee: string | null;
  priority: number; tenant: string | null; idempotency_key: string | null; result?: string | null;
}

class FakeHermes implements KanbanHermes {
  tasks = new Map<string, FakeTask>();
  comments = new Map<string, Array<{ body: string }>>();
  /** Every status each task passed through, in order, with its assignee at the time. */
  history = new Map<string, Array<{ status: string; assignee: string | null }>>();
  seq = 0;
  /** A yield inside each call, so that concurrent callers interleave as they would over HTTP. */
  latencyMs = 0;
  down = false;

  private async tick() {
    if (this.down) throw new Error('connect ECONNREFUSED 127.0.0.1:8642');
    await new Promise(r => setTimeout(r, this.latencyMs));
  }
  private record(t: FakeTask) {
    const h = this.history.get(t.id) ?? [];
    h.push({ status: t.status, assignee: t.assignee });
    this.history.set(t.id, h);
  }

  async board(tenant?: string) {
    await this.tick();
    const names = ['triage', 'todo', 'scheduled', 'ready', 'running', 'blocked', 'review', 'done'];
    const all = [...this.tasks.values()].filter(t => tenant === undefined || t.tenant === tenant);
    return { success: true as const, board: { columns: names.map(name => ({ name, tasks: all.filter(t => t.status === name).map(t => ({ ...t })) })) } };
  }
  async get(id: string) {
    await this.tick();
    const t = this.tasks.get(id);
    if (!t) return { success: false as const, error: `task ${id} not found` };
    return { success: true as const, detail: { task: { ...t }, comments: [...(this.comments.get(id) ?? [])] } };
  }
  async create(body: Record<string, unknown>) {
    await this.tick();
    const key = (body.idempotency_key as string) || null;
    if (key) {
      const existing = [...this.tasks.values()].find(t => t.idempotency_key === key && t.status !== 'archived');
      if (existing) return { success: true as const, task: { ...existing } };
    }
    const id = `t_${(++this.seq).toString(16).padStart(8, '0')}`;
    const t: FakeTask = {
      id, title: String(body.title), body: (body.body as string) ?? null, status: body.triage ? 'triage' : 'ready',
      assignee: body.assignee ? String(body.assignee).toLowerCase() : null, priority: Number(body.priority ?? 0),
      tenant: (body.tenant as string) ?? null, idempotency_key: key,
    };
    this.tasks.set(id, t); this.record(t);
    return { success: true as const, task: { ...t } };
  }
  async update(id: string, patch: Record<string, unknown>) {
    await this.tick();
    const t = this.tasks.get(id);
    if (!t) return { success: false as const, error: `task ${id} not found` };
    // The gateway applies the assignee first, then the status, in one request.
    if (patch.assignee !== undefined) { t.assignee = patch.assignee ? String(patch.assignee).toLowerCase() : null; this.record(t); }
    const s = patch.status as string | undefined;
    if (s !== undefined) {
      if (s === 'running') return { success: false as const, error: "Cannot set status to 'running' directly; use the dispatcher/claim path" };
      const from = t.status;
      const allowed: Record<string, string[]> = {
        scheduled: ['todo', 'ready', 'running', 'blocked'],
        done: ['running', 'ready', 'blocked', 'review'],
        ready: ['scheduled', 'blocked', 'todo', 'triage', 'ready', 'review'],
        todo: ['scheduled', 'blocked', 'todo', 'triage', 'ready', 'review'],
        triage: ['scheduled', 'blocked', 'todo', 'triage', 'ready', 'review'],
        blocked: ['todo', 'ready', 'running'],
      };
      if (!(allowed[s] ?? []).includes(from)) return { success: false as const, error: `status transition to '${s}' not valid from current state` };
      t.status = s; if (s === 'done') t.result = (patch.result as string) ?? (patch.summary as string) ?? null;
      this.record(t);
    }
    return { success: true as const, task: { ...t } };
  }
  async remove(id: string) {
    await this.tick();
    return this.tasks.delete(id) ? { success: true as const } : { success: false as const, error: `task ${id} not found` };
  }
  async comment(id: string, body: string) {
    await this.tick();
    const c = this.comments.get(id) ?? []; c.push({ body }); this.comments.set(id, c);
    return { success: true as const };
  }

  /** What Hermes's dispatcher would start: ready on a Hermes profile (no colon). */
  spawnable() {
    return [...this.tasks.values()].filter(t => t.status === 'ready' && !!t.assignee && /^[a-z0-9][a-z0-9_-]*$/.test(t.assignee)).map(t => t.id);
  }
  /** Every moment a task spent where Hermes would take it or promote it. */
  exposures(id: string) {
    return (this.history.get(id) ?? []).filter(h =>
      (h.status === 'ready' && (!h.assignee || /^[a-z0-9][a-z0-9_-]*$/.test(h.assignee)))
      || h.status === 'todo' || h.status === 'triage');
  }
}

const TARS = '/Users/noah/tars';
const OTHER = '/Users/noah/1212-capital';
const dune: KanbanCaller = { agentId: 'aaaa1111-0000-4000-8000-000000000001', name: 'Dune', projectPath: TARS };
const dove: KanbanCaller = { agentId: 'bbbb2222-0000-4000-8000-000000000002', name: 'Dove', projectPath: TARS };
const far: KanbanCaller = { agentId: 'cccc3333-0000-4000-8000-000000000003', name: 'Far', projectPath: OTHER };

let h: FakeHermes;
beforeEach(() => { h = new FakeHermes(); });

async function parked(caller = dune, title = 'Measure the Usage page') {
  const r = await createParkedTask(h, caller, { title, description: 'Where the four seconds go.' });
  if (!r.ok) throw new Error(r.error);
  return r.value.id;
}

describe('1. a task an agent creates arrives parked, and never where Hermes takes it', () => {
  it('is scheduled on the Tars lane, in its project, and was never ready on no lane', async () => {
    const id = await parked();
    const t = h.tasks.get(id)!;
    expect(t.status).toBe(PARKED);
    expect(t.status).toBe('scheduled');
    expect(t.assignee).toBe(TARS_LANE);
    expect(t.tenant).toBe(TARS);
    expect(h.exposures(id), 'a moment where Hermes could have taken it').toEqual([]);
    expect(h.spawnable()).toEqual([]);
  });

  it('keeps the title, the description and the priority', async () => {
    const r = await createParkedTask(h, dune, { title: 'T', description: 'D', priority: 'high', labels: ['perf', 'ui'] });
    expect(r.ok).toBe(true);
    const t = h.tasks.get(r.ok ? r.value.id : '')!;
    expect(t.title).toBe('T');
    expect(t.body).toContain('D');
    expect(t.body).toContain('perf, ui');
    expect(t.priority).toBeGreaterThan(0);
  });

  it('refuses a project that is not the agent\'s own, and takes a worktree of it as the project', async () => {
    const outside = await createParkedTask(h, dune, { title: 'T', description: 'D', projectPath: OTHER });
    expect(outside.ok).toBe(false);
    expect(outside.ok ? 0 : outside.status).toBe(403);
    const inside = await createParkedTask(h, dune, { title: 'T', description: 'D', projectPath: `${TARS}/.worktrees/p138` });
    expect(inside.ok).toBe(true);
    expect(h.tasks.get(inside.ok ? inside.value.id : '')!.tenant).toBe(TARS);
  });
});

describe('2. a claim is atomic: two agents at once, one wins', () => {
  it('gives the task to one agent and a clear refusal to the other', async () => {
    const id = await parked();
    h.latencyMs = 5; // every call yields, as over HTTP
    const [a, b] = await Promise.all([claimTask(h, dune, id), claimTask(h, dove, id)]);
    const won = [a, b].filter(r => r.ok);
    const lost = [a, b].filter(r => !r.ok);
    expect(won).toHaveLength(1);
    expect(lost).toHaveLength(1);
    expect(lost[0].ok ? 0 : lost[0].status).toBe(409);
    expect(lost[0].ok ? '' : lost[0].error).toMatch(/already claimed by (Dune|Dove)/);
    const t = h.tasks.get(id)!;
    expect([laneOf(dune.agentId), laneOf(dove.agentId)]).toContain(t.assignee);
    expect(t.status).toBe('ready');
  });

  it('is idempotent for the agent that holds it', async () => {
    const id = await parked();
    expect((await claimTask(h, dune, id)).ok).toBe(true);
    expect((await claimTask(h, dune, id)).ok).toBe(true);
  });
});

describe('3. a claimed task is never where Hermes takes it', () => {
  it('goes to ready only on the agent\'s lane, never on no lane', async () => {
    const id = await parked();
    await claimTask(h, dune, id);
    expect(h.tasks.get(id)!.assignee).toBe(laneOf(dune.agentId));
    expect(h.exposures(id)).toEqual([]);
    expect(h.spawnable()).toEqual([]);
  });

  it('names a lane that can never be a Hermes profile', () => {
    expect(laneOf(dune.agentId)).toMatch(/^tars:/);
    expect(/^[a-z0-9][a-z0-9_-]*$/.test(laneOf(dune.agentId))).toBe(false);
    expect(/^[a-z0-9][a-z0-9_-]*$/.test(TARS_LANE)).toBe(false);
  });
});

describe('4. an agent acts only on its own project\'s tasks, and not on one another agent or Hermes holds', () => {
  it('does not see or reach another project\'s task', async () => {
    const id = await parked(far, 'Theirs');
    const list = await listTasks(h, dune, {});
    expect(list.ok && list.value.map(t => t.id)).toEqual([]);
    for (const act of [() => claimTask(h, dune, id), () => getTask(h, dune, id), () => deleteTask(h, dune, id), () => completeTask(h, dune, id, 'x')]) {
      const r = await act();
      expect(r.ok).toBe(false);
      expect(r.ok ? 0 : r.status).toBe(404);
    }
  });

  it('refuses progress, completion, release and deletion of a task another agent holds', async () => {
    const id = await parked();
    await claimTask(h, dune, id);
    for (const act of [() => reportProgress(h, dove, id, 50), () => completeTask(h, dove, id, 'x'), () => moveTask(h, dove, id, 'backlog'), () => deleteTask(h, dove, id)]) {
      const r = await act();
      expect(r.ok).toBe(false);
      expect(r.ok ? '' : r.error).toMatch(/Dune/);
    }
    expect(h.tasks.get(id)!.assignee).toBe(laneOf(dune.agentId));
  });

  it('refuses to claim a task Noah handed to Hermes', async () => {
    const created = await h.create({ title: 'For Hermes', tenant: TARS, assignee: 'coder' });
    const r = await claimTask(h, dune, created.task!.id);
    expect(r.ok).toBe(false);
    expect(r.ok ? '' : r.error).toMatch(/Hermes/);
    expect(h.tasks.get(created.task!.id)!.assignee).toBe('coder');
  });
});

describe('5. handing a task to Hermes is Noah\'s choice', () => {
  it('refuses planned from an agent and leaves the task where it was', async () => {
    const id = await parked();
    const r = await moveTask(h, dune, id, 'planned');
    expect(r.ok).toBe(false);
    expect(r.ok ? '' : r.error).toMatch(/Noah/);
    expect(h.tasks.get(id)!.status).toBe('scheduled');
  });
});

describe('6. completing', () => {
  it('completes a task the agent holds, with its summary', async () => {
    const id = await parked();
    await claimTask(h, dune, id);
    const r = await completeTask(h, dune, id, 'Found it: the transcript scan.');
    expect(r.ok).toBe(true);
    expect(h.tasks.get(id)!.status).toBe('done');
    expect(h.tasks.get(id)!.result).toContain('transcript scan');
  });

  it('says to claim a parked task first, rather than passing on Hermes\'s refusal', async () => {
    const id = await parked();
    const r = await completeTask(h, dune, id, 'x');
    expect(r.ok).toBe(false);
    expect(r.ok ? '' : r.error).toMatch(/assign_task|claim/);
  });

  it('reports progress as a comment of the agent that holds it', async () => {
    const id = await parked();
    await claimTask(h, dune, id);
    expect((await reportProgress(h, dune, id, 40)).ok).toBe(true);
    expect(h.comments.get(id)!.map(c => c.body).join('\n')).toMatch(/40%.*Dune|Dune.*40%/);
  });
});

describe('7. releasing a task', () => {
  it('parks it again on the Tars lane without passing through ready on no lane', async () => {
    const id = await parked();
    await claimTask(h, dune, id);
    const r = await moveTask(h, dune, id, 'backlog');
    expect(r.ok).toBe(true);
    expect(h.tasks.get(id)!.status).toBe('scheduled');
    expect(h.tasks.get(id)!.assignee).toBe(TARS_LANE);
    expect(h.exposures(id)).toEqual([]);
    // And another agent can take it now.
    expect((await claimTask(h, dove, id)).ok).toBe(true);
  });
});

describe('8. Hermes not configured or unreachable', () => {
  it('says Hermes did not answer, and writes nothing anywhere else', async () => {
    h.down = true;
    for (const act of [() => listTasks(h, dune, {}), () => createParkedTask(h, dune, { title: 'T', description: 'D' }), () => claimTask(h, dune, 't_00000001')]) {
      const r = await act();
      expect(r.ok).toBe(false);
      expect(r.ok ? 0 : r.status).toBe(502);
      expect(r.ok ? '' : r.error).toMatch(/Hermes/);
      expect(r.ok ? '' : r.error).toMatch(/ECONNREFUSED/);
    }
  });

  it('says Hermes is not configured when there is no connection', async () => {
    const r = await listTasks(null, dune, {});
    expect(r.ok).toBe(false);
    expect(r.ok ? 0 : r.status).toBe(503);
    expect(r.ok ? '' : r.error).toMatch(/not configured/);
  });
});

describe('9. ids and prefixes', () => {
  it('matches a prefix within the agent\'s project only, and refuses an ambiguous one', async () => {
    const a = await parked(dune, 'A');
    await parked(far, 'Theirs');
    const r = await getTask(h, dune, a.slice(0, 6));
    expect(r.ok && r.value.id).toBe(a);
    await parked(dune, 'B');
    const amb = await getTask(h, dune, 't_');
    expect(amb.ok).toBe(false);
    expect(amb.ok ? '' : amb.error).toMatch(/matches 2 tasks/);
  });

  it('lists in the four columns the tools speak, with who holds each task', async () => {
    const p = await parked(dune, 'Parked');
    const c = await parked(dune, 'Claimed');
    await claimTask(h, dove, c);
    const hermesOwn = (await h.create({ title: 'Hermes has it', tenant: TARS, assignee: 'coder' })).task!.id;
    const list = await listTasks(h, dune, {});
    const byId = Object.fromEntries((list.ok ? list.value : []).map(t => [t.id, t]));
    expect(byId[p].column).toBe('backlog');
    expect(byId[c].column).toBe('ongoing');
    expect(byId[c].holder).toMatch(/Dove/);
    expect(byId[hermesOwn].column).toBe('planned');
    const mine = await listTasks(h, dove, { mine: true });
    expect(mine.ok && mine.value.map(t => t.id)).toEqual([c]);
    expect(columnOf({ status: 'done', assignee: null })).toBe('done');
  });
});

describe('10. the local board moves to Hermes once, parked, and stays as a backup', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tars-kanban-migrate-'));
  const file = path.join(dir, 'kanban-tasks.json');
  const record = path.join(dir, 'kanban-moved-to-hermes.json');
  const local = [
    { id: 'l1', title: '1212 · 0. E2E-first', description: 'Rule', column: 'backlog', projectPath: OTHER, priority: 'high', labels: [] },
    { id: 'l2', title: '1212 · 1. Mesure', description: 'Perf', column: 'planned', projectPath: OTHER, priority: 'medium', labels: ['perf'] },
    { id: 'l3', title: 'Old and done', description: '', column: 'done', projectPath: OTHER, priority: 'low', labels: [] },
  ];

  beforeEach(() => {
    fs.writeFileSync(file, JSON.stringify(local, null, 2));
    fs.rmSync(record, { force: true });
  });

  it('parks every task that is not done, on its project, and leaves the file as it was', async () => {
    const before = fs.readFileSync(file, 'utf-8');
    const r = await migrateLocalTasks(h, file, record);
    expect(r).toMatchObject({ moved: 2, skipped: 0, errors: [] });
    expect(fs.readFileSync(file, 'utf-8')).toBe(before);
    const titles = [...h.tasks.values()].map(t => t.title).sort();
    expect(titles).toEqual(['1212 · 0. E2E-first', '1212 · 1. Mesure']);
    for (const t of h.tasks.values()) {
      expect(t.status).toBe('scheduled');
      expect(t.tenant).toBe(OTHER);
      expect(h.exposures(t.id)).toEqual([]);
    }
  });

  it('moves nothing twice, whether its record or Hermes remembers it', async () => {
    await migrateLocalTasks(h, file, record);
    const again = await migrateLocalTasks(h, file, record);
    expect(again).toMatchObject({ moved: 0, skipped: 2 });
    fs.rmSync(record);
    const third = await migrateLocalTasks(h, file, record);
    expect(h.tasks.size).toBe(2);
    expect(third.errors).toEqual([]);
  });

  it('keeps what it could not move for the next launch', async () => {
    h.down = true;
    const r = await migrateLocalTasks(h, file, record);
    expect(r.moved).toBe(0);
    expect(r.errors.length).toBeGreaterThan(0);
    h.down = false;
    expect((await migrateLocalTasks(h, file, record)).moved).toBe(2);
  });
});

describe('11. assigning a task to another agent', () => {
  it('claims it on the target\'s lane, and says who it is for', async () => {
    const id = await parked();
    const r = await claimTask(h, dune, id, { agentId: dove.agentId, name: dove.name, projectPath: TARS });
    expect(r.ok).toBe(true);
    expect(h.tasks.get(id)!.assignee).toBe(laneOf(dove.agentId));
    expect(r.ok && r.value.holder).toMatch(/Dove/);
  });

  it('refuses a target of another project', async () => {
    const id = await parked();
    const r = await claimTask(h, dune, id, { agentId: far.agentId, name: far.name, projectPath: OTHER });
    expect(r.ok).toBe(false);
    expect(r.ok ? 0 : r.status).toBe(403);
    expect(h.tasks.get(id)!.status).toBe('scheduled');
  });
});
