/**
 * Tars's local API, as the MCP servers an agent runs call it: where it is,
 * the token presented, and who the caller says it is.
 *
 * One copy for every server that talks to Tars, bundled into each by esbuild.
 * It imports node's builtins and nothing else, here and in every file of
 * mcp-shared: a package imported from this folder would be resolved from the
 * repository's root, not from the server's own locked node_modules.
 */

import * as fs from "fs";
import * as path from "path";
import * as os from "os";

export const API_URL = process.env.CLAUDE_MGR_API_URL || "http://127.0.0.1:31415";
const API_TOKEN_FILE = path.join(os.homedir(), ".dorothy", "api-token");

// Caller identity, injected into the PTY environment by Tars when it spawns
// the agent. Sent on every request so the server can scope agent listings and
// reject cross-project actions (the "orchestrator drove another project's
// agents" bug).
const CALLER_AGENT_ID = process.env.CLAUDE_AGENT_ID || "";
const CALLER_PROJECT_PATH = process.env.CLAUDE_PROJECT_PATH || "";

export function getCallerIdentity(): { agentId: string; projectPath: string } {
  return { agentId: CALLER_AGENT_ID, projectPath: CALLER_PROJECT_PATH };
}

// This agent's own token, minted by Tars when it spawned the process and
// handed down through the environment. It says which agent is calling, where
// the file below is one secret shared by every agent on the machine and says
// only that the caller is on it. Preferred whenever it is there; the file
// remains for the sessions that started before Tars minted any.
export const AGENT_API_TOKEN = process.env.CLAUDE_MGR_API_TOKEN || "";

export function readApiToken(): string | null {
  if (AGENT_API_TOKEN) return AGENT_API_TOKEN;
  try {
    if (fs.existsSync(API_TOKEN_FILE)) {
      return fs.readFileSync(API_TOKEN_FILE, "utf-8").trim();
    }
  } catch { /* ignore */ }
  return null;
}

export async function apiRequest(
  endpoint: string,
  method: "GET" | "POST" | "DELETE" = "GET",
  body?: Record<string, unknown>,
  timeoutMsOverride?: number
): Promise<unknown> {
  const url = `${API_URL}${endpoint}`;
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    // Marks this as an agent-initiated call, so the server can refuse to act
    // when the caller turns out to have no identity to scope it by.
    "X-Tars-Client": "mcp",
  };
  const token = readApiToken();
  if (token) {
    headers["Authorization"] = `Bearer ${token}`;
  }
  if (CALLER_AGENT_ID) {
    headers["X-Tars-Caller-Id"] = CALLER_AGENT_ID;
  }
  if (CALLER_PROJECT_PATH) {
    headers["X-Tars-Caller-Project"] = CALLER_PROJECT_PATH;
  }

  // Long-poll wait endpoints need a longer timeout. Callers passing a custom
  // wait timeout must override this so the client never aborts before the
  // server-side long-poll resolves.
  const isLongPoll = endpoint.includes("/wait");
  const timeoutMs = timeoutMsOverride ?? (isLongPoll ? 600_000 : 30_000);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  const options: RequestInit = {
    method,
    headers,
    signal: controller.signal,
  };
  if (body) {
    options.body = JSON.stringify(body);
  }

  try {
    const response = await fetch(url, options);
    const data = await response.json();

    if (!response.ok) {
      throw new Error((data as { error?: string }).error || `API error: ${response.status}`);
    }

    return data;
  } finally {
    clearTimeout(timer);
  }
}
