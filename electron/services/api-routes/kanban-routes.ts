import { generateTaskFromPrompt } from '../../utils/kanban-generate';
import { RouteApp, RouteContext, RouteRequest, SendJson } from './types';
import { agents } from '../../core/agent-manager';
import { ptyProcesses } from '../../core/pty-manager';
import { cliRunningIn } from '../../core/agent-pty';
import * as fs from 'fs';
import { HERMES_CONNECTION_FILE, usableHermesConnection } from '../hermes-config';
import {
  addHermesTaskComment, createHermesTask, deleteHermesTask, fetchHermesBoard, getHermesTask, updateHermesTask,
} from '../hermes-client';
import {
  claimTask, completeTask, createParkedTask, deleteTask, getTask, listTasks, moveTask, reportProgress,
  type AgentColumn, type AgentTask, type KanbanCaller, type KanbanHermes, type KanbanResult,
} from '../kanban-board';
import { performDispatch } from './agent-routes';
import type { AgentStatus } from '../../types';

/**
 * The Hermes board through hermes-client, or null when nobody configured one.
 *
 * Configured means the connection file exists. Without it, readHermesConnection()
 * answers the default port, which on Noah's machine is an SSH tunnel to his real
 * Hermes: a sandbox or a test home with a kanban-tasks.json and no connection of
 * its own would have moved its tasks onto that board at launch.
 */
export function hermesKanban(): KanbanHermes | null {
  if (!fs.existsSync(HERMES_CONNECTION_FILE)) return null;
  const conn = usableHermesConnection();
  if (!conn) return null;
  return {
    board: tenant => fetchHermesBoard(conn, undefined, tenant),
    get: id => getHermesTask(conn, id),
    create: task => createHermesTask(conn, task),
    update: (id, patch) => updateHermesTask(conn, id, patch),
    remove: id => deleteHermesTask(conn, id),
    comment: (id, body) => addHermesTaskComment(conn, id, body),
  };
}

/** Who is calling: an agent, from its own token. The kanban tools act for one. */
function callerOf(req: RouteRequest, sendJson: SendJson): (KanbanCaller & { agent: AgentStatus }) | null {
  const agent = req.callerAgentId ? agents.get(req.callerAgentId) : undefined;
  if (!agent) {
    sendJson({ error: 'The kanban tools act for an agent, and this call names none: it needs the agent\'s own token (CLAUDE_MGR_API_TOKEN).' }, 403);
    return null;
  }
  return { agentId: agent.id, name: agent.name, projectPath: agent.projectPath, agent };
}

function answer<T>(sendJson: SendJson, r: KanbanResult<T>, key: string): void {
  if (r.ok) sendJson({ success: true, [key]: r.value });
  else sendJson({ error: r.error }, r.status);
}

const COLUMNS: AgentColumn[] = ['backlog', 'planned', 'ongoing', 'done'];

/**
 * The task, typed into the agent it was handed to, as Tars: the line before it
 * says it is from Tars, which is who verified the hand-off. Only into a CLI
 * that runs: performDispatch starts a session otherwise, with the task as its
 * first prompt, which is what handing work to an agent means.
 */
function handOff(target: AgentStatus, task: AgentTask, by: KanbanCaller, ctx: RouteContext): void {
  const message = [
    `Kanban task ${task.id} is yours, handed to you by ${by.name || by.agentId}: ${task.title}`,
    task.description,
    `Report progress with update_task_progress and finish with mark_task_done (task_id ${task.id}).`,
  ].filter(Boolean).join('\n\n');
  let status = 0; let error = '';
  void performDispatch(target, { message, from: 'Tars', sender: { kind: 'tars' } }, ctx, (data, code) => {
    status = code ?? 200;
    error = (data as { error?: string })?.error ?? '';
  }).then(() => {
    if (status >= 400) console.warn(`[kanban] ${task.id} is claimed for ${target.name || target.id} but did not reach it: ${error}`);
  }, err => console.warn(`[kanban] ${task.id} is claimed for ${target.name || target.id} but did not reach it:`, err));
}

/**
 * A task that lands on a project is told to that project's orchestrator, whose
 * job is to hand work out: only one that runs now, never started for a note.
 */
function tellOrchestrator(creator: KanbanCaller, task: AgentTask, ctx: RouteContext): void {
  const orchestrator = [...agents.values()].find(a => a.role === 'orchestrator' && a.projectPath === creator.projectPath && a.id !== creator.agentId);
  const pty = orchestrator?.ptyId ? ptyProcesses.get(orchestrator.ptyId) : undefined;
  if (!orchestrator || !cliRunningIn(pty)) return;
  const message = `${creator.name || creator.agentId} filed a task on this project's Kanban board: ${task.title} (${task.id}). It is parked, and Hermes will not take it. Hand it to one of your agents with assign_task (task_id ${task.id}, agent_id), or leave it for Noah.`;
  void performDispatch(orchestrator, { message, from: 'Tars', sender: { kind: 'tars' } }, ctx, () => undefined)
    .catch(err => console.warn('[kanban] the orchestrator was not told of a new task:', err));
}

