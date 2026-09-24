import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

/**
 * memory_search does not hand an agent Noah's conversation with the super chat
 * (the Audit's table on a3d7c125, #13).
 *
 * SECURITY.md §5 says that conversation lives in ~/.tars-private and is never
 * handed to an agent. The super chat holds it with Hermes, though, and each
 * turn is a Hermes session: a live one (session.create), or a run of its cron
 * job, `cron_<jobId>_<date>_<time>`. memory_search asks Hermes to search every
 * session, and returned those with the rest.
 *
 * How it fails, written before the code (2026-09-24):
 * 1. A session the super chat opened live is returned to an agent.
 * 2. A run of the super chat's cron job is returned to an agent.
 * 3. A hit the gateway gives without a session id, which nothing can tell
 *    apart, is returned to an agent.
 * 4. Noah's own sessions stop being searchable by his agents.
 *
 * The overseer and the memory route are the real ones; the live transport
 * and the gateway's search are fakes.
 */

vi.mock('electron', () => ({ ipcMain: { handle: () => undefined } }));
vi.mock('../../../electron/core/agent-manager', () => ({ agents: new Map() }));
vi.mock('../../../electron/services/git-review', () => ({ repoSummary: async () => ({ branch: 'main', status: [] }) }));
vi.mock('../../../electron/services/hermes-session', () => ({
  liveTransportAvailable: () => true,
  createLiveSession: async () => ({
    session: { sessionId: 'live-overseer-1', storedSessionId: 'stored-overseer-1' },
    control: { close: () => {} },
  }),
  askLiveSession: async () => ({ ok: true, envelope: '{"say":"Answered live.","action":null}' }),
}));
const gateway = vi.hoisted(() => ({ hits: [] as Array<Record<string, unknown>> }));
vi.mock('../../../electron/services/hermes-client', async importOriginal => ({
  ...(await importOriginal<typeof import('../../../electron/services/hermes-client')>()),
  searchHermesSessions: async () => ({ success: true, hits: gateway.hits }),
}));

type Handler = (req: unknown, sendJson: (body: unknown, status?: number) => void) => Promise<void>;
let search: Handler;
let overseer: typeof import('../../../electron/services/overseer');
let store: typeof import('../../../electron/services/overseer-store');

async function agentSearches(q: string): Promise<Array<{ ref?: string; source: string }>> {
  let answer: { hits: Array<{ ref?: string; source: string }> } = { hits: [] };
  const url = new URL(`http://localhost/api/memory/search?q=${encodeURIComponent(q)}&sources=hermes`);
  await search({ url, body: {}, params: {} }, body => { answer = body as typeof answer; });
  return answer.hits;
}

beforeAll(async () => {
  const { HERMES_CONNECTION_FILE } = await import('../../../electron/services/hermes-config');
  fs.mkdirSync(path.dirname(HERMES_CONNECTION_FILE), { recursive: true });
  fs.writeFileSync(HERMES_CONNECTION_FILE, JSON.stringify({ mode: 'remote', url: 'http://127.0.0.1:1', authMode: 'token' }), { mode: 0o600 });
  overseer = await import('../../../electron/services/overseer');
  store = await import('../../../electron/services/overseer-store');
  const { registerMemoryRoutes } = await import('../../../electron/services/api-routes/memory-routes');
  const routes: Array<{ pattern: unknown; handler: Handler }> = [];
  const app = {
    add(_m: string, pattern: unknown, handler: Handler) { routes.push({ pattern, handler }); },
    get(p: unknown, h: Handler) { this.add('GET', p, h); },
    post(p: unknown, h: Handler) { this.add('POST', p, h); },
    put(p: unknown, h: Handler) { this.add('PUT', p, h); },
    delete(p: unknown, h: Handler) { this.add('DELETE', p, h); },
  };
  registerMemoryRoutes(app as never, { getAppSettings: () => ({}) } as never);
  search = routes.find(r => r.pattern === '/api/memory/search')!.handler;
});

beforeEach(() => {
  overseer.resetLiveSession();
  gateway.hits = [];
});

describe('memory_search, as an agent calls it', () => {
  it('1, 4. leaves out a session the super chat opened live, and keeps Noah\'s own', async () => {
    await overseer.askOverseer('What is everyone doing?');
    gateway.hits = [
      { sessionId: 'live-overseer-1', title: 'overseer', snippet: 'Noah asked the super chat' },
      { sessionId: 'stored-overseer-1', title: 'overseer', snippet: 'the same, by its stored id' },
      { sessionId: 'noah-own-1', title: 'deploy notes', snippet: 'the deploy key rotates on Fridays' },
    ];

    const hits = await agentSearches('deploy');

    expect(hits.map(h => h.ref)).toEqual(['noah-own-1']);
  });

  it('2. leaves out the runs of the super chat\'s cron job', async () => {
    const state = store.loadState();
    store.saveState({ ...state, jobId: 'job-overseer' });
    gateway.hits = [
      { sessionId: 'cron_job-overseer_20260924_101010', snippet: 'a fallback turn' },
      { sessionId: 'cron_other-job_20260924_101010', snippet: 'another cron of Noah\'s' },
    ];

    const hits = await agentSearches('turn');

    expect(hits.map(h => h.ref)).toEqual(['cron_other-job_20260924_101010']);
  });

  it('3. leaves out a hit that names no session', async () => {
    gateway.hits = [{ title: 'untitled', snippet: 'no session id at all' }, { sessionId: 'noah-own-2', snippet: 'kept' }];

    const hits = await agentSearches('id');

    expect(hits.map(h => h.ref)).toEqual(['noah-own-2']);
  });

  it('remembers the super chat\'s live sessions across a restart of Tars', async () => {
    await overseer.askOverseer('And now?');
    const saved = fs.readFileSync(path.join(os.homedir(), '.tars-private', 'overseer.json'), 'utf-8');
    expect(saved).toContain('live-overseer-1');
    expect(saved).toContain('stored-overseer-1');
  });
});
