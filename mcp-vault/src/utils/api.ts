import * as http from "http";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";

const API_PORT = 31415;
const API_HOST = "127.0.0.1";
const API_TOKEN_FILE = path.join(os.homedir(), ".dorothy", "api-token");

// This agent's own token, minted by Tars when it spawned the process and
// handed down through the environment. It says which agent is calling, where
// the file below is one secret shared by every agent on the machine and says
// only that the caller is on it. Preferred whenever it is there; the file
// remains for the sessions that started before Tars minted any.
const AGENT_API_TOKEN = process.env.CLAUDE_MGR_API_TOKEN || "";

function readApiToken(): string | null {
  if (AGENT_API_TOKEN) return AGENT_API_TOKEN;
  try {
    if (fs.existsSync(API_TOKEN_FILE)) {
      return fs.readFileSync(API_TOKEN_FILE, "utf-8").trim();
    }
  } catch { /* ignore */ }
  return null;
}

export async function apiRequest(
  method: string,
  path_: string,
  body?: Record<string, unknown>
): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    };
    const token = readApiToken();
    if (token) {
      headers["Authorization"] = `Bearer ${token}`;
    }

    const options: http.RequestOptions = {
      hostname: API_HOST,
      port: API_PORT,
      path: path_,
      method,
      headers,
    };

    const req = http.request(options, (res) => {
      let data = "";
      res.on("data", (chunk) => {
        data += chunk;
      });
      res.on("end", () => {
        try {
          const parsed = JSON.parse(data);
          if (res.statusCode && res.statusCode >= 400) {
            reject(
              new Error(parsed.error || `HTTP ${res.statusCode}: ${data}`)
            );
          } else {
            resolve(parsed);
          }
        } catch {
          reject(new Error(`Failed to parse response: ${data}`));
        }
      });
    });

    req.on("error", (err) => {
      reject(new Error(`API request failed: ${err.message}`));
    });

    if (body) {
      req.write(JSON.stringify(body));
    }

    req.end();
  });
}
