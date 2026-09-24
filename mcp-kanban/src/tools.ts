import { apiRequest } from "./api.js";

/**
 * What each kanban tool does, on the Hermes board through Tars. Kept apart
 * from the server so the tools can be exercised without it; index.ts registers
 * them under the names, descriptions and schemas they have always had.
 *
 * The four columns the tools speak map onto Hermes's eight: backlog is a
 * parked task (Hermes never starts it), ongoing one an agent claimed (or one
 * Hermes runs), planned one Noah handed to Hermes, done is done.
 */

type Column = "backlog" | "planned" | "ongoing" | "done";

interface AgentTask {
  id: string;
  title: string;
  column: Column;
  status: string;
  holder: string | null;
  priority: "low" | "medium" | "high";
  description: string;
  heldByCaller: boolean;
  comments?: string[];
  result?: string | null;
}

export interface ToolResult {
  [key: string]: unknown;
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
}

const text = (t: string): ToolResult => ({ content: [{ type: "text", text: t }] });
const failed = (what: string, error: unknown): ToolResult => ({
  content: [{ type: "text", text: `Error ${what}: ${error instanceof Error ? error.message : String(error)}` }],
  isError: true,
});

const id = (taskId: string) => encodeURIComponent(taskId.trim());
const where = (t: AgentTask) => `${t.column}, Hermes: ${t.status}${t.holder ? `, ${t.holder}` : ""}`;

export async function listTasks(args: { column?: Column; assigned_to_me?: boolean }): Promise<ToolResult> {
  try {
    const q = new URLSearchParams();
    if (args.column) q.set("column", args.column);
    if (args.assigned_to_me) q.set("mine", "1");
    const r = await apiRequest("GET", `/api/kanban/tasks${q.size ? `?${q}` : ""}`) as { tasks: AgentTask[] };
    const tasks = r.tasks ?? [];
    return text(tasks.length > 0
      ? `Found ${tasks.length} task(s) on this project's Hermes board:\n${tasks.map(t => `- [${t.id}] ${t.title} (${where(t)})`).join("\n")}`
      : "No tasks found.");
  } catch (error) {
    return failed("listing tasks", error);
  }
}

export async function getTask(args: { task_id: string }): Promise<ToolResult> {
  try {
    const { task: t } = await apiRequest("GET", `/api/kanban/tasks/${id(args.task_id)}`) as { task: AgentTask };
    return text(`Task: ${t.title}
ID: ${t.id}
Column: ${t.column}
Hermes status: ${t.status}
Held by: ${t.holder ?? "nobody"}
Priority: ${t.priority}
Description: ${t.description}${t.result ? `\nResult: ${t.result}` : ""}${t.comments?.length ? `\nComments:\n${t.comments.map(c => `- ${c}`).join("\n")}` : ""}`);
  } catch (error) {
    return failed("getting task", error);
  }
}

export async function createTask(args: { title: string; description: string; project_path?: string; priority?: "low" | "medium" | "high"; labels?: string[] }): Promise<ToolResult> {
  try {
    const { task: t } = await apiRequest("POST", "/api/kanban/tasks", { ...args }) as { task: AgentTask };
    return text(`Task created, parked on the Hermes board: [${t.id}] ${t.title}\nHermes will not start it. Claim it with assign_task to work on it, or leave it for Noah.`);
  } catch (error) {
    return failed("creating task", error);
  }
}

export async function updateTaskProgress(args: { task_id: string; progress: number }): Promise<ToolResult> {
  try {
    const { task: t } = await apiRequest("POST", `/api/kanban/tasks/${id(args.task_id)}/progress`, { progress: args.progress }) as { task: AgentTask };
    return text(`Progress of [${t.id}] ${t.title}: ${args.progress}%, noted on the Hermes board.`);
  } catch (error) {
    return failed("updating task", error);
  }
}

export async function markTaskDone(args: { task_id: string; summary: string }): Promise<ToolResult> {
  try {
    const { task: t } = await apiRequest("POST", `/api/kanban/tasks/${id(args.task_id)}/done`, { summary: args.summary }) as { task: AgentTask };
    return text(`Task [${t.id}] ${t.title} is done.`);
  } catch (error) {
    return failed("completing task", error);
  }
}

export async function moveTask(args: { task_id: string; column: Column }): Promise<ToolResult> {
  try {
    const { task: t } = await apiRequest("POST", `/api/kanban/tasks/${id(args.task_id)}/move`, { column: args.column }) as { task: AgentTask };
    return text(`Task [${t.id}] ${t.title} is now in ${where(t)}.`);
  } catch (error) {
    return failed("moving task", error);
  }
}

export async function deleteTask(args: { task_id: string }): Promise<ToolResult> {
  try {
    const { task } = await apiRequest("DELETE", `/api/kanban/tasks/${id(args.task_id)}`) as { task: { id: string } };
    return text(`Task [${task.id}] deleted from the Hermes board.`);
  } catch (error) {
    return failed("deleting task", error);
  }
}

export async function assignTask(args: { task_id: string; agent_id?: string }): Promise<ToolResult> {
  try {
    const { task: t } = await apiRequest("POST", `/api/kanban/tasks/${id(args.task_id)}/claim`, args.agent_id ? { agent_id: args.agent_id } : {}) as { task: AgentTask };
    return text(t.heldByCaller
      ? `Task [${t.id}] ${t.title} is yours now. Report progress with update_task_progress and finish with mark_task_done.`
      : `Task [${t.id}] ${t.title} is claimed for ${t.holder}. Tars types it into that agent.`);
  } catch (error) {
    return failed("assigning task", error);
  }
}
