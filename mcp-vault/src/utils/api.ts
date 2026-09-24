import * as http from "http";
import { send } from "../../../mcp-shared/src/http.js";
import { API_URL, readApiToken } from "../../../mcp-shared/src/tars-api.js";

// The Tars that spawned this agent, read as mcp-orchestrator and mcp-memory
// read it. It was 127.0.0.1:31415 whatever the environment said, so the agents
// of a sandbox (31499) or of the e2e suite (31498) sent their documents to the
// Tars running on this machine.
const TARS = new URL(API_URL);

export async function apiRequest(
  method: string,
  path_: string,
  body?: Record<string, unknown>
): Promise<unknown> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  const token = readApiToken();
  if (token) {
    headers["Authorization"] = `Bearer ${token}`;
  }

  const { status, data } = await send(http, {
    hostname: TARS.hostname,
    port: Number(TARS.port) || 80,
    path: path_,
    method,
    headers,
  }, body && JSON.stringify(body), (err) => new Error(`API request failed: ${err.message}`));

  // A 4xx or 5xx whose body is JSON null reads as unparseable, as it always
  // has: its .error is read inside the try.
  let refused: Error;
  try {
    const parsed = JSON.parse(data);
    if (!(status && status >= 400)) return parsed;
    refused = new Error(parsed.error || `HTTP ${status}: ${data}`);
  } catch {
    throw new Error(`Failed to parse response: ${data}`);
  }
  throw refused;
}
