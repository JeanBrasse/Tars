import * as fs from "fs";
import * as os from "os";
import * as path from "path";

/**
 * Tars's settings file (~/.dorothy/app-settings.json) as it is at this call:
 * what it parses to, or undefined when there is none or it cannot be read.
 * The servers that call a service themselves (SocialData, X, Telegram) read
 * their keys here, never through Tars.
 */
export function readAppSettings(onError?: (error: unknown) => void): unknown {
  const file = path.join(os.homedir(), ".dorothy", "app-settings.json");
  try {
    if (fs.existsSync(file)) return JSON.parse(fs.readFileSync(file, "utf-8"));
  } catch (error) {
    onError?.(error);
  }
  return undefined;
}
