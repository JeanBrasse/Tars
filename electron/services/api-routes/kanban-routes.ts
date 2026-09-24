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
  claimTask, completeTask, createParkedTask, deleteTask, getTask, handOffNote, landingNote, listTasks, moveTask,
  reportProgress, whenToType,
  type AgentColumn, type AgentTask, type KanbanCaller, type KanbanHermes, type KanbanResult,
} from '../kanban-board';
import { performDispatch } from './agent-routes';
import { agentStatusEmitter } from '../agent-events';
import type { MessageSender } from '../../core/pty-manager';
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

interface Owed { message: string; sender: MessageSender; purpose: 'work' | 'note'; what: string }

/**
 * What waits for an agent to rest: a hand-off or a note found it mid-turn or
 * in a permission dialog, where nothing is typed (the Backend's gate of #171).
 * Its next status change hands over one, as agent-watch hands over one note
 * per pass, and the next the one after. Bounded, like every queue a person
 * may have to act on before it moves.
 */
const owed = new Map<string, Owed[]>();
const MAX_OWED = 20;

function stateOf(agent: AgentStatus): { cliRunning: boolean; status?: string; waitingReason?: string } {
  const pty = agent.ptyId ? ptyProcesses.get(agent.ptyId) : undefined;
  return { cliRunning: cliRunningIn(pty), status: agent.status, waitingReason: agent.waitingReason };
}

/** Type it now, start the agent with it, hold it until the agent rests, or say nothing. */
function typeInto(agent: AgentStatus, item: Owed, ctx: RouteContext): void {
  const when = whenToType(stateOf(agent), item.purpose);
  if (when === 'skip') return;
  if (when === 'at-rest') {
    const list = owed.get(agent.id) ?? [];
    if (list.length >= MAX_OWED) {
      console.warn(`[kanban] ${agent.name || agent.id} already has ${MAX_OWED} kanban notes waiting; not holding ${item.what}`);
      return;
    }
    list.push(item);
    owed.set(agent.id, list);
    return;
  }
  let status = 0; let error = '';
  void performDispatch(agent, { message: item.message, from: item.sender.kind === 'agent' ? (item.sender.name || item.sender.id) : 'Tars', sender: item.sender }, ctx, (data, code) => {
    status = code ?? 200;
    error = (data as { error?: string })?.error ?? '';
  }).then(() => {
    if (status >= 400) console.warn(`[kanban] ${item.what} did not reach ${agent.name || agent.id}: ${error}`);
  }, err => console.warn(`[kanban] ${item.what} did not reach ${agent.name || agent.id}:`, err));
}

let routeCtx: RouteContext | null = null;
agentStatusEmitter.on('fleet-change', (agentId: string) => {
  const list = owed.get(agentId);
  if (!list?.length || !routeCtx) return;
  const agent = agents.get(agentId);
  if (!agent) { owed.delete(agentId); return; }
  if (whenToType(stateOf(agent), list[0].purpose) !== 'now') return;
  const item = list.shift()!;
  if (!list.length) owed.delete(agentId);
  typeInto(agent, item, routeCtx);
});

/** The task, handed to an agent of the same project: claimed on its lane, then typed as the agent that handed it. */
function handOff(target: AgentStatus, task: AgentTask, by: KanbanCaller, ctx: RouteContext): void {
  typeInto(target, { ...handOffNote(task, by), purpose: 'work', what: `kanban task ${task.id}, claimed for it,` }, ctx);
}

/**
 * A task that lands on a project is told to that project's orchestrator, whose
 * job is to hand work out, as the agent that filed it: only one whose CLI runs,
 * never started for a note, and never mid-turn.
 */
function tellOrchestrator(creator: KanbanCaller, task: AgentTask, ctx: RouteContext): void {
  const orchestrator = [...agents.values()].find(a => a.role === 'orchestrator' && a.projectPath === creator.projectPath && a.id !== creator.agentId);
  if (!orchestrator) return;
  typeInto(orchestrator, { ...landingNote(creator, task), purpose: 'note', what: `the note of kanban task ${task.id}` }, ctx);
}

export function registerKanbanRoutes(app: RouteApp, ctx: RouteContext): void {
  routeCtx = ctx;
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
