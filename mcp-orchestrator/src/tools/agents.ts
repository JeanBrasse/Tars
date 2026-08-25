/**
 * Agent management tools for the MCP server
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { apiRequest, getCallerIdentity } from "../utils/api.js";

type WaitResult = {
  status: string;
  lastCleanOutput?: string;
  error?: string;
  timeout?: boolean;
  waitingReason?: string;
};

type DispatchResult = {
  success: boolean;
  mode: "message" | "start";
  previousStatus?: string;
  agent: { id: string; name?: string; status: string };
};

/**
 * Atomically hand a task to an agent. The server decides message-vs-spawn
 * under its single-threaded event loop: the old GET-status-then-POST pattern
 * raced against status changes and could message a dead PTY.
 *
 * The agent's own configured permission mode is respected (most agents are
 * 'auto'); if a permission dialog does block the agent, the server reports
 * waitingReason 'permission' instead of hanging.
 */
async function dispatchToAgent(
  id: string,
  message: string,
  model?: string,
  allowCrossProject?: boolean
): Promise<DispatchResult> {
  return (await apiRequest(`/api/agents/${id}/dispatch`, "POST", {
    message,
    model,
    allowCrossProject,
  })) as DispatchResult;
}

/**
 * The longest a single long-poll request may run.
 *
 * Node's fetch is undici, whose `headersTimeout` defaults to 300000ms, and
 * /wait sends no headers at all until the agent's status changes. So a wait
 * that stayed quiet for five minutes did not time out cleanly, it died as
 * "fetch failed", and the AbortController above it was never the thing that
 * fired. Waiting more than five minutes on a real piece of work is the normal
 * case, so every long wait was broken.
 *
 * Segmenting under that ceiling fixes it without depending on an undici
 * default: each request returns well before any of them can bite. Passing a
 * dispatcher with the timeout disabled would also work, and only for undici,
 * and only until a request is cut for some other reason. This survives that
 * too, because a failed segment is simply the next one's problem.
 */
const WAIT_SEGMENT_SECONDS = 120;
/** Consecutive segment failures tolerated before the wait gives up. A dropped
 *  connection costs a segment, not the whole wait. */
const MAX_SEGMENT_FAILURES = 3;

/**
 * Wait for an agent's status to change, for as long as asked.
 *
 * Made of short long-polls back to back rather than one long one. The server
 * already answers `{timeout: true}` when a segment expires with nothing to
 * report, which is the signal to go round again.
 */
async function waitForAgentStatus(id: string, timeoutSeconds: number): Promise<WaitResult> {
  const deadline = Date.now() + timeoutSeconds * 1000;
  let failures = 0;
  let last: WaitResult | undefined;

  for (;;) {
    const remainingSec = Math.ceil((deadline - Date.now()) / 1000);
    if (remainingSec <= 0) {
      return last ?? { status: "running", timeout: true };
    }
    const segment = Math.min(WAIT_SEGMENT_SECONDS, remainingSec);

    const startedAt = Date.now();
    try {
      last = (await apiRequest(
        `/api/agents/${id}/wait?timeout=${segment}`,
        "GET",
        undefined,
        (segment + 30) * 1000
      )) as WaitResult;
      failures = 0;
    } catch (err) {
      // A segment that dies takes the rest of the wait with it only if they
      // keep dying: one dropped connection is not a reason to abandon an
      // agent that is still working.
      if (++failures >= MAX_SEGMENT_FAILURES) throw err;
      await new Promise((r) => setTimeout(r, 1000));
      continue;
    }

    // Anything that is not a segment expiring is the answer being waited for.
    if (!last.timeout) return last;

    // A poll that reports its expiry the instant it is asked was not held
    // open, and going straight round again would turn a patient wait into a
    // hot loop against the API. Pause before asking again. Only the degenerate
    // case pays this: a poll that really waited has already spent its segment.
    if (Date.now() - startedAt < segment * 500) {
      await new Promise((r) => setTimeout(r, 1000));
    }
  }
}

