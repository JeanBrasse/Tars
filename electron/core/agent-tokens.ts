import * as crypto from 'crypto';

/**
 * A secret per agent, so that identity is something an agent holds rather than
 * something it says.
 *
 * Until this existed, an agent proved nothing. The bearer token on every MCP
 * call is `~/.dorothy/api-token`, one file read by every agent on the machine,
 * so it proved "an agent of this machine" and never "this agent". Which agent
 * was carried in the X-Tars-Caller-Id header, written by the caller, believed
 * by the server: any agent could put a colleague's id in it and be that
 * colleague for the length of the call. The consequences were not theoretical.
 * The bus places a caller in a room by the project of the agent it claims to
 * be, and the delegation routes decide what an orchestrator may drive the same
 * way.
 *
 * So: a random 256 bit token is minted per agent on the one line that spawns
 * its process, and travels to the CLI, and from there to the MCP servers it
 * starts, in the environment. The server resolves the agent from the token and
 * reads the header only as a claim to check against it.
 *
 * In memory, deliberately. It is not written next to api-token, because a file
 * is exactly what made the shared token shared: anything that can read the
 * disk can present it. A token here lives as long as the app, and minting a
 * new one for an agent drops the previous one, so a restarted agent's old
 * token stops working the moment it is replaced. An agent removed from the
 * fleet needs no revocation either: every guard resolves the id through
 * `agents`, and an id that is no longer in there is refused by the lookup that
 * follows.
 */

/** token -> agent id. The direction the server asks in. */
const agentByToken = new Map<string, string>();
/** agent id -> token, so a new mint can drop the agent's previous one. */
const tokenByAgent = new Map<string, string>();

/**
 * A fresh token for this agent, replacing any it already had.
 *
 * Called from spawnAgentPty, which is the single line every agent process
 * starts on. Called there rather than when the agent record is created because
 * a token that outlives the process it was minted for is a pass left behind.
 */
export function mintAgentToken(agentId: string): string {
  const previous = tokenByAgent.get(agentId);
  if (previous) agentByToken.delete(previous);

  const token = crypto.randomBytes(32).toString('hex');
  agentByToken.set(token, agentId);
  tokenByAgent.set(agentId, token);
  return token;
}

/** The agent this token was minted for, or undefined if it was not minted here. */
export function agentForToken(token: string): string | undefined {
  return agentByToken.get(token);
}

/**
 * Whether this agent was started holding a token of its own.
 *
 * Read by the transition journal. An agent that has one and still calls with
 * the shared token is either running an MCP bundle older than this module, or
 * is not that agent at all. An agent that has none started before its token
 * could be minted. Only the first is worth anyone's attention.
 */
export function hasAgentToken(agentId: string): boolean {
  return tokenByAgent.has(agentId);
}
