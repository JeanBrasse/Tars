import * as https from "https";
import { send } from "../../../mcp-shared/src/http.js";
import { readAppSettings } from "../../../mcp-shared/src/settings.js";

const SOCIALDATA_BASE = "api.socialdata.tools";

function getApiKey(): string {
  const key = (readAppSettings() as { socialDataApiKey?: string } | null | undefined)?.socialDataApiKey;
  if (key) {
    return key;
  }
  throw new Error(
    "SocialData API key not configured. Please add your API key in Tars Settings > SocialData."
  );
}

export async function socialDataRequest(
  method: string,
  endpoint: string,
  queryParams?: Record<string, string>
): Promise<unknown> {
  const apiKey = getApiKey();

  let requestPath = endpoint;
  if (queryParams) {
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(queryParams)) {
      if (value !== undefined && value !== "") {
        params.append(key, value);
      }
    }
    const qs = params.toString();
    if (qs) {
      requestPath += `?${qs}`;
    }
  }

  const { status, data } = await send(https, {
    hostname: SOCIALDATA_BASE,
    port: 443,
    path: requestPath,
    method,
    headers: {
      Authorization: `Bearer ${apiKey}`,
      Accept: "application/json",
    },
  }, undefined, (err) => new Error(`SocialData API request failed: ${err.message}`));

  let parsed: unknown;
  try {
    parsed = JSON.parse(data);
  } catch {
    throw new Error(`Failed to parse SocialData response: ${data.slice(0, 500)}`);
  }
  if (status && status >= 400) {
    if (status === 402) {
      throw new Error("Insufficient SocialData API credits. Please top up your account.");
    } else if (status === 404) {
      throw new Error("Resource not found on Twitter/X.");
    } else if (status === 422) {
      throw new Error(`Validation error: ${JSON.stringify(parsed)}`);
    } else {
      throw new Error(`SocialData API error (HTTP ${status}): ${JSON.stringify(parsed)}`);
    }
  }
  return parsed;
}
