import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mount, settle, type Mount } from './hook-runtime';
import { useElectronAgents } from '../../src/hooks/useElectron';
import { claudeAccountActions } from '../../src/hooks/useClaudeAccounts';
import type { AgentStatus, ClaudeAccountAgentChange } from '../../src/types/electron';

vi.mock('react', async (importOriginal) => ({
  ...(await importOriginal<typeof import('react')>()),
  ...(await import('./hook-runtime')).hooks,
}));

/**
 * A pin, or the account an agent runs on, must reach the agent as the window
 * holds it, so its card, pane header and window say it. Main tells every
 * window on claude-accounts:agent-changed (#263, after its gates), whether the
 * change came from this window's control, from another window, or from main
 * itself (an account removed clears its pins). Written before the code, as the
 * ways it can fail:
 * 1. a change main pushes never reaches the agent this window holds: the list
 *    listened only to a pin made in its own window;
 * 2. it reaches another agent, or a pin cleared or a return to account 1,
 *    which main says as null, leaves the old value shown;
 * 3. the push reads the whole list again, when it carries both fields;
 * 4. a read of the list drops a record where only the account moved, because
 *    the list compares neither field;
 * 5. a pin main refused changes anything, or asks for anything again;
 * 6. a window that closed keeps listening.
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
/** What main's broadcastToAllWindows reaches in this window. */
const heard = new Set<(change: ClaudeAccountAgentChange) => void>();
const push = (change: ClaudeAccountAgentChange) => { for (const listener of heard) listener(change); };
const shown = (id = 'a1') => hook.result.agents.find(a => a.id === id) as ListedAgent;

beforeEach(async () => {
  listed = [agent(), agent({ id: 'a2', name: 'Worker Two' })];
  listCalls = 0;
  pinAnswer = { success: true };
  heard.clear();
  const noop = () => () => {};
  g.window = Object.assign(new EventTarget(), {
    electronAPI: {
      agent: { list: async () => { listCalls++; return listed; }, onOutput: noop, onError: noop, onComplete: noop, onStatus: noop, onTick: noop },
      claudeAccounts: {
        onAgentChanged: (listener: (change: ClaudeAccountAgentChange) => void) => { heard.add(listener); return () => { heard.delete(listener); }; },
        // As main does: a pin it saves is announced to every window, this one included.
        setAgentAccount: async (p: { agentId: string; accountId: string | null }) => {
          if (pinAnswer.success) push({ agentId: p.agentId, claudeAccountId: null, claudeAccountPin: p.accountId });
          return pinAnswer;
        },
      },
    },
  });
  hook = mount(() => useElectronAgents());
  await settle();
});

afterEach(() => {
  hook.unmount();
  delete g.window;
});

describe('a change main pushes (1, 2, 3)', () => {
  it('shows a pin made in another window, on that agent only, without reading the list again', async () => {
    const before = listCalls;
    const other = shown('a2');
    push({ agentId: 'a1', claudeAccountId: 'acct-000002', claudeAccountPin: 'acct-000002' });
    await settle();
    expect(shown().claudeAccountPin).toBe('acct-000002');
    expect(shown().claudeAccountId).toBe('acct-000002');
    expect(shown('a2')).toBe(other);
    expect(listCalls).toBe(before);
  });

  it("shows a pin made from this window's control, through main's push", async () => {
    const before = listCalls;
    await claudeAccountActions.setAgentAccount({ agentId: 'a1', accountId: 'acct-000002' });
    await settle();
    expect(shown().claudeAccountPin).toBe('acct-000002');
    expect(listCalls).toBe(before);
  });

  it('clears a pin, and goes back to account 1, when main says null', async () => {
    push({ agentId: 'a1', claudeAccountId: 'acct-000002', claudeAccountPin: 'acct-000002' });
    await settle();
    expect(shown().claudeAccountPin).toBe('acct-000002');
    push({ agentId: 'a1', claudeAccountId: null, claudeAccountPin: null });
    await settle();
    expect(shown().claudeAccountPin ?? null).toBeNull();
    expect(shown().claudeAccountId ?? null).toBeNull();
  });
});

describe('a read of the list (4)', () => {
  it('keeps a record where only the account it was launched on moved', async () => {
    listed = [agent({ claudeAccountId: 'acct-000002' })];
    await hook.result.refresh();
    await settle();
    expect(shown().claudeAccountId).toBe('acct-000002');
  });
});

describe('a refused pin (5)', () => {
  it('changes nothing, and asks for nothing again', async () => {
    pinAnswer = { success: false, error: 'There is no such account.' };
    const before = listCalls;
    await claudeAccountActions.setAgentAccount({ agentId: 'a1', accountId: 'acct-gone00' });
    await settle();
    expect(shown().claudeAccountPin).toBeUndefined();
    expect(listCalls).toBe(before);
  });
});

describe('a window that closed (6)', () => {
  it('stops listening', () => {
    expect(heard.size).toBe(1);
    hook.unmount();
    expect(heard.size).toBe(0);
    hook = mount(() => useElectronAgents());
  });
});
