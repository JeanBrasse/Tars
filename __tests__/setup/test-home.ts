import * as path from 'node:path';

/**
 * The one way a test moves the home, and puts it back.
 *
 * On macOS and Linux the home is HOME, and that is all this touches there,
 * exactly as the tests that set process.env.HOME themselves always did. On
 * Windows `os.homedir()` reads USERPROFILE, not HOME, so a test that moved
 * HOME alone left the product reading and writing the home the suite runs in
 * (measured on 2026-09-25: the Telegram MCP server read its settings from
 * there and never reached the guard its tests are about). There the other
 * variables that name the home move with it: USERPROFILE, HOMEDRIVE +
 * HOMEPATH, APPDATA and LOCALAPPDATA, under the new home as Windows lays them
 * out. home-isolation.ts moves the suite's own home with the same list.
 *
 * The platform is read at each call, not at load, so a witness can stand in
 * for another one.
 */

/** The variables that name `home` on this platform, as they should read once it is moved. */
export function homeVariables(home: string): Record<string, string> {
  if (process.platform !== 'win32') return { HOME: home };
  const drive = path.parse(home).root.replace(/[\\/]+$/, '');
  return {
    HOME: home,
    USERPROFILE: home,
    HOMEDRIVE: drive,
    HOMEPATH: home.slice(drive.length),
    APPDATA: path.join(home, 'AppData', 'Roaming'),
    LOCALAPPDATA: path.join(home, 'AppData', 'Local'),
  };
}

/** Move the home to `home`. Returns what puts every moved variable back as it was, unset included. */
export function moveTestHome(home: string): () => void {
  const next = homeVariables(home);
  const before = Object.fromEntries(Object.keys(next).map(key => [key, process.env[key]]));
  Object.assign(process.env, next);
  return () => {
    for (const [key, value] of Object.entries(before)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  };
}

/** Run `body` with the home moved to `home`, and put it back once it returns, throws or settles. */
export function withTestHome<T>(home: string, body: () => T): T {
  const restore = moveTestHome(home);
  let result: T;
  try {
    result = body();
  } catch (error) {
    restore();
    throw error;
  }
  if (result instanceof Promise) return result.finally(restore) as T;
  restore();
  return result;
}
