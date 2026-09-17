/**
 * The board, as this server reads and writes it.
 *
 * Tars writes kanban-tasks.json too (electron/handlers/kanban-handlers.ts),
 * whole, and so does this server from every agent that uses the board. Both
 * read a file they cannot parse as an empty board, so a save that met the
 * other writer's half-written file used to write the board back empty. Each
 * side now writes a temp file of its own and renames it over, and neither can
 * read the other's file half-written. Two saves that overlap still keep only
 * the last one.
 */
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

export const DATA_DIR = path.join(os.homedir(), ".dorothy");
export const KANBAN_FILE = path.join(DATA_DIR, "kanban-tasks.json");

export type KanbanColumn = "backlog" | "planned" | "ongoing" | "done";

export interface KanbanTask {
  id: string;
  title: string;
  description: string;
  column: KanbanColumn;
  projectId: string;
  projectPath: string;
  assignedAgentId: string | null;
  requiredSkills: string[];
  priority: "low" | "medium" | "high";
  progress: number;
  createdAt: string;
  updatedAt: string;
  order: number;
  labels: string[];
  completionSummary?: string;
}

function ensureDir(): void {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }
}

export function loadTasks(): KanbanTask[] {
  ensureDir();
  if (!fs.existsSync(KANBAN_FILE)) {
    return [];
  }
  try {
    const data = fs.readFileSync(KANBAN_FILE, "utf-8");
    return JSON.parse(data);
  } catch {
    return [];
  }
}

export function saveTasks(tasks: KanbanTask[]): void {
  ensureDir();
  // This process's own name: Tars renames `kanban-tasks.json.tmp`, and a
  // shared temp file would let one writer publish the other's half.
  const tmp = `${KANBAN_FILE}.mcp-${process.pid}.tmp`;
  try {
    fs.writeFileSync(tmp, JSON.stringify(tasks, null, 2));
    fs.renameSync(tmp, KANBAN_FILE);
  } catch (err) {
    try {
      if (fs.existsSync(tmp)) fs.rmSync(tmp, { force: true });
    } catch {
      // The write's own error is the one worth reporting.
    }
    throw err;
  }
}
