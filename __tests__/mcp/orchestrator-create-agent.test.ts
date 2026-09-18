import { describe, it, expect, vi, beforeEach } from 'vitest';
import { z } from 'zod';

/**
 * create_agent can ask for an agent in another project, and only when told to.
 *
 * Since lot 4 the API holds creation to the line it holds every route that
 * drives an agent: an agent adds to its own project, and to another only with
 * allowCrossProject. The five other tools that act on an agent already carried
 * that flag; this one did not, so the refusal would have told an orchestrator
 * to pass a flag it had no way to pass.
 *
 * The tool is the real one, registered on a fake server that validates the
 * arguments against the tool's own schema the way the SDK does, so a flag the
 * schema does not declare is dropped here as it would be there.
 */

vi.mock('../../mcp-orchestrator/src/utils/api.js', () => ({
  apiRequest: (...args: unknown[]) => mockApiRequest(...args),
  getCallerIdentity: () => ({ agentId: 'agent-alpha', projectPath: '/projects/alpha' }),
}));

let mockApiRequest: ReturnType<typeof vi.fn>;

function makeFakeServer() {
  const tools = new Map<string, (args: Record<string, unknown>) => Promise<unknown>>();
  return {
    tools,
    tool(name: string, _desc: string, schema: z.ZodRawShape, handler: (args: Record<string, unknown>) => Promise<unknown>) {
      tools.set(name, args => handler(z.object(schema).parse(args)));
    },
  };
}

async function loadCreateAgent() {
  const { registerAgentTools } = await import('../../mcp-orchestrator/src/tools/agents.js');
  const server = makeFakeServer();
  registerAgentTools(server as never);
  return server.tools.get('create_agent')!;
}

beforeEach(() => {
  mockApiRequest = vi.fn(async () => ({ agent: { id: 'new', name: 'fresh' } }));
  vi.resetModules();
});

describe('create_agent', () => {
  it('passes allowCrossProject on when it is asked to', async () => {
    const create = await loadCreateAgent();

    await create({ projectPath: '/projects/beta', name: 'fresh', allowCrossProject: true });

    const [endpoint, method, body] = mockApiRequest.mock.calls[0];
    expect([endpoint, method]).toEqual(['/api/agents', 'POST']);
    expect(body).toMatchObject({ projectPath: '/projects/beta', allowCrossProject: true });
  });

  it('does not cross on its own', async () => {
    const create = await loadCreateAgent();

    await create({ projectPath: '/projects/beta', name: 'fresh' });

    const [, , body] = mockApiRequest.mock.calls[0];
    expect((body as Record<string, unknown>).allowCrossProject).toBeUndefined();
  });
});
