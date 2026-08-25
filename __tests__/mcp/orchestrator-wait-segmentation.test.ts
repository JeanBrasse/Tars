import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * Waiting on an agent for longer than five minutes.
 *
 * GET /api/agents/:id/wait is a long poll: it sends no headers at all until
 * the agent's status changes. Node's fetch is undici, whose headersTimeout
 * defaults to 300000ms and is not what the AbortController above the call
 * controls. So a wait over a real piece of work, which is any wait worth
 * making, did not time out cleanly at its own deadline: at five minutes of
 * silence undici cut the socket and it surfaced as "fetch failed".
 *
 * The fix is that no single request is allowed to sit near that ceiling any
 * more. These assert on the requests that actually go out, because the ceiling
 * is a property of one request's duration, and on the wait still running for
 * as long as it was asked to.
 */

/** undici's default, and the thing no request may approach. */
const UNDICI_HEADERS_TIMEOUT_SEC = 300;

vi.mock('../../mcp-orchestrator/src/utils/api.js', () => ({
  apiRequest: (...args: unknown[]) => mockApiRequest(...args),
  getCallerIdentity: () => ({ agentId: 'orch', projectPath: '/tars' }),
}));

let mockApiRequest: ReturnType<typeof vi.fn>;

function makeFakeServer() {
  const tools = new Map<string, (args: Record<string, unknown>) => Promise<unknown>>();
  return {
    tools,
    tool(name: string, _d: string, _s: unknown, handler: (args: Record<string, unknown>) => Promise<unknown>) {
      tools.set(name, handler);
    },
  };
}

async function loadTool(name: string) {
  const { registerAgentTools } = await import('../../mcp-orchestrator/src/tools/agents.js');
  const server = makeFakeServer();
  registerAgentTools(server as never);
  return server.tools.get(name)!;
}

/** The `timeout=` of every /wait request that actually went out, in order. */
function requestedWaits(): number[] {
  return mockApiRequest.mock.calls
    .map(c => String(c[0]))
    .filter(e => e.includes('/wait'))
    .map(e => Number(new URL(e, 'http://x').searchParams.get('timeout')));
}

beforeEach(() => {
  mockApiRequest = vi.fn();
  vi.resetModules();
});

describe('a wait that outlasts the undici ceiling', () => {
  it('is made of segments, none of them near five minutes', async () => {
    const waitForAgent = await loadTool('wait_for_agent');
    let waits = 0;
    mockApiRequest.mockImplementation(async (endpoint: string) => {
      if (endpoint.includes('/wait')) {
        // Three segments of silence, then the agent finishes. Against a
        // single request that is six minutes, past the ceiling.
        waits++;
        return waits <= 3
          ? { status: 'running', timeout: true }
          : { status: 'completed', lastCleanOutput: 'the migration is done' };
      }
      return { agent: { id: 'w', name: 'Worker', status: 'completed', lastCleanOutput: 'the migration is done' } };
    });

    const result = await waitForAgent({ id: 'w', timeoutSeconds: 900 });

    const asked = requestedWaits();
    expect(asked.length).toBeGreaterThan(1);
    for (const seconds of asked) {
      expect(seconds).toBeLessThan(UNDICI_HEADERS_TIMEOUT_SEC);
    }
    // And the 900s the caller asked for was never handed to one request.
    expect(asked).not.toContain(900);
    expect(JSON.stringify(result)).toContain('completed');
  });

  it('keeps waiting across segments instead of reporting a timeout at the first one', async () => {
    const waitForAgent = await loadTool('wait_for_agent');
    let waits = 0;
    mockApiRequest.mockImplementation(async (endpoint: string) => {
      if (endpoint.includes('/wait')) {
        waits++;
        return waits <= 3 ? { status: 'running', timeout: true } : { status: 'completed' };
      }
      return { agent: { id: 'w', name: 'Worker', status: 'completed' } };
    });

    const result = await waitForAgent({ id: 'w', timeoutSeconds: 900 });

    expect(waits).toBe(4);
    // A segment expiring is not the wait expiring, which is the whole point.
    expect(JSON.stringify(result)).not.toContain('Timeout after');
  });

  it('rides out a dropped connection rather than failing the whole wait', async () => {
    const waitForAgent = await loadTool('wait_for_agent');
    let waits = 0;
    mockApiRequest.mockImplementation(async (endpoint: string) => {
      if (endpoint.includes('/wait')) {
        waits++;
        // This is exactly how the undici cut arrived, and how an ordinary
        // network blip arrives too.
        if (waits === 1) throw new TypeError('fetch failed');
        return { status: 'completed' };
      }
      return { agent: { id: 'w', name: 'Worker', status: 'completed' } };
    });

    const result = await waitForAgent({ id: 'w', timeoutSeconds: 900 });

    expect(waits).toBe(2);
    expect(JSON.stringify(result)).toContain('completed');
  });

  it('still reports a timeout when the agent really never moves', async () => {
    const waitForAgent = await loadTool('wait_for_agent');
    mockApiRequest.mockImplementation(async (endpoint: string) => {
      if (endpoint.includes('/wait')) return { status: 'running', timeout: true };
      return { agent: { id: 'w', name: 'Worker', status: 'running' } };
    });

    // Short enough to be one segment: the deadline is still the caller's.
    const result = await waitForAgent({ id: 'w', timeoutSeconds: 2 });

    const asked = requestedWaits();
    expect(asked[0]).toBe(2);
    // This server answers instantly, which is not a poll being held open. The
    // wait must not become a hot loop against the API because of it: a couple
    // of requests over two seconds, not hundreds.
    expect(asked.length).toBeLessThanOrEqual(3);
    expect(JSON.stringify(result)).toContain('Timeout after 2s');
  }, 15000);

  it('gives up when the connection keeps dying, rather than looping forever', async () => {
    const waitForAgent = await loadTool('wait_for_agent');
    let waits = 0;
    mockApiRequest.mockImplementation(async (endpoint: string) => {
      if (endpoint.includes('/wait')) { waits++; throw new TypeError('fetch failed'); }
      return { agent: { id: 'w', name: 'Worker', status: 'running' } };
    });

    const result = await waitForAgent({ id: 'w', timeoutSeconds: 900 });

    expect(waits).toBeLessThanOrEqual(4);
    expect(JSON.stringify(result)).toMatch(/fetch failed|Error/i);
  });
});

describe('delegate_task, which waits the same way', () => {
  it('segments its wait too, so a long delegation survives', async () => {
    const delegateTask = await loadTool('delegate_task');
    let waits = 0;
    mockApiRequest.mockImplementation(async (endpoint: string) => {
      if (endpoint.includes('/run-task')) throw new Error('no ACP mode');
      if (endpoint.includes('/dispatch')) {
        return { success: true, mode: 'message', agent: { id: 'w', name: 'Worker', status: 'running' } };
      }
      if (endpoint.includes('/wait')) {
        waits++;
        return waits <= 4 ? { status: 'running', timeout: true } : { status: 'completed', lastCleanOutput: 'done' };
      }
      return { agent: { id: 'w', name: 'Worker', status: 'completed', lastCleanOutput: 'done' } };
    });

    await delegateTask({ id: 'w', prompt: 'migrate the schema', timeoutSeconds: 900 });

    const asked = requestedWaits();
    expect(asked.length).toBeGreaterThan(1);
    for (const seconds of asked) expect(seconds).toBeLessThan(UNDICI_HEADERS_TIMEOUT_SEC);
  });
});
