import { describe, it, expect } from 'vitest';
import { mintAgentToken, agentForToken, hasAgentToken } from '../../../electron/core/agent-tokens';

/**
 * The secret that says which agent is calling.
 *
 * Every agent used to authenticate with the same file, so the token proved the
 * caller was on this machine and the X-Tars-Caller-Id header, written by the
 * caller, said who it was. These pin the three properties that make a token an
 * identity rather than a password everyone shares.
 */
describe('a token minted for an agent', () => {
  it('names that agent, and no other', () => {
    const alpha = mintAgentToken('agent-alpha');
    const beta = mintAgentToken('agent-beta');

    expect(agentForToken(alpha)).toBe('agent-alpha');
    expect(agentForToken(beta)).toBe('agent-beta');
    expect(alpha).not.toBe(beta);
  });

  it('cannot be derived from the agent it names', () => {
    // An agent id is not a secret: it is in every listing and every bus note.
    const token = mintAgentToken('agent-guessable');

    expect(token).toMatch(/^[0-9a-f]{64}$/);
    expect(token).not.toContain('agent-guessable');
    expect(mintAgentToken('agent-guessable')).not.toBe(token);
  });

  it('stops working when the agent is spawned again', () => {
    // A restart is a new process. The one it replaced must not go on speaking
    // for the agent with the pass it was given.
    const before = mintAgentToken('agent-restarted');
    const after = mintAgentToken('agent-restarted');

    expect(agentForToken(before)).toBeUndefined();
    expect(agentForToken(after)).toBe('agent-restarted');
  });

  it('says which agents were started holding one', () => {
    mintAgentToken('agent-with-a-token');

    expect(hasAgentToken('agent-with-a-token')).toBe(true);
    expect(hasAgentToken('agent-started-before-tokens')).toBe(false);
  });

  it('knows nothing about a token it did not mint', () => {
    expect(agentForToken('0'.repeat(64))).toBeUndefined();
    expect(agentForToken('')).toBeUndefined();
  });
});
