import * as path from 'path';
import * as os from 'os';
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
export function callerHeader(req: RouteRequest, suffix: 'project' | 'id'): string | undefined {
  const headers = req.raw?.headers;
  const value = headers?.[`x-tars-caller-${suffix}`] ?? headers?.[`x-dorothy-caller-${suffix}`];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

export function callerProject(req: RouteRequest): string | undefined {
  return callerHeader(req, 'project');
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
