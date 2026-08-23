import { describe, it, expect, vi, beforeEach } from 'vitest';

// ============================================================================
// delegate_task's auto-continue path: when the target agent hits a
// non-permission "waiting" state (Claude Code asking "should I continue?"),
// delegate_task answers "Yes, continue" on the caller's behalf so the
// orchestrator does not have to notice and nudge it itself.
//
// Bug: the retry loop was capped at exactly one attempt. An agent that asks
// a second (or third) confirmation question mid-task made delegate_task give
// up and report "still waiting", pushing the retry back onto the calling
// orchestrator - which is precisely the "have to ask 15 times" complaint.
// ============================================================================

vi.mock('../../mcp-orchestrator/src/utils/api.js', () => ({
  apiRequest: (...args: unknown[]) => mockApiRequest(...args),
  getCallerIdentity: () => ({ agentId: '', projectPath: '' }),
}));

let mockApiRequest: ReturnType<typeof vi.fn>;

// Minimal fake McpServer that just captures the registered tool handlers,
// the same pattern agent-routes.test.ts uses for RouteApp.
function makeFakeServer() {
  const tools = new Map<string, (args: Record<string, unknown>) => Promise<unknown>>();
  return {
    tools,
    tool(name: string, _desc: string, _schema: unknown, handler: (args: Record<string, unknown>) => Promise<unknown>) {
      tools.set(name, handler);
    },
  };
}

beforeEach(() => {
  mockApiRequest = vi.fn();
  vi.resetModules();
});

describe('delegate_task auto-continue', () => {
  async function loadDelegateTask() {
    const { registerAgentTools } = await import('../../mcp-orchestrator/src/tools/agents.js');
    const server = makeFakeServer();
    registerAgentTools(server as never);
    return server.tools.get('delegate_task')!;
  }

  it('keeps auto-continuing through repeated confirmation prompts until the agent completes', async () => {
    const delegateTask = await loadDelegateTask();

    mockApiRequest.mockImplementation(async (endpoint: string, method?: string) => {
      // No ACP mode for this agent: falls straight to the /dispatch path.
      if (endpoint.includes('/run-task')) throw new Error('no ACP mode');
      if (endpoint.includes('/dispatch')) {
        return { success: true, mode: 'message', agent: { id: 'a1', name: 'Worker', status: 'running' } };
      }
      if (endpoint.includes('/wait')) {
        // Asks for confirmation THREE times in a row before actually
        // finishing - a realistic Claude Code session mid multi-step task.
        const calls = mockApiRequest.mock.calls.filter(c => String(c[0]).includes('/wait')).length;
        if (calls <= 3) return { status: 'waiting', waitingReason: 'idle' };
        return { status: 'completed', lastCleanOutput: 'all done' };
      }
      if (!method || method === 'GET') {
        return { agent: { status: 'completed', name: 'Worker', lastCleanOutput: 'all done' } };
      }
      return {};
    });

    const result = await delegateTask({ id: 'a1', prompt: 'do the multi-step task', timeoutSeconds: 300 }) as {
      content: { text: string }[];
      isError?: boolean;
    };

    // Must have auto-answered every confirmation, not just the first, and
    // ultimately report completion rather than giving up mid-task.
    const dispatchCalls = mockApiRequest.mock.calls.filter(c => String(c[0]).includes('/dispatch'));
    expect(dispatchCalls.length).toBeGreaterThanOrEqual(4); // 1 initial + 3 auto-continues
    expect(result.isError).not.toBe(true);
    expect(result.content[0].text).toContain('completed');
    expect(result.content[0].text).not.toContain('still waiting');
  });

  it('still bails out immediately on a permission dialog rather than typing into it', async () => {
    const delegateTask = await loadDelegateTask();

    mockApiRequest.mockImplementation(async (endpoint: string) => {
      if (endpoint.includes('/run-task')) throw new Error('no ACP mode');
      if (endpoint.includes('/dispatch')) {
        return { success: true, mode: 'message', agent: { id: 'a1', name: 'Worker', status: 'running' } };
      }
      if (endpoint.includes('/wait')) {
        return { status: 'waiting', waitingReason: 'permission' };
      }
      return { agent: { status: 'waiting', name: 'Worker' } };
    });

    const result = await delegateTask({ id: 'a1', prompt: 'do something risky', timeoutSeconds: 300 }) as {
      content: { text: string }[];
      isError?: boolean;
    };

    const dispatchCalls = mockApiRequest.mock.calls.filter(c => String(c[0]).includes('/dispatch'));
    // Exactly the one initial dispatch - never auto-answer a permission dialog.
    expect(dispatchCalls.length).toBe(1);
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('PERMISSION dialog');
  });

  it('eventually gives up and hands back to the orchestrator if an agent never stops asking', async () => {
    const delegateTask = await loadDelegateTask();

    mockApiRequest.mockImplementation(async (endpoint: string) => {
      if (endpoint.includes('/run-task')) throw new Error('no ACP mode');
      if (endpoint.includes('/dispatch')) {
        return { success: true, mode: 'message', agent: { id: 'a1', name: 'Worker', status: 'running' } };
      }
      if (endpoint.includes('/wait')) {
        return { status: 'waiting', waitingReason: 'idle' };
      }
      return { agent: { status: 'waiting', name: 'Worker' } };
    });

    const result = await delegateTask({ id: 'a1', prompt: 'never finishes', timeoutSeconds: 60 }) as {
      content: { text: string }[];
      isError?: boolean;
    };

    // Bounded, not infinite: some cap must still exist.
    const dispatchCalls = mockApiRequest.mock.calls.filter(c => String(c[0]).includes('/dispatch'));
    expect(dispatchCalls.length).toBeGreaterThan(1);
    expect(dispatchCalls.length).toBeLessThan(20);
    expect(result.content[0].text.toLowerCase()).toContain('waiting');
  });
});
