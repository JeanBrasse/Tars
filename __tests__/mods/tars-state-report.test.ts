/**
 * The state mod's posts to Tars (mods/tars-state/hooks/register.ts).
 *
 * From the Audit's gate of #308 (Low): the posts were fire and forget, and a
 * response other than 2xx was not looked at either. For a session the mod
 * registered, Tars sets aside the shell hook's post for the same event, so a
 * Stop's `idle` lost or refused (Tars busy, a 503) left the agent reading
 * `running` until its next turn, and the heartbeat kept it from the stall
 * watch.
 *
 * How it fails, written before the code (2026-10-05):
 * 1. A post whose request fails, or that Tars answers with no 2xx, is not
 *    sent again: the event is lost.
 * 2. A post sent again lands after the next event's, or holds the next one
 *    back for good: the order of the events must hold, and a post that keeps
 *    failing is given up after three tries.
 * 3. A post Tars took (2xx) is sent again: a second idle, a second
 *    "finished" notice.
 * 4. The tries come back to back, into a Tars that is busy.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createHash } from 'node:crypto';

type Hook = ($: unknown, e: unknown, next: (e: unknown) => Promise<unknown>) => unknown;
type Reply = { status: number; ok: boolean; text: string };

const ENV: Record<string, string> = {
  CLAUDE_AGENT_ID: 'a1', CLAUDE_MGR_API_URL: 'http://127.0.0.1:1', CLAUDE_MGR_API_TOKEN: 'tok', TARS_INSTANCE_ID: 'inst',
};
const SESSION = '11111111-1111-4111-8111-111111111111';

let hooks: Map<string, Hook>;
let sent: Array<{ route: string; body: Record<string, unknown> }>;
let replies: Array<Reply | Error>;
let slept: number[];

const ok: Reply = { status: 200, ok: true, text: '{"success":true}' };

const $ = {
  env: { get: async (name: string) => ENV[name] },
  clock: { every: () => undefined, sleep: async (ms: number) => { slept.push(ms); } },
  http: {
    fetch: async (url: string, init?: { body?: string }) => {
      if (url.includes('/api/health')) {
        const challenge = new URL(url).searchParams.get('challenge');
        return { status: 200, ok: true, headers: {}, text: JSON.stringify({ proof: createHash('sha256').update(`inst:${challenge}`).digest('hex') }) };
      }
      const route = new URL(url).pathname;
      sent.push({ route, body: JSON.parse(init?.body ?? '{}') });
      const reply = replies.shift() ?? ok;
      if (reply instanceof Error) throw reply;
      return { headers: {}, ...reply };
    },
  },
};

async function load(): Promise<void> {
  vi.resetModules();
  hooks = new Map();
  const mod = await import('../../mods/tars-state/hooks/register');
  mod.register(((event: string, hook: Hook) => { hooks.set(event, hook); }) as never);
}

const fire = (event: string, e: Record<string, unknown>) => hooks.get(event)!($, e, async x => x);
/** The posts, in the order Tars got them, once the mod's queue has drained. */
async function drained(): Promise<string[]> {
  for (let i = 0; i < 50; i++) await new Promise(r => setTimeout(r, 0));
  return sent.map(s => `${s.route} ${String(s.body.status ?? '')}`.trim());
}

beforeEach(async () => {
  sent = [];
  replies = [];
  slept = [];
  await load();
  await fire('classic.SessionStart', { session_id: SESSION, source: 'startup' });
  await drained();
  sent = [];
});

describe("the mod's posts", () => {
  it('1, 2. a Stop whose idle fails once is sent again, before the posts after it', async () => {
    replies = [ok, new Error('socket hang up')];
    await fire('classic.Stop', { session_id: SESSION, last_assistant_message: 'done' });
    expect(await drained()).toEqual([
      '/api/hooks/output', '/api/hooks/status idle', '/api/hooks/status idle', '/api/hooks/agent-stopped',
    ]);
  });

  it('1. a post Tars answers with no 2xx is sent again', async () => {
    replies = [ok, { status: 503, ok: false, text: '{"error":"busy"}' }];
    await fire('classic.Stop', { session_id: SESSION, last_assistant_message: 'done' });
    expect((await drained()).filter(p => p === '/api/hooks/status idle')).toHaveLength(2);
  });

  it('2. gives a post up after three tries, and the next event still goes', async () => {
    replies = [new Error('down'), new Error('down'), new Error('down')];
    await fire('classic.UserPromptSubmit', { session_id: SESSION, prompt: 'go' });
    await fire('classic.Stop', { session_id: SESSION });
    expect(await drained()).toEqual([
      '/api/hooks/status running', '/api/hooks/status running', '/api/hooks/status running',
      '/api/hooks/status idle', '/api/hooks/agent-stopped',
    ]);
  });

  it('3. a post Tars took is sent once', async () => {
    await fire('classic.Stop', { session_id: SESSION });
    expect(await drained()).toEqual(['/api/hooks/status idle', '/api/hooks/agent-stopped']);
    expect(slept).toEqual([]);
  });

  it('4. waits between tries, longer each time', async () => {
    replies = [new Error('down'), new Error('down')];
    await fire('classic.Stop', { session_id: SESSION });
    await drained();
    expect(slept.length).toBe(2);
    expect(slept[0]).toBeGreaterThan(0);
    expect(slept[1]).toBeGreaterThan(slept[0]);
  });
});
