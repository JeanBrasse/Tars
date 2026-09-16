import * as crypto from 'crypto';

/**
 * A secret per agent process, so that on the local API an agent is named by
 * what it holds rather than by what it says.
 *
 * Until this existed, an agent proved nothing. The bearer token on every MCP
 * call was `~/.dorothy/api-token`, one file every agent can read, so it proved
 * "a process of this machine" and never "this agent". Which agent was carried
 * in the X-Tars-Caller-Id header, written by the caller, believed by the
 * server: any agent could put a colleague's id in it and be that colleague for
 * the length of the call. The bus places a caller in a room by the project of
 * the agent it is, and the delegation routes decide what an orchestrator may
 * drive the same way.
 *
 * So: a random 256 bit token is minted on the line that starts an agent
 * process, and travels to the CLI, and from there to the MCP servers it
 * starts, in the environment. The server names the caller from the token and
 * from nothing else: a call on the shared token is no agent at all.
 *
 * What this does not stop. The environment a process was started with is
 * readable by every other process of the same user: `ps -Eww -p <pid>` prints
 * it, measured on 2026-09-16 by reading one agent's CLAUDE_AGENT_ID from
 * another agent's shell. An agent set on it can read a colleague's token the
 * same way and present it. The token ends the impersonation that took writing
 * a header. It is not a boundary against a process that reads the process
 * table, and no check in the API can be one while agents run as the user
 * without a sandbox.
 *
 * In memory, deliberately, and never next to api-token: a file is what made
 * the shared token shared. An agent removed from the fleet needs no
 * revocation either: every guard resolves the id through `agents`, and an id
 * that is no longer in there is refused by the lookup that follows.
 */

/** token -> agent id. The direction the server asks in. */
const agentByToken = new Map<string, string>();
/** agent id -> the token of its terminal, so a new spawn can drop the previous one. */
const tokenByAgent = new Map<string, string>();

/**
 * A fresh token for this agent's terminal, replacing the one it had.
 *
 * Called from spawnAgentPty, which is the single line every agent pty starts
 * on. Called there rather than when the agent record is created because a
 * token that outlives the process it was minted for is a pass left behind.
 */
export function mintAgentToken(agentId: string): string {
  const previous = tokenByAgent.get(agentId);
  if (previous) agentByToken.delete(previous);

  const token = crypto.randomBytes(32).toString('hex');
  agentByToken.set(token, agentId);
  tokenByAgent.set(agentId, token);
  return token;
}

/**
 * A token for one delegated run, held beside the terminal's rather than in its
 * place, and valid until `revoke` is called.
 *
 * A task delegated over ACP runs in a process of its own, started by
 * delegateOverAcp and not by spawnAgentPty, while the agent's terminal may
 * well be alive with a token of its own. Minting through mintAgentToken would
 * cut that terminal off in mid-session, and a terminal respawned during the
 * run would cut the run off. So the run's token takes no part in the
 * terminal's replacement, and ends with the run.
 */
export function mintRunToken(agentId: string): { token: string; revoke: () => void } {
  const token = crypto.randomBytes(32).toString('hex');
  agentByToken.set(token, agentId);
  return { token, revoke: () => { agentByToken.delete(token); } };
}

/** The agent this token was minted for, or undefined if it was not minted here. */
export function agentForToken(token: string): string | undefined {
  return agentByToken.get(token);
}
