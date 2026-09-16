import * as path from 'path';
import * as os from 'os';
import * as http from 'http';
import { agents } from '../../core/agent-manager';
import { AgentStatus } from '../../types';
import { RouteRequest } from './types';
import { DATA_DIR_NAME } from '../../constants';

/** Project path or id of the calling agent, injected as a header by the MCP
 *  client from its PTY environment. Absent for the UI and other local callers.
 *
 *  Two names on purpose. The MCP client was renamed to send `X-Tars-Caller-*`
 *  while this reader still expected `x-dorothy-caller-project`; the bundles on
 *  disk predate the rename, so it worked by accident and would have broken the
 *  moment anyone rebuilt them - project scoping would have silently switched
 *  off, and every guarded route would 403. Accepting both is what makes the
 *  rename safe in either order. The old name can go once no shipped bundle
 *  sends it.
 *
 *  Here rather than in agent-routes because the bus routes need exactly the
 *  same reading, and a second copy of a header name is a second thing to
 *  forget when one of them changes. */
export function callerHeaderFrom(
  headers: http.IncomingHttpHeaders | undefined,
  suffix: 'project' | 'id',
): string | undefined {
  const value = headers?.[`x-tars-caller-${suffix}`] ?? headers?.[`x-dorothy-caller-${suffix}`];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

/** The same reading, for the routes, which hold a request rather than headers.
 *  The server reads the id straight from the headers before routing, to check
 *  it against the token the call presents. */
export function callerHeader(req: RouteRequest, suffix: 'project' | 'id'): string | undefined {
  return callerHeaderFrom(req.raw?.headers, suffix);
}

/**
 * Which agent this call comes from.
 *
 * The one that presented its own token, when one did. The header only on the
 * shared token, which is the transition the server logs: a caller cannot hold
 * one agent's token and be taken for another, because the server refuses that
 * pair before any route runs.
 *
 * One function for every route that asks, because two readings of who is
 * calling is how the bus's read door came to disagree with its write door.
 */
export function callerId(req: RouteRequest): string | undefined {
  return req.callerAgentId ?? callerHeader(req, 'id');
}

/**
 * Which project this call belongs to.
 *
 * The proven identity first: when the call carries an agent's own token, the
 * project is that agent's, read from the fleet, and the header is not
 * consulted at all. It is a claim, and a claim about a project is exactly what
 * the cross-project guard is supposed to be immune to.
 *
 * A disagreement here is not refused the way a disagreement about the id is.
 * An id cannot drift: it is minted with the agent and never changes. A project
 * can, whenever the agent is moved, and its running process keeps the
 * environment it was spawned with. So a header that no longer matches is stale
 * rather than forged, and the fleet is right where the environment is old.
 */
export function callerProject(req: RouteRequest): string | undefined {
  const proven = req.callerAgentId ? agents.get(req.callerAgentId)?.projectPath : undefined;
  return proven ?? callerHeader(req, 'project');
}

/**
 * Check if a file path is safe to send via Telegram.
 * Blocks sensitive directories that could exfiltrate secrets.
 */
export function isSafeTelegramPath(filePath: string): boolean {
  const resolved = path.resolve(filePath);
  const home = os.homedir();

  if (!resolved.startsWith(home + path.sep) && resolved !== home) {
    return false;
  }

  const blockedDirs = [
    path.join(home, '.ssh'),
    path.join(home, '.gnupg'),
    path.join(home, '.aws'),
    path.join(home, '.claude'),
    path.join(home, '.env'),
    // Our own store. It holds app-settings.json - every provider API key, the
    // Hermes gateway token, the memory-backend credentials - plus api-token
    // and hermes-webhook-secret. Blocking ~/.ssh while leaving this open was
    // guarding the front door and not the safe.
    path.join(home, DATA_DIR_NAME),
    path.join(home, '.config'),
    path.join(home, '.kube'),
    path.join(home, '.docker'),
    path.join(home, '.netrc'),
    path.join(home, '.git-credentials'),
  ];

  for (const blocked of blockedDirs) {
    if (resolved === blocked || resolved.startsWith(blocked + path.sep)) {
      return false;
    }
  }

  return true;
}

/**
 * Find an agent by ID first, then fall back to session ID lookup.
 * Deduplicates a pattern used across hooks and kanban routes.
 */
export function findAgentByIdOrSession(agentId?: string, sessionId?: string): AgentStatus | undefined {
  if (agentId) {
    const agent = agents.get(agentId);
    if (agent) return agent;
  }
  if (sessionId) {
    for (const [, a] of agents) {
      if (a.currentSessionId === sessionId) {
        return a;
      }
    }
  }
  return undefined;
}
