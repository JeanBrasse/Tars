import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * ask_noah: the tool an agent asks Noah with, on his Telegram (step 2 of the
 * relay plan). It posts through Tars (`/api/noah/ask`), which decides who is
 * asking from the agent's own token, sends the question and types the answer
 * back into the agent's terminal.
 *
 * The tool is the real one, on a fake server that validates the arguments with
 * the tool's own schema (orchestrator-send-discord.test.ts does the same).
 *
 * How it fails, written before the code (2026-09-28):
 * 1. It posts anywhere but /api/noah/ask, or not the question and context.
 * 2. It answers as if Noah had answered: the agent must be told his answer
 *    comes later, typed into its terminal after "Message from Noah via
 *    Telegram:", and nothing else carries it.
 * 3. A refusal of Tars's (a question already open, the day's limit, no
 *    Telegram) is not said in Tars's words.
 * 4. It takes a call with no question.
 */

vi.mock('../../mcp-orchestrator/src/utils/api.js', () => ({
  apiRequest: (...args: unknown[]) => mockApiRequest(...args),
  getCallerIdentity: () => ({ agentId: 'agent-lead', projectPath: '/projects/alpha' }),
}));

let mockApiRequest: ReturnType<typeof vi.fn>;
type FieldSchema = { parse(value: unknown): unknown };
type Answer = { content: Array<{ text: string }>; isError?: boolean };

async function loadAskNoah() {
  const tools = new Map<string, { description: string; run: (args: Record<string, unknown>) => Promise<Answer> }>();
  const server = {
    tool(name: string, description: string, shape: Record<string, FieldSchema>, handler: (args: Record<string, unknown>) => Promise<Answer>) {
      tools.set(name, {
        description,
        run: args => {
          const parsed: Record<string, unknown> = {};
          for (const [key, field] of Object.entries(shape)) {
            const value = field.parse(args[key]);
            if (value !== undefined) parsed[key] = value;
          }
          return handler(parsed);
        },
      });
    },
  };
  const { registerMessagingTools } = await import('../../mcp-orchestrator/src/tools/messaging.js');
  registerMessagingTools(server as never);
  return tools.get('ask_noah')!;
}

beforeEach(() => {
  mockApiRequest = vi.fn(async () => ({ success: true, id: 'q-1', expiresAt: '2026-09-28T12:00:00.000Z' }));
  vi.resetModules();
});

describe('ask_noah', () => {
  it('1, 2. posts the question through Tars, and says the answer comes later, typed after Noah\'s line', async () => {
    const ask = await loadAskNoah();
    const r = await ask.run({ question: 'Staging or prod?', context: 'The migration touches billing.' });

    expect(mockApiRequest).toHaveBeenCalledWith('/api/noah/ask', 'POST', { question: 'Staging or prod?', context: 'The migration touches billing.' });
    expect(r.isError).toBeUndefined();
    expect(r.content[0].text).toContain('Message from Noah via Telegram:');
    expect(r.content[0].text).toContain('2026-09-28T12:00:00.000Z');
    expect(ask.description).toMatch(/Telegram/);
  });

  it('3. says what Tars refused, in its words', async () => {
    mockApiRequest = vi.fn(async () => { throw new Error('You already have a question open for Noah'); });
    const ask = await loadAskNoah();
    const r = await ask.run({ question: 'Again?' });
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toBe('Error asking Noah: You already have a question open for Noah');
  });

  it('4. needs a question', async () => {
    const ask = await loadAskNoah();
    await expect((async () => ask.run({ context: 'no question' }))()).rejects.toThrow();
  });
});
