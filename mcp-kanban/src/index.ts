#!/usr/bin/env node
/**
 * MCP server for Kanban task management
 * Available to all Claude agents for creating, updating, and completing tasks
 *
 * The board is Hermes's: every tool goes through Tars (its local API, this
 * agent's own token) to the Hermes board, the one the Kanban page shows. A task
 * an agent creates arrives parked, where Hermes never starts it; an agent claims
 * one with assign_task, one at a time. There is no local fallback: when Hermes
 * is not configured or does not answer, the tool says so. The names, the
 * descriptions and the schemas are the ones these tools always had.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

import * as tools from "./tools.js";

// Create MCP server
const server = new McpServer({
  name: "claude-mgr-kanban",
  version: "1.0.0",
});

// Tool: List all tasks
server.tool(
  "list_tasks",
  "List all kanban tasks. Optionally filter by column (backlog, planned, ongoing, done).",
  {
    column: z.enum(["backlog", "planned", "ongoing", "done"]).optional().describe("Filter by column"),
    assigned_to_me: z.boolean().optional().describe("Only show tasks assigned to this agent"),
  },
  (args) => tools.listTasks(args)
);

// Tool: Get task details
server.tool(
  "get_task",
  "Get detailed information about a specific task.",
  {
    task_id: z.string().describe("The task ID (can be partial, will match prefix)"),
  },
  (args) => tools.getTask(args)
);

// Tool: Create a new task
server.tool(
  "create_task",
  "Create a new kanban task. Tasks start in the backlog column.",
  {
    title: z.string().describe("Task title"),
    description: z.string().describe("Task description with details"),
    project_path: z.string().optional().describe("Project path (defaults to current directory)"),
    priority: z.enum(["low", "medium", "high"]).optional().describe("Task priority (default: medium)"),
    labels: z.array(z.string()).optional().describe("Labels/tags for the task"),
  },
  (args) => tools.createTask(args)
);

// Tool: Update task progress
server.tool(
  "update_task_progress",
  "Update the progress percentage of a task.",
  {
    task_id: z.string().describe("The task ID"),
    progress: z.number().min(0).max(100).describe("Progress percentage (0-100)"),
  },
  (args) => tools.updateTaskProgress(args)
);

// Tool: Mark task as done
server.tool(
  "mark_task_done",
  "Mark a task as completed and move it to the done column. IMPORTANT: Call this when you finish working on an assigned task.",
  {
    task_id: z.string().describe("The task ID to mark as done"),
    summary: z.string().describe("A brief summary of what was accomplished (1-3 sentences)"),
  },
  (args) => tools.markTaskDone(args)
);

// Tool: Move task to a different column
server.tool(
  "move_task",
  "Move a task to a different column (backlog, planned, ongoing, done).",
  {
    task_id: z.string().describe("The task ID to move"),
    column: z.enum(["backlog", "planned", "ongoing", "done"]).describe("Target column"),
  },
  (args) => tools.moveTask(args)
);

// Tool: Delete a task
server.tool(
  "delete_task",
  "Delete a task from the kanban board.",
  {
    task_id: z.string().describe("The task ID to delete"),
  },
  (args) => tools.deleteTask(args)
);

// Tool: Assign agent to task
server.tool(
  "assign_task",
  "Assign an agent to a task (or assign yourself).",
  {
    task_id: z.string().describe("The task ID"),
    agent_id: z.string().optional().describe("Agent ID to assign (defaults to self if CLAUDE_AGENT_ID is set)"),
  },
  (args) => tools.assignTask(args)
);

// Start server
async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("MCP Kanban server running on stdio");
}

main().catch(console.error);
