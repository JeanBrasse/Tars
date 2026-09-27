import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { EventEmitter } from 'node:events';

/**
 * The MCP servers that had no deadline at all: a host that stops answering
 * left the tool waiting until Claude Code gave up on the call, about half an
 * hour later, with nothing said to the agent (QA's gate of #207). mcp-vault
 * calls Tars; mcp-socialdata and mcp-x call their APIs. mcp-telegram's two
 * requests are proven by the contract instead (__tests__/mcp/contracts): its
 * tools live in its index.ts, which starts the server as it loads.
 *
 * How this can fail, written before the code:
 * 1. the request sets no deadline, so a silent host is waited on for ever;
 * 2. the deadline passes and the request goes on;
 * 3. it ends without saying how long it waited, in the words every server here
 *    shares ("no answer within N s", noAnswerWithin in mcp-shared), or without
 *    the server's own words for the host that did not answer;
 * 4. the deadline is out of proportion: over two minutes, which is no deadline
 *    to an agent waiting on a tool, or under ten seconds, which cuts off an
 *    answer that is only slow.
 *
 * The transport is replaced and nothing else, as in kanban-api-timeout.test.ts:
 * the real clients build their requests, and these read the deadline each one
 * set and what it does when that deadline passes. Nothing leaves the process.
 */

type FakeRequest = EventEmitter & { destroyed: boolean };
const sent = vi.hoisted(() => [] as Array<{ options: Record<string, unknown>; req: FakeRequest }>);

async function transport(actual: Record<string, unknown>) {
  const { EventEmitter } = await import('node:events');
  const request = (options: Record<string, unknown>) => {
    const req = Object.assign(new EventEmitter(), {
      destroyed: false,
      write: () => {},
      end: () => {},
      setTimeout(ms: number) { options.timeout = ms; return req; },
      destroy(err?: Error) { req.destroyed = true; if (err) req.emit('error', err); return req; },
    });
    sent.push({ options, req });
    return req;
  };
  return { ...actual, request, default: { ...actual, request } };
}
vi.mock('http', async importOriginal => transport(await importOriginal()));
vi.mock('https', async importOriginal => transport(await importOriginal()));

const SETTINGS = path.join(os.homedir(), '.dorothy', 'app-settings.json');

const NAMES = ['mcp-vault (Tars)', 'mcp-socialdata (SocialData)', 'mcp-x (X)'];
/** Each client, as its tools call it, and the words it has for a host it could not reach. */
const CLIENTS = new Map<string, [RegExp, () => Promise<unknown>]>();

beforeAll(async () => {
  fs.mkdirSync(path.dirname(SETTINGS), { recursive: true });
  fs.writeFileSync(SETTINGS, JSON.stringify({
    socialDataApiKey: 'key', xApiKey: 'k', xApiSecret: 's', xAccessToken: 't', xAccessTokenSecret: 'ts', xPostingEnabled: true,
  }));
  const vault = await import('../../mcp-vault/src/utils/api');
  const socialData = await import('../../mcp-socialdata/src/utils/api');
  const x = await import('../../mcp-x/src/utils/api');
  CLIENTS.set(NAMES[0], [/^API request failed: /, () => vault.apiRequest('GET', '/api/vault/documents/d1')]);
  CLIENTS.set(NAMES[1], [/^SocialData API request failed: /, () => socialData.socialDataRequest('GET', '/twitter/search', { query: 'tars' })]);
  CLIENTS.set(NAMES[2], [/^X API request failed: /, () => x.xApiRequest('POST', '/2/tweets', { text: 'Hi' })]);
});

beforeEach(() => { sent.length = 0; });

/** What became of a call 200 ms after its deadline passed: its error, or that it is still waiting. */
async function afterTheDeadline(call: () => Promise<unknown>): Promise<{ deadline: unknown; outcome: unknown; req: FakeRequest }> {
  const pending = call();
  expect(sent).toHaveLength(1);
  const { options, req } = sent[0];
  req.emit('timeout');
  const outcome = await Promise.race([
    pending.then(() => 'answered', (err: unknown) => err),
    new Promise(resolve => setTimeout(() => resolve('still waiting'), 200)),
  ]);
  return { deadline: options.timeout, outcome, req };
}

describe('the MCP servers that call out, when the host does not answer', () => {
  it.each(NAMES)('%s sets a deadline in proportion (1, 4)', async (name) => {
    const [, call] = CLIENTS.get(name)!;
    void call().catch(() => {});
    const deadline = sent[0]?.options.timeout;
    expect(typeof deadline, `${name} sets no deadline`).toBe('number');
    expect(deadline as number, name).toBeGreaterThanOrEqual(10_000);
    expect(deadline as number, name).toBeLessThanOrEqual(120_000);
  });

  it.each(NAMES)('%s ends the request when its deadline passes, and says how long it waited, in its own words (2, 3)', async (name) => {
    const [words, call] = CLIENTS.get(name)!;
    const { deadline, outcome, req } = await afterTheDeadline(call);
    expect(outcome, `${name} is still waiting`).toBeInstanceOf(Error);
    expect(req.destroyed, name).toBe(true);
    const message = (outcome as Error).message;
    expect(message, name).toMatch(words);
    expect(message, name).toContain(`no answer within ${(deadline as number) / 1000} s`);
  });
});