export function registerKanbanRoutes(app: RouteApp, ctx: RouteContext): void {
  // POST /api/kanban/generate
  app.post('/api/kanban/generate', async (req, sendJson) => {
    const { prompt, availableProjects } = req.body as {
      prompt: string;
      availableProjects: Array<{ path: string; name: string }>;
    };

    if (!prompt) {
      sendJson({ error: 'prompt is required' }, 400);
      return;
    }

    const task = await generateTaskFromPrompt(prompt, availableProjects);
    sendJson({ success: true, task });
  });

  // ── The agents' kanban tools (mcp-kanban), on the Hermes board ──────────
  // Every route acts for the agent whose token made the call, on its own
  // project's tasks: kanban-board.ts decides what it may do.

  // GET /api/kanban/tasks?column=backlog&mine=1
  app.get('/api/kanban/tasks', async (req, sendJson) => {
    const caller = callerOf(req, sendJson);
    if (!caller) return;
    const column = req.url.searchParams.get('column') || undefined;
    if (column && !COLUMNS.includes(column as AgentColumn)) {
      sendJson({ error: `column must be one of ${COLUMNS.join(', ')}` }, 400);
      return;
    }
    const mine = ['1', 'true'].includes(req.url.searchParams.get('mine') ?? '');
    answer(sendJson, await listTasks(hermesKanban(), caller, { column: column as AgentColumn | undefined, mine }), 'tasks');
  });

  // POST /api/kanban/tasks
  app.post('/api/kanban/tasks', async (req, sendJson) => {
    const caller = callerOf(req, sendJson);
    if (!caller) return;
    const b = req.body as { title?: string; description?: string; project_path?: string; priority?: 'low' | 'medium' | 'high'; labels?: string[] };
    const r = await createParkedTask(hermesKanban(), caller, {
      title: String(b.title ?? ''), description: String(b.description ?? ''), projectPath: b.project_path,
      priority: b.priority, labels: Array.isArray(b.labels) ? b.labels.map(String) : undefined,
    });
    answer(sendJson, r, 'task');
    if (r.ok) tellOrchestrator(caller, r.value, ctx);
  });

  // GET /api/kanban/tasks/:id
  app.get(/^\/api\/kanban\/tasks\/([^/]+)$/, async (req, sendJson) => {
    const caller = callerOf(req, sendJson);
    if (!caller) return;
    answer(sendJson, await getTask(hermesKanban(), caller, req.params.id), 'task');
  });

  // POST /api/kanban/tasks/:id/claim { agent_id? }
  app.post(/^\/api\/kanban\/tasks\/([^/]+)\/claim$/, async (req, sendJson) => {
    const caller = callerOf(req, sendJson);
    if (!caller) return;
    const wanted = (req.body as { agent_id?: string }).agent_id;
    let target: AgentStatus | undefined;
    if (wanted && wanted !== caller.agentId) {
      target = agents.get(wanted);
      if (!target) {
        sendJson({ error: `No agent ${wanted} in Tars.` }, 404);
        return;
      }
    }
    const r = await claimTask(hermesKanban(), caller, req.params.id,
      target ? { agentId: target.id, name: target.name, projectPath: target.projectPath } : undefined);
    answer(sendJson, r, 'task');
    if (r.ok && target) handOff(target, r.value, caller, ctx);
  });

  // POST /api/kanban/tasks/:id/progress { progress }
  app.post(/^\/api\/kanban\/tasks\/([^/]+)\/progress$/, async (req, sendJson) => {
    const caller = callerOf(req, sendJson);
    if (!caller) return;
    answer(sendJson, await reportProgress(hermesKanban(), caller, req.params.id, Number((req.body as { progress?: number }).progress)), 'task');
  });

  // POST /api/kanban/tasks/:id/done { summary }
  app.post(/^\/api\/kanban\/tasks\/([^/]+)\/done$/, async (req, sendJson) => {
    const caller = callerOf(req, sendJson);
    if (!caller) return;
    answer(sendJson, await completeTask(hermesKanban(), caller, req.params.id, String((req.body as { summary?: string }).summary ?? '')), 'task');
  });

  // POST /api/kanban/tasks/:id/move { column }
  app.post(/^\/api\/kanban\/tasks\/([^/]+)\/move$/, async (req, sendJson) => {
    const caller = callerOf(req, sendJson);
    if (!caller) return;
    const column = (req.body as { column?: string }).column as AgentColumn;
    if (!COLUMNS.includes(column)) {
      sendJson({ error: `column must be one of ${COLUMNS.join(', ')}` }, 400);
      return;
    }
    answer(sendJson, await moveTask(hermesKanban(), caller, req.params.id, column), 'task');
  });

  // DELETE /api/kanban/tasks/:id
  app.delete(/^\/api\/kanban\/tasks\/([^/]+)$/, async (req, sendJson) => {
    const caller = callerOf(req, sendJson);
    if (!caller) return;
    answer(sendJson, await deleteTask(hermesKanban(), caller, req.params.id), 'task');
  });
}
