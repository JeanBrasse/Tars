import { realFs, type Env, type FsProbe } from './fs-probe';
import { withPath } from './path-env';
import { resolveCliBinary, type CliBinaryFailure } from './cli-binary';
import { buildFullPath } from '../utils/path-builder';

/**
 * The environment a CLI runs in outside an agent's PTY, and the command a
 * CLI's MCP config gets for a stdio server (audit A18, B/M-01). Moved here
 * from providers/cli-exec.ts, unchanged.
 */

/**
 * The environment a CLI is looked up in and started with when the caller
 * gives none. darwin/linux: none, so child_process reads process.env as it
 * always did. win32: process.env with the PATH an agent's PTY gets
 * (buildFullPath: %USERPROFILE%\.local\bin and %APPDATA%\npm appended), under
 * one key, so the CLI found is the one an agent would run and the child reads
 * that same PATH.
 */
export function cliEnv(platform: NodeJS.Platform = process.platform, env: Env = process.env): Env | undefined {
  if (platform !== 'win32') return undefined;
  return withPath(env, buildFullPath([], { env: env as NodeJS.ProcessEnv, platform }), platform);
}

/**
 * The command and args to write into a CLI's MCP config for a stdio server,
 * which that CLI starts later with its own spawn. win32: an npm shim (`npx`,
 * a gws.cmd) cannot be started that way, so it becomes node (or the shim's
 * .exe) with the script in front of the args. Node is written as bare `node`
 * whenever the node the shim would run is the one the PATH finds, and a real
 * .exe the PATH finds (`node`) stays as named: the absolute path of today's
 * node.exe dies at the next nvm or fnm switch, and isMcpServerRegistered,
 * which compares the script, would never rewrite it. Only a node.exe beside
 * the shim that the PATH does not give keeps its full path. A command that
 * cannot be resolved is kept as given and the reason handed back, for the
 * caller to log. darwin/linux: as given.
 */
export function stdioServerCommand(
  command: string, args: string[], env?: Env, platform: NodeJS.Platform = process.platform, fs: FsProbe = realFs,
): { command: string; args: string[]; unresolved?: CliBinaryFailure } {
  const lookupEnv = env ?? cliEnv(platform) ?? process.env;
  const binary = resolveCliBinary(command, lookupEnv, platform, fs);
  if (!binary.ok) return { command, args, unresolved: binary };
  if (binary.via === 'as-given' || binary.via === 'exe') return { command, args };
  const withScript = [...binary.prefixArgs, ...args];
  if (binary.via === 'npm-shim-node') {
    const pathNode = resolveCliBinary('node', lookupEnv, platform, fs);
    if (pathNode.ok && pathNode.via === 'exe' && pathNode.file.toLowerCase() === binary.file.toLowerCase()) {
      return { command: 'node', args: withScript };
    }
  }
  return { command: binary.file, args: withScript };
}

/**
 * One of Tars's own MCP servers (a bundled one, or the user's Tasmania):
 * `node <path>` for a .js, `npx tsx <path>` for a .ts, as each CLI will start
 * it (stdioServerCommand). An npx that cannot be resolved is written as given
 * and logged with the reason, under `label`.
 */
export function nodeServerCommand(
  serverPath: string, label: string, env?: Env, platform: NodeJS.Platform = process.platform, fs: FsProbe = realFs,
): { command: string; args: string[] } {
  const isTypeScript = serverPath.endsWith('.ts');
  const server = stdioServerCommand(isTypeScript ? 'npx' : 'node', isTypeScript ? ['tsx', serverPath] : [serverPath], env, platform, fs);
  if (server.unresolved) {
    console.warn(`MCP server ${label}: ${server.unresolved.name} not resolved (${server.unresolved.reason}): ${server.unresolved.detail}`);
  }
  return { command: server.command, args: server.args };
}
