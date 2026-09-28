import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mount, settle, type Mount } from './hook-runtime';
import { useElectronAgents } from '../../src/hooks/useElectron';
import { claudeAccountActions } from '../../src/hooks/useClaudeAccounts';
import type { AgentStatus } from '../../src/types/electron';

vi.mock('react', async (importOriginal) => ({
  ...(await importOriginal<typeof import('react')>()),
  ...(await import('./hook-runtime')).hooks,
}));

/**
 * A pin made from an agent's account control must reach the agent as the
 * window holds it, so its card, pane header and window say `· pinned`. Main
 * saves the pin (#263's claude-accounts:set-agent-account) and sends no agent
 * event for it, and the window's list keeps its old records unless a field it
 * compares has moved. Written before the code, as the ways it can fail:
 * 1. a pin main confirmed is never read back: nothing asks agent:list again;
 * 2. it is read back and dropped, because the list compares neither the pin
 *    nor the account the agent was launched on;
 * 3. a pin main refused asks for the list again all the same.
 */

type ListedAgent = AgentStatus & { claudeAccountPin?: string; claudeAccountId?: string };
const g = globalThis as unknown as { window?: unknown };

function agent(over: Partial<ListedAgent> = {}): ListedAgent {
  return { id: 'a1', name: 'Worker One', status: 'idle', projectPath: '/tmp/p', provider: 'claude', skills: [], output: [], lastActivity: '2026-09-28T08:00:00.000Z', currentTask: '', ...over } as unknown as ListedAgent;
}

let hook: Mount<ReturnType<typeof useElectronAgents>>;
let listed: ListedAgent[];
let listCalls: number;
let pinAnswer: { success: true } | { success: false; error: string };

beforeEach(async () => {
  listed = [agent()];
  listCalls = 0;
  pinAnswer = { success: true };
  const noop = () => () => {};
  // A window that carries events, as the page's does.
  g.window = Object.assign(new EventTarget(), {
    electronAPI: {
      agent: { list: async () => { listCalls++; return listed; }, onOutput: noop, onError: noop, onComplete: noop, onStatus: noop, onTick: noop },
      claudeAccounts: { setAgentAccount: async () => pinAnswer },
    },
  });
  hook = mount(() => useElectronAgents());
  await settle();
});

afterEach(() => {
  hook.unmount();
  delete g.window;
});

describe('a pin reaches the window (1, 2)', () => {
  it('reads the agents again once main has confirmed a pin, and keeps the pin it reads', async () => {
    listed = [agent({ claudeAccountPin: 'acct-000002' })];
    const before = listCalls;
    await claudeAccountActions.setAgentAccount({ agentId: 'a1', accountId: 'acct-000002' });
    await settle();
    expect(listCalls).toBe(before + 1);
    expect((hook.result.agents[0] as ListedAgent).claudeAccountPin).toBe('acct-000002');
  });

  it('keeps a record where only the account it was launched on moved', async () => {
    listed = [agent({ claudeAccountId: 'acct-000002' })];
    await hook.result.refresh();
    await settle();
    expect((hook.result.agents[0] as ListedAgent).claudeAccountId).toBe('acct-000002');
  });
});

describe('a refused pin (3)', () => {
  it('asks for nothing again', async () => {
    pinAnswer = { success: false, error: 'There is no such account.' };
    const before = listCalls;
    await claudeAccountActions.setAgentAccount({ agentId: 'a1', accountId: 'acct-gone00' });
    await settle();
    expect(listCalls).toBe(before);
  });
});
