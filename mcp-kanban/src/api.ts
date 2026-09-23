import * as http from "http";

/**
 * Tars's local API, as this agent. The kanban lives on the Hermes board, and
 * Tars is the way there: it knows the gateway, which project the agent works
 * on, and which tasks it may move. Nothing here reads or writes a file.
 */

// The Tars that spawned this agent, as mcp-orchestrator and mcp-vault read it.
const API_URL = new URL(process.env.CLAUDE_MGR_API_URL || "http://127.0.0.1:31415");

// This agent's own token, minted by Tars when it spawned the process. The
// kanban tools act for an agent, so the shared ~/.dorothy/api-token, which
// names none, is no use here: Tars refuses it with a message that says so.
const AGENT_API_TOKEN = process.env.CLAUDE_MGR_API_TOKEN || "";

export async function apiRequest(method: string, path_: string, body?: Record<string, unknown>): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (AGENT_API_TOKEN) headers["Authorization"] = `Bearer ${AGENT_API_TOKEN}`;
    const req = http.request({
      hostname: API_URL.hostname,
      port: Number(API_URL.port) || 80,
      path: path_,
      method,
      headers,
    }, (res) => {
      let data = "";
      res.on("data", (chunk) => { data += chunk; });
      res.on("end", () => {
        let parsed: { error?: string } | undefined;
        try { parsed = JSON.parse(data); } catch { /* below */ }
        if (!parsed) { reject(new Error(`Tars answered ${res.statusCode} with no JSON: ${data.slice(0, 200)}`)); return; }
        if (res.statusCode && res.statusCode >= 400) reject(new Error(parsed.error || `HTTP ${res.statusCode}`));
        else resolve(parsed);
      });
    });
    req.on("error", (err) => reject(new Error(`Tars did not answer at ${API_URL.origin}: ${err.message}`)));
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}
