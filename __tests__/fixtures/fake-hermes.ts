import type { KanbanHermes } from '../../electron/services/kanban-board';

/**
 * A Hermes board that answers the way the measured one does: Hermes 0.21.1's
 * own kanban code, in a throwaway HERMES_HOME (scratchpad kanban/probe_hermes.py
 * of #171). Its idempotency key hands back the task it made before, a PATCH
 * applies the assignee before the status, the statuses move as the gateway lets
 * them, and a task's detail carries its events, `created` first.
 *
 * Moved out of kanban-board.test.ts so the error triage's tests stand on the
 * same board (error-triage.test.ts).
 */

export interface FakeTask {
  id: string; title: string; body: string | null; status: string; assignee: string | null;
  priority: number; tenant: string | null; idempotency_key: string | null; result?: string | null;
}

export class FakeHermes implements KanbanHermes {
  tasks = new Map<string, FakeTask>();
  comments = new Map<string, Array<{ body: string }>>();
  /** Every status each task passed through, in order, with its assignee at the time. */
  history = new Map<string, Array<{ status: string; assignee: string | null }>>();
  seq = 0;
  /** A yield inside each call, so that concurrent callers interleave as they would over HTTP. */
  latencyMs = 0;
  down = false;
  /** Every status change refused, as a gateway that fails between a create and its park. */
  refuseStatus = false;
  /** A gateway that ignores `?tenant=` and answers with the whole board. */
  ignoreTenant = false;

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
    const all = [...this.tasks.values()].filter(t => this.ignoreTenant || tenant === undefined || t.tenant === tenant);
    return { success: true as const, board: { columns: names.map(name => ({ name, tasks: all.filter(t => t.status === name).map(t => ({ ...t })) })) } };
  }
  async get(id: string) {
    await this.tick();
    const t = this.tasks.get(id);
    if (!t) return { success: false as const, error: `task ${id} not found` };
    const events = (this.history.get(id) ?? []).map((_, i) => ({ kind: i === 0 ? 'created' : 'changed' }));
    return { success: true as const, detail: { task: { ...t }, comments: [...(this.comments.get(id) ?? [])], events } };
  }
  async create(body: Record<string, unknown>) {
    await this.tick();
    const key = (body.idempotency_key as string) || null;
    if (key) {
      const existing = [...this.tasks.values()].find(t => t.idempotency_key === key && t.status !== 'archived');
      if (existing) return { success: true as const, task: { task: { ...existing } } };
    }
    const id = `t_${(++this.seq).toString(16).padStart(8, '0')}`;
    const t: FakeTask = {
      id, title: String(body.title), body: (body.body as string) ?? null, status: body.triage ? 'triage' : 'ready',
      assignee: body.assignee ? String(body.assignee).toLowerCase() : null, priority: Number(body.priority ?? 0),
      tenant: (body.tenant as string) ?? null, idempotency_key: key,
    };
    this.tasks.set(id, t); this.record(t);
    return { success: true as const, task: { task: { ...t } } };
  }
  async update(id: string, patch: Record<string, unknown>) {
    await this.tick();
    const t = this.tasks.get(id);
    if (!t) return { success: false as const, error: `task ${id} not found` };
    // The gateway applies the assignee first, then the status, in one request.
    if (patch.assignee !== undefined) { t.assignee = patch.assignee ? String(patch.assignee).toLowerCase() : null; this.record(t); }
    const s = patch.status as string | undefined;
    if (s !== undefined) {
      if (this.refuseStatus) return { success: false as const, error: 'the gateway is restarting' };
      if (s === 'running') return { success: false as const, error: "Cannot set status to 'running' directly; use the dispatcher/claim path" };
      const from = t.status;
      const allowed: Record<string, string[]> = {
        scheduled: ['todo', 'ready', 'running', 'blocked'],
        done: ['running', 'ready', 'blocked', 'review'],
        ready: ['scheduled', 'blocked', 'todo', 'triage', 'ready', 'review'],
        todo: ['scheduled', 'blocked', 'todo', 'triage', 'ready', 'review'],
        triage: ['scheduled', 'blocked', 'todo', 'triage', 'ready', 'review'],
        blocked: ['todo', 'ready', 'running'],
        // archive_task (kanban_db.py): from any status but archived itself.
        archived: ['triage', 'todo', 'scheduled', 'ready', 'running', 'blocked', 'review', 'done'],
      };
      if (!(allowed[s] ?? []).includes(from)) return { success: false as const, error: `status transition to '${s}' not valid from current state` };
      t.status = s; if (s === 'done') t.result = (patch.result as string) ?? (patch.summary as string) ?? null;
      this.record(t);
    }
    return { success: true as const, task: { task: { ...t } } };
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
