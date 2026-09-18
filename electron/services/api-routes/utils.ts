import * as path from 'path';
import * as os from 'os';
import * as http from 'http';
import { agents } from '../../core/agent-manager';
import { AgentStatus } from '../../types';
import { RouteRequest } from './types';
import { DATA_DIR_NAME, PRIVATE_DIR_NAME } from '../../constants';

/** Project path or id of the calling agent, injected as a header by the MCP
 *  client from its PTY environment. Read only by the server's door, which
 *  refuses an agent's token that comes with another agent's id: a header is a
 *  claim, and no route takes an identity or a project from one.
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

/**
 * Which agent this call comes from: the one whose token it presented, and
 * none otherwise.
 *
 * Never the header. On the shared token the header was believed for a while,
 * and since every agent can read that token, any agent could name any other
 * and be it. A call on the shared token has no agent behind it.
 *
 * One function for every route that asks, because two readings of who is
 * calling is how the bus's read door came to disagree with its write door.
 */
export function callerId(req: RouteRequest): string | undefined {
  return req.callerAgentId;
}

/**
 * Which project this call belongs to: the project of the agent whose token it
 * presented, read from the fleet, and none otherwise.
 *
 * Never X-Tars-Caller-Project, with any token. It is a claim, and a claim about
 * a project is exactly what the cross-project guard has to be immune to. It is
 * not refused when it disagrees, the way a foreign id is: an agent that has
 * been moved keeps the environment it was spawned with, so a stale project
 * header is ordinary, and the fleet is right where the environment is old.
 */
export function callerProject(req: RouteRequest): string | undefined {
  return req.callerAgentId ? agents.get(req.callerAgentId)?.projectPath : undefined;
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
    // Hermes gateway token, the memory-backend credentials - plus api-token.
    // Blocking ~/.ssh while leaving this open was guarding the front door and
    // not the safe.
    path.join(home, DATA_DIR_NAME),
    // And what Tars keeps out of the agents' reach: Noah's conversation with
    // the super chat and the Hermes webhook secret. Both left the store above
    // so that no agent would be handed them, and the move took them off this
    // list with it: the conversation could be sent from where it had landed.
    // Found by the audit of lot 4.
    path.join(home, PRIVATE_DIR_NAME),
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
