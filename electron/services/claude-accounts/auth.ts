import { execFile } from 'child_process';
import { buildFullPath } from '../../utils/path-builder';

/**
 * Asking Claude Code about an account, never its credential.
 *
 * Tars never reads, copies or stores a Claude token. `claude auth status`
 * reads the keychain item (or, on Linux, the file) itself and prints JSON;
 * `claude auth logout` removes that directory's item and no other; `claude
 * auth login --claudeai` signs a directory in, in a terminal the user drives.
 * All measured on claude 2.1.283 (DESIGN-COMPTES-CLAUDE.md, A2).
 */

export interface ClaudeAuthInfo {
  signedIn: boolean;
  email: string | null;
  subscriptionType: string | null;
  orgName: string | null;
}

const TIMEOUT_MS = 20_000;

/**
 * The environment a claude command for this account runs with.
 *
 * - CLAUDE_CONFIG_DIR is the directory exactly as stored, and absent for
 *   account 1: measured, CLAUDE_CONFIG_DIR=~/.claude is not the default but
 *   another keychain item and another .claude.json;
 * - CLAUDE_SECURESTORAGE_CONFIG_DIR is dropped: Claude Code names the keychain
 *   item after it when it is set, so one inherited would aim every account at
 *   the same item;
 * - CLAUDECODE, the nested-session marker of a Tars started from a claude
 *   session, is dropped, and so is TARS_CLAUDE_ACCOUNT, which names the
 *   account a status line reports for and would be an agent's own in a Tars
 *   started from its terminal;
 * - the auto-updater is off, as in every terminal Tars starts.
 */
export function accountEnv(configDir: string | null, base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...base };
  delete env.CLAUDE_CONFIG_DIR;
  delete env.CLAUDE_SECURESTORAGE_CONFIG_DIR;
  delete env.CLAUDECODE;
  delete env.TARS_CLAUDE_ACCOUNT;
  env.DISABLE_AUTOUPDATER = '1';
  if (configDir !== null) env.CLAUDE_CONFIG_DIR = configDir;
  return env;
}

function withPath(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  // The packaged main process has a bare PATH: a claude found by name would
  // not be found at all.
  return { ...env, PATH: buildFullPath() };
}

function run(binary: string, args: string[], configDir: string | null): Promise<{ code: number; stdout: string; stderr: string; spawnError?: Error }> {
  return new Promise(resolve => {
    execFile(binary, args, { env: withPath(accountEnv(configDir)), timeout: TIMEOUT_MS, windowsHide: true }, (err, stdout, stderr) => {
      // A number is the exit code; anything else (ENOENT, a timeout's kill) means it did not run to the end.
      const code: unknown = err ? (err as { code?: unknown }).code : 0;
      if (typeof code !== 'number') {
        resolve({ code: -1, stdout: String(stdout ?? ''), stderr: String(stderr ?? ''), spawnError: err as Error });
        return;
      }
      resolve({ code, stdout: String(stdout ?? ''), stderr: String(stderr ?? '') });
    });
  });
}

function stringOrNull(v: unknown): string | null {
  return typeof v === 'string' && v ? v : null;
}

/** Whether the directory is signed in, and as whom. Exit 1 is "not signed in", an answer. */
export async function claudeAuthStatus(binary: string, configDir: string | null): Promise<ClaudeAuthInfo> {
  const r = await run(binary, ['auth', 'status'], configDir);
  if (r.spawnError) throw new Error(`claude auth status could not run: ${r.spawnError.message}`);
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(r.stdout);
  } catch {
    throw new Error(`claude auth status did not answer in JSON (exit ${r.code}).`);
  }
  if (!parsed || typeof parsed !== 'object' || typeof parsed.loggedIn !== 'boolean') {
    throw new Error(`claude auth status did not say whether it is signed in (exit ${r.code}).`);
  }
  const signedIn = parsed.loggedIn;
  return {
    signedIn,
    email: signedIn ? stringOrNull(parsed.email) : null,
    subscriptionType: signedIn ? stringOrNull(parsed.subscriptionType) : null,
    orgName: signedIn ? stringOrNull(parsed.orgName) : null,
  };
}

/** Signs the directory out, through Claude Code. Throws when it did not. */
export async function claudeAuthLogout(binary: string, configDir: string | null): Promise<void> {
  const r = await run(binary, ['auth', 'logout'], configDir);
  if (r.spawnError) throw new Error(`claude auth logout could not run: ${r.spawnError.message}`);
  if (r.code !== 0) {
    const why = (r.stderr || r.stdout).trim().split('\n')[0] || `exit ${r.code}`;
    throw new Error(`Claude Code did not log this account out: ${why}`);
  }
}

/** The login terminal's program: the binary itself, no shell in between. */
export function loginCommand(binary: string, configDir: string | null, base: NodeJS.ProcessEnv = process.env): { file: string; args: string[]; env: NodeJS.ProcessEnv } {
  return { file: binary, args: ['auth', 'login', '--claudeai'], env: accountEnv(configDir, base) };
}