/**
 * Fetch the agent's captured clean output, retrying briefly: the Stop hook
 * posts output and status through separate HTTP calls, so the status event
 * that resolves /wait can beat the output write by a moment.
 */
async function fetchCleanOutput(
  id: string,
  attempts = 3,
  delayMs = 700
): Promise<{ output?: string; status: string; name?: string }> {
  let last: { agent: { status: string; name?: string; lastCleanOutput?: string } } | undefined;
  for (let i = 0; i < attempts; i++) {
    last = (await apiRequest(`/api/agents/${id}`)) as typeof last;
    if (last?.agent.lastCleanOutput) {
      return { output: last.agent.lastCleanOutput, status: last.agent.status, name: last.agent.name };
    }
    if (i < attempts - 1) await new Promise((r) => setTimeout(r, delayMs));
  }
  return { output: undefined, status: last?.agent.status ?? "unknown", name: last?.agent.name };
}

export function registerAgentTools(server: McpServer): void {
  // Tool: Who am I (identity handshake for orchestrator sessions)
  server.tool(
    "whoami",
    "Get YOUR identity as a Tars agent: id, name, project, role, and the roster of your project's agents. Call this first if you are unsure who you are or who you can delegate to.",
    {},
    async () => {
      const { agentId, projectPath } = getCallerIdentity();
      if (!agentId && !projectPath) {
        return {
          content: [
            {
              type: "text",
              text: "No agent identity found in the environment (CLAUDE_AGENT_ID / CLAUDE_PROJECT_PATH are unset). You are probably running outside a Tars-managed session; list_agents will return ALL agents unscoped.",
            },
          ],
        };
      }
      try {
        let selfInfo: string;
        if (agentId) {
          const data = (await apiRequest(`/api/agents/${agentId}`)) as {
            agent: { name?: string; role?: string; projectPath: string; branchName?: string; worktreePath?: string };
          };
          selfInfo =
            `You are "${data.agent.name || agentId}" (agent id: ${agentId}), ` +
            `${data.agent.role || "agent"} of project ${data.agent.projectPath}` +
            (data.agent.branchName ? ` (branch ${data.agent.branchName})` : "") +
            ".";
        } else {
          selfInfo = `Your project: ${projectPath} (no agent id available).`;
        }
        const list = (await apiRequest("/api/agents")) as { agents: unknown[] };
        return {
          content: [
            {
              type: "text",
              text: `${selfInfo}\n\nYour project's agents:\n${JSON.stringify(list.agents, null, 2)}`,
            },
          ],
        };
      } catch (error) {
        return {
          content: [
            {
              type: "text",
              text: `Error resolving identity: ${error instanceof Error ? error.message : String(error)}`,
            },
          ],
          isError: true,
        };
      }
    }
  );

  // Tool: List agents (scoped to the caller's project by default)
  server.tool(
    "list_agents",
    "List the agents of YOUR project and their current status (idle/running/waiting/completed/error). Only these agents can receive your tasks: delegating to another project's agents is rejected. `all: true` adds other projects' agents for visibility ONLY; they remain undelegatable, and you must not present them as agents you have access to.",
    {
      all: z.boolean().optional().describe("If true, list agents of ALL projects instead of only your own"),
    },
    async ({ all }) => {
      try {
        const data = (await apiRequest(all ? "/api/agents?all=true" : "/api/agents")) as {
          agents: unknown[];
          scopedToProject?: string;
        };
        // When the caller asked for the global view, say plainly which of these
        // it can actually act on. Listing every project's agents under a
        // heading like "agents you have access to" is misleading: delegation
        // to another project is rejected, so most of that list is unreachable.
        // Asking an agent to list "all the agents you have access to" is
        // exactly the phrasing that makes a model pass all:true.
        const mine = getCallerIdentity().projectPath;
        if (all) {
          const rows = (data.agents as Array<Record<string, unknown>>) ?? [];
          const reachable = mine ? rows.filter(a => a.projectPath === mine) : rows;
          const others = mine ? rows.filter(a => a.projectPath !== mine) : [];
          const header = mine
            ? `You can delegate to these ${reachable.length} agent(s) - they are in your project (${mine}):`
            : `No caller identity, so nothing here is scoped:`;
          const tail = others.length
            ? `\n\nThe following ${others.length} agent(s) belong to OTHER projects. They are listed ` +
              `because all:true was requested. You CANNOT delegate to them - delegate_task will ` +
              `reject it. Do not describe them as available to you:\n` +
              JSON.stringify(others, null, 2)
            : "";
          return {
            content: [{ type: "text", text: `${header}\n${JSON.stringify(reachable, null, 2)}${tail}` }],
          };
        }

        const scopeNote = data.scopedToProject
          ? `Agents of your project (${data.scopedToProject}):\n`
          : "";
        return {
          content: [
            {
              type: "text",
              text: `${scopeNote}${JSON.stringify(data.agents, null, 2)}`,
            },
          ],
        };
      } catch (error) {
        return {
          content: [
            {
              type: "text",
              text: `Error listing agents: ${error instanceof Error ? error.message : String(error)}`,
            },
          ],
          isError: true,
        };
      }
    }
  );

  // Tool: Get agent details
  server.tool(
    "get_agent",
    "Get detailed information about a specific agent including its full output history.",
    {
      id: z.string().describe("The agent ID"),
    },
    async ({ id }) => {
      try {
        const data = (await apiRequest(`/api/agents/${id}`)) as { agent: unknown };
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(data.agent, null, 2),
            },
          ],
        };
      } catch (error) {
        return {
          content: [
            {
              type: "text",
              text: `Error getting agent: ${error instanceof Error ? error.message : String(error)}`,
            },
          ],
          isError: true,
        };
      }
    }
  );

  // Tool: Get agent output (clean text from transcript, no ANSI)
  server.tool(
    "get_agent_output",
    "Get the agent's last response as clean text (no terminal formatting). This is captured from the agent's transcript by hooks. Falls back to noting output is available in terminal view if no clean output is captured yet.",
    {
      id: z.string().describe("The agent ID"),
    },
    async ({ id }) => {
      try {
        const data = (await apiRequest(`/api/agents/${id}`)) as {
          agent: {
            status: string;
            name?: string;
            lastCleanOutput?: string;
          };
        };
        const agentName = data.agent.name || id;

        if (data.agent.lastCleanOutput) {
          return {
            content: [
              {
                type: "text",
                text: `Agent "${agentName}" (${data.agent.status}):\n\n${data.agent.lastCleanOutput}`,
              },
            ],
          };
        }

        return {
          content: [
            {
              type: "text",
              text: `Agent "${agentName}" (${data.agent.status}): No clean output captured yet. The agent's terminal output is available in the Tars UI. Clean output is captured when the agent pauses or completes.`,
            },
          ],
        };
      } catch (error) {
        return {
          content: [
            {
              type: "text",
              text: `Error getting output: ${error instanceof Error ? error.message : String(error)}`,
            },
          ],
          isError: true,
        };
      }
    }
  );

  // Tool: Create agent
  server.tool(
    "create_agent",
    "Create a new agent. Defaults to YOUR project when projectPath is omitted. The agent will be in 'idle' state until started. By default, agents run with --dangerously-skip-permissions for autonomous operation.",
    {
      projectPath: z.string().optional().describe("Absolute path to the project directory (defaults to your own project)"),
      name: z.string().optional().describe("Name for the agent (e.g., 'Backend Worker', 'Test Runner')"),
      skills: z.array(z.string()).optional().describe("List of skill names to enable for this agent"),
      character: z
        .enum(["robot", "ninja", "wizard", "astronaut", "knight", "pirate", "alien", "viking"])
        .optional()
        .describe("Visual character for the agent"),
      skipPermissions: z
        .boolean()
        .optional()
        .default(true)
        .describe("If true (default), agent runs with --dangerously-skip-permissions flag for autonomous operation"),
      secondaryProjectPath: z.string().optional().describe("Secondary project path to add as context (--add-dir)"),
    },
    async ({ projectPath, name, skills, character, skipPermissions = true, secondaryProjectPath }) => {
      try {
        const resolvedProjectPath = projectPath || getCallerIdentity().projectPath;
        if (!resolvedProjectPath) {
          return {
            content: [{ type: "text", text: "Error: projectPath is required (no caller project identity available)." }],
            isError: true,
          };
        }
        const data = (await apiRequest("/api/agents", "POST", {
          projectPath: resolvedProjectPath,
          name,
          skills,
          character,
          skipPermissions,
          secondaryProjectPath,
        })) as { agent: { id: string; name: string } };
        return {
          content: [
            {
              type: "text",
              text: `Created agent "${data.agent.name}" with ID: ${data.agent.id}`,
            },
          ],
        };
      } catch (error) {
        return {
          content: [
            {
              type: "text",
              text: `Error creating agent: ${error instanceof Error ? error.message : String(error)}`,
            },
          ],
          isError: true,
        };
      }
    }
  );

  // Tool: Start agent
  server.tool(
    "start_agent",
    "Start an agent with a specific task/prompt. If agent is already running/waiting, sends the prompt as a message instead. The agent runs with its own configured permission mode.",
    {
      id: z.string().describe("The agent ID"),
      prompt: z.string().describe("The task or instruction for the agent to work on"),
      model: z.string().optional().describe("Optional model to use. Aliases: 'sonnet', 'opus', 'haiku', 'opusplan', 'sonnet[1m]' (1M context). Full IDs: 'claude-sonnet-4-6', 'claude-opus-4-6', 'claude-haiku-4-5-20251001'. Omit to use the agent's configured default."),
      allowCrossProject: z.boolean().optional().describe("Explicitly allow acting on an agent of ANOTHER project (normally rejected)"),
    },
    async ({ id, prompt, model, allowCrossProject }) => {
      try {
        const data = await dispatchToAgent(id, prompt, model, allowCrossProject);
        const agentName = data.agent.name || id;

        if (data.mode === "message") {
          return {
            content: [
              {
                type: "text",
                text: `Agent "${agentName}" was already ${data.previousStatus ?? "running"}. Sent message: "${prompt}"`,
              },
            ],
          };
        }

        return {
          content: [
            {
              type: "text",
              text: `Started agent "${agentName}". Status: ${data.agent.status}\nTask: ${prompt}`,
            },
          ],
        };
      } catch (error) {
        return {
          content: [
            {
              type: "text",
              text: `Error starting agent: ${error instanceof Error ? error.message : String(error)}`,
            },
          ],
          isError: true,
        };
      }
    }
  );

  // Tool: Stop agent
  server.tool(
    "stop_agent",
    "Stop a running agent. The agent will be terminated and return to 'idle' state.",
    {
      id: z.string().describe("The agent ID"),
      allowCrossProject: z.boolean().optional().describe("Explicitly allow acting on an agent of ANOTHER project (normally rejected)"),
    },
    async ({ id, allowCrossProject }) => {
      try {
        await apiRequest(`/api/agents/${id}/stop`, "POST", allowCrossProject ? { allowCrossProject } : undefined);
        return {
          content: [
            {
              type: "text",
              text: `Stopped agent ${id}`,
            },
          ],
        };
      } catch (error) {
        return {
          content: [
            {
              type: "text",
              text: `Error stopping agent: ${error instanceof Error ? error.message : String(error)}`,
            },
          ],
          isError: true,
        };
      }
    }
  );

  // Tool: Send message to agent
  server.tool(
    "send_message",
    "Send input/message to an agent. If the agent is idle/completed/error, this will START the agent with the message as the prompt. If the agent is 'waiting', this sends the message as input. WARNING: Sending to a 'running' agent may interfere with its current work. Prefer waiting until it reaches 'waiting' or 'completed' status.",
    {
      id: z.string().describe("The agent ID"),
      message: z.string().optional().describe("The message to send to the agent"),
      prompt: z.string().optional().describe("Alias for 'message', use either one"),
      allowCrossProject: z.boolean().optional().describe("Explicitly allow acting on an agent of ANOTHER project (normally rejected)"),
    },
    async ({ id, message, prompt, allowCrossProject }) => {
      // Accept either "message" or "prompt" so the LLM doesn't trip on naming
      const resolvedMessage = message || prompt;
      if (!resolvedMessage) {
        return {
          content: [{ type: "text", text: "Error: either 'message' or 'prompt' is required." }],
          isError: true,
        };
      }
      try {
        const data = await dispatchToAgent(id, resolvedMessage, undefined, allowCrossProject);
        const agentName = data.agent.name || id;
        const previousStatus = data.previousStatus ?? "idle";

        if (data.mode === "start") {
          return {
            content: [
              {
                type: "text",
                text: `Agent "${agentName}" was ${previousStatus}, started it with prompt: "${resolvedMessage}". New status: ${data.agent.status}`,
              },
            ],
          };
        }

        if (previousStatus === "running") {
          return {
            content: [
              {
                type: "text",
                text: `⚠️ Agent "${agentName}" is currently running. Message sent but may interfere with current work. Consider using wait_for_agent first to wait until the agent is done.\nMessage sent: "${resolvedMessage}"`,
              },
            ],
          };
        }

        return {
          content: [
            {
              type: "text",
              text: `Sent message to agent "${agentName}" (${previousStatus}): "${resolvedMessage}"`,
            },
          ],
        };
      } catch (error) {
        return {
          content: [
            {
              type: "text",
              text: `Error sending message: ${error instanceof Error ? error.message : String(error)}`,
            },
          ],
          isError: true,
        };
      }
    }
  );

  // Tool: Remove agent
  server.tool(
    "remove_agent",
    "Permanently remove an agent. This will stop the agent if running and delete it from the system.",
    {
      id: z.string().describe("The agent ID"),
      allowCrossProject: z.boolean().optional().describe("Explicitly allow acting on an agent of ANOTHER project (normally rejected)"),
    },
    async ({ id, allowCrossProject }) => {
      try {
        await apiRequest(`/api/agents/${id}${allowCrossProject ? "?allowCrossProject=true" : ""}`, "DELETE");
        return {
          content: [
            {
              type: "text",
              text: `Removed agent ${id}`,
            },
          ],
        };
      } catch (error) {
        return {
          content: [
            {
              type: "text",
              text: `Error removing agent: ${error instanceof Error ? error.message : String(error)}`,
            },
          ],
          isError: true,
        };
      }
    }
  );

  // Tool: Wait for agent completion (long-poll, no polling loop)
  server.tool(
    "wait_for_agent",
    "Wait for an agent to finish its current task. Uses long-polling for efficient waiting: returns as soon as the agent's status changes (no 5-second polling delay). Returns immediately if agent is already idle/waiting/completed/error.",
    {
      id: z.string().describe("The agent ID"),
      timeoutSeconds: z.number().optional().describe("Maximum time to wait in seconds (default: 300)"),
    },
    async ({ id, timeoutSeconds = 300 }) => {
      try {
        // Single long-poll request to the wait endpoint
        const data = await waitForAgentStatus(id, timeoutSeconds);

        const agentData = (await apiRequest(`/api/agents/${id}`)) as {
          agent: { name?: string };
        };
        const agentName = agentData.agent.name || id;

        if (data.timeout) {
          return {
            content: [
              {
                type: "text",
                text: `Timeout after ${timeoutSeconds}s. Agent "${agentName}" is still '${data.status}'. Use get_agent_output to check progress.`,
              },
            ],
            isError: true,
          };
        }

        if (data.status === "completed" || data.status === "idle") {
          const outputInfo = data.lastCleanOutput
            ? `\n\nOutput:\n${data.lastCleanOutput}`
            : "\n\nUse get_agent_output to read the result.";
          return {
            content: [
              {
                type: "text",
                text: `Agent "${agentName}" finished (${data.status}).${outputInfo}`,
              },
            ],
          };
        }

        if (data.status === "error") {
          return {
            content: [
              {
                type: "text",
                text: `Agent "${agentName}" encountered an error: ${data.error || "Unknown error"}`,
              },
            ],
            isError: true,
          };
        }

        if (data.status === "waiting") {
          const reasonInfo = data.waitingReason === "permission"
            ? " It is blocked on a PERMISSION dialog: send_message cannot answer it; resolve it in the Tars UI or stop_agent and re-delegate."
            : " Use send_message to respond, or get_agent_output to see what it's asking.";
          return {
            content: [
              {
                type: "text",
                text: `Agent "${agentName}" is waiting for input.${reasonInfo}`,
              },
            ],
          };
        }

        return {
          content: [
            {
              type: "text",
              text: `Agent "${agentName}" status: ${data.status}`,
            },
          ],
        };
      } catch (error) {
        return {
          content: [
            {
              type: "text",
              text: `Error waiting for agent: ${error instanceof Error ? error.message : String(error)}`,
            },
          ],
          isError: true,
        };
      }
    }
  );

  // Tool: Delegate task (composite: start + wait + get output)
  server.tool(
    "delegate_task",
    "Delegate a task to an agent and wait for the result. This is the primary tool for task delegation: it starts the agent, waits for completion using long-polling, and returns the clean text result. Much more efficient than calling start_agent + wait_for_agent + get_agent_output separately.",
    {
      id: z.string().describe("The agent ID to delegate to"),
      prompt: z.string().describe("The task/instruction for the agent"),
      model: z.string().optional().describe("Optional model to use. Aliases: 'sonnet', 'opus', 'haiku', 'opusplan', 'sonnet[1m]' (1M context). Full IDs: 'claude-sonnet-4-6', 'claude-opus-4-6', 'claude-haiku-4-5-20251001'. Omit to use the agent's configured default."),
      timeoutSeconds: z.number().optional().describe("Maximum time to wait in seconds (default: 300)"),
      allowCrossProject: z.boolean().optional().describe("Explicitly allow delegating to an agent of ANOTHER project (normally rejected)"),
    },
    async ({ id, prompt, model, timeoutSeconds = 300, allowCrossProject }) => {
      try {
        // Preferred path: run the task over the Agent Client Protocol, which
        // returns the agent's actual answer, why the turn ended and what it
        // cost. Falls back to the terminal dispatch below for CLIs that have
        // no ACP mode, or when the run itself could not start.
        try {
          const acp = (await apiRequest(
            `/api/agents/${id}/run-task`,
            "POST",
            { task: prompt, timeoutSeconds },
            (timeoutSeconds + 60) * 1000,
          )) as {
            ok?: boolean;
            stopReason?: string;
            text?: string;
            toolCalls?: string[];
            usage?: { totalTokens?: number };
            costUSD?: number;
            error?: string;
            retryWithDispatch?: boolean;
          };

          if (acp && !acp.retryWithDispatch && (acp.ok || acp.text)) {
            const meta = [
              acp.stopReason ? `ended: ${acp.stopReason}` : "",
              acp.toolCalls?.length ? `tools: ${acp.toolCalls.slice(0, 8).join(", ")}` : "",
              acp.usage?.totalTokens ? `${acp.usage.totalTokens} tokens` : "",
              typeof acp.costUSD === "number" ? `$${acp.costUSD.toFixed(4)}` : "",
            ].filter(Boolean).join(" | ");

            return {
              content: [{
                type: "text",
                text: `${acp.text || "(the agent produced no text)"}\n\n---\n${meta}`,
              }],
              isError: !acp.ok,
            };
          }
        } catch {
          // ACP unavailable for this agent. The terminal path still works.
        }

        // Atomic dispatch: the server decides message-vs-spawn under its own
        // lock, so a stale status can never route the prompt to a dead PTY.
        const dispatched = await dispatchToAgent(id, prompt, model, allowCrossProject);
        const agentName = dispatched.agent.name || id;

        // Wait for completion via long-poll
        let waitData = await waitForAgentStatus(id, timeoutSeconds);

        if (waitData.status === "waiting") {
          if (waitData.waitingReason === "permission") {
            // A blocking permission dialog: typing text into it does nothing
            // useful (it expects arrow keys/enter). Surface it instead.
            return {
              content: [
                {
                  type: "text",
                  text: `Agent "${agentName}" is blocked on a PERMISSION dialog and cannot proceed autonomously. Resolve it in the Tars UI, or stop_agent and re-delegate.`,
                },
              ],
              isError: true,
            };
          }
          // Agent asked for confirmation: auto-reply "continue" and wait
          // again. A single retry only answers the FIRST question a task
          // asks - a multi-step task that pauses to confirm several times
          // used to fall back on the orchestrator to notice "still waiting"
          // and manually nudge it again for every subsequent question. Loop
          // instead, bounded so a truly stuck agent still surfaces rather
          // than spinning forever.
          const MAX_AUTO_CONTINUES = 8;
          const deadline = Date.now() + timeoutSeconds * 1000;
          let autoContinues = 0;

          while (waitData.status === "waiting" && waitData.waitingReason !== "permission") {
            if (autoContinues >= MAX_AUTO_CONTINUES) break;
            const remainingMs = deadline - Date.now();
            if (remainingMs <= 0) break;

            autoContinues++;
            try {
              await dispatchToAgent(
                id,
                "Yes, continue. Do not ask for confirmation. Complete the task and report your results.",
                undefined,
                allowCrossProject
              );
            } catch {
              // Auto-continue itself failed (agent gone, network hiccup):
              // stop looping and report the waiting state as-is below.
              break;
            }
            waitData = await waitForAgentStatus(id, Math.max(Math.floor(remainingMs / 1000), 30));
          }

          if (waitData.status === "waiting") {
            if (waitData.waitingReason === "permission") {
              return {
                content: [
                  {
                    type: "text",
                    text: `Agent "${agentName}" is blocked on a PERMISSION dialog and cannot proceed autonomously. Resolve it in the Tars UI, or stop_agent and re-delegate.`,
                  },
                ],
                isError: true,
              };
            }
            // Still waiting after every auto-continue: give up and let the
            // orchestrator handle it.
            const outputInfo = waitData.lastCleanOutput
              ? `\n\nAgent output:\n${waitData.lastCleanOutput}`
              : "";
            return {
              content: [
                {
                  type: "text",
                  text: `Agent "${agentName}" is still waiting for input after ${autoContinues} auto-continue attempt(s).${outputInfo}\n\nUse send_message to respond.`,
                },
              ],
            };
          }
        }

        if (waitData.timeout) {
          return {
            content: [
              {
                type: "text",
                text: `Agent "${agentName}" is still running after ${timeoutSeconds}s. Use wait_for_agent to continue waiting, or get_agent_output to check progress.`,
              },
            ],
            isError: true,
          };
        }

        if (waitData.status === "error") {
          return {
            content: [
              {
                type: "text",
                text: `Agent "${agentName}" failed: ${waitData.error || "Unknown error"}`,
              },
            ],
            isError: true,
          };
        }

        // Completed or idle: fetch the clean output, retrying briefly since
        // the Stop hook's output post can arrive just after the status event
        // that resolved the long-poll.
        const { output: fetchedOutput } = await fetchCleanOutput(id);
        const output = fetchedOutput || waitData.lastCleanOutput;

        if (output) {
          return {
            content: [
              {
                type: "text",
                text: `Agent "${agentName}" completed.\n\n${output}`,
              },
            ],
          };
        }

        return {
          content: [
            {
              type: "text",
              text: `Agent "${agentName}" finished (${waitData.status}) but no clean output was captured. Use get_agent_output to retry, or check the agent's terminal in the Tars UI.`,
            },
          ],
        };
      } catch (error) {
        return {
          content: [
            {
              type: "text",
              text: `Error delegating task: ${error instanceof Error ? error.message : String(error)}`,
            },
          ],
          isError: true,
        };
      }
    }
  );
}
