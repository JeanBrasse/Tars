import * as https from "https";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { generateOAuthHeader, type OAuthCredentials } from "./oauth.js";

const X_API_HOST = "api.x.com";

/** Tars's settings as they are now, or null when the file cannot be read. */
function readSettings(): Record<string, unknown> | null {
  const settingsPath = path.join(os.homedir(), ".dorothy", "app-settings.json");
  try {
    if (!fs.existsSync(settingsPath)) return null;
    return JSON.parse(fs.readFileSync(settingsPath, "utf-8"));
  } catch {
    return null;
  }
}

/**
 * Refuse unless Posting is on in Settings > X (Twitter), as the settings are
 * at this call.
 *
 * The switch has been on that page, off by default, since this server shipped,
 * and nothing read it: every agent handed these tools could publish and delete
 * on the account whatever it said (the audit's lead #12), and the privacy
 * policy says Tars posts only when Noah has turned it on. Only the switch's own
 * `true` turns it on; a file with no value for it, or one that cannot be read,
 * is off.
 */
export function assertPostingEnabled(): void {
  if (readSettings()?.xPostingEnabled !== true) {
    throw new Error(
      "Posting is off in Tars Settings > X (Twitter), so nothing was sent. Noah turns it on there when agents may post, reply and delete."
    );
  }
}

function getCredentials(): OAuthCredentials {
  const settings = readSettings();
  if (
    settings?.xApiKey &&
    settings.xApiSecret &&
    settings.xAccessToken &&
    settings.xAccessTokenSecret
  ) {
    return {
      apiKey: String(settings.xApiKey),
      apiSecret: String(settings.xApiSecret),
      accessToken: String(settings.xAccessToken),
      accessTokenSecret: String(settings.xAccessTokenSecret),
    };
  }
  throw new Error(
    "X API credentials not configured. Please add your API keys in Tars Settings > X (Twitter)."
  );
}

export async function xApiRequest(
  method: string,
  endpoint: string,
  body?: Record<string, unknown>
): Promise<unknown> {
  const creds = getCredentials();
  const url = `https://${X_API_HOST}${endpoint}`;
  const bodyStr = body ? JSON.stringify(body) : undefined;
  const authHeader = generateOAuthHeader(method, url, creds, bodyStr);

  return new Promise((resolve, reject) => {
    const options: https.RequestOptions = {
      hostname: X_API_HOST,
      port: 443,
      path: endpoint,
      method,
      headers: {
        Authorization: authHeader,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
    };

    const req = https.request(options, (res) => {
      let data = "";
      res.on("data", (chunk) => {
        data += chunk;
      });
      res.on("end", () => {
        try {
          const parsed = JSON.parse(data);
          if (res.statusCode && res.statusCode >= 400) {
            const errorDetail =
              parsed.detail ||
              parsed.errors?.[0]?.message ||
              JSON.stringify(parsed);
            reject(
              new Error(
                `X API error (HTTP ${res.statusCode}): ${errorDetail}`
              )
            );
          } else {
            resolve(parsed);
          }
        } catch {
          if (res.statusCode === 204) {
            resolve({ success: true });
          } else {
            reject(
              new Error(
                `Failed to parse X API response: ${data.slice(0, 500)}`
              )
            );
          }
        }
      });
    });

    req.on("error", (err) =>
      reject(new Error(`X API request failed: ${err.message}`))
    );

    if (bodyStr) {
      req.write(bodyStr);
    }
    req.end();
  });
}
