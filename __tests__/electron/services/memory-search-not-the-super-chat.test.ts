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
 * Added after the Audit's gate of #190 (2026-09-28), written before the fix:
 * 5. A run of the super chat's cron job, once the job was replaced (deleted on
 *    the gateway and made again, a new id), is returned: the name no longer
 *    matches, and only the run recorded when it happened keeps it out. The
 *    gate removed that record and the four tests above stayed green.
 * 6. The super chat's hits eat an agent's limit: the gateway was asked for
 *    `limit` hits and the filter ran on those, so an agent asking 10 could get
 *    none while Noah's own sessions matched too.
 * 7. A session Hermes compressed is returned: its search hits carry the
 *    lineage's newest id (`session_id`, never recorded) with its root
 *    (`lineage_root`) and parent (`parent_session_id`), read in
 *    hermes_cli/web_routers/sessions.py of the gateway.
 * 8. (found writing 6) A search with no `limit`, which is how memory_search
 *    asks unless the agent names one, is cut to 1 hit: the route read the
 *    missing parameter as Number(null), 0, which is finite, and clamped it to
 *    1 instead of taking the default 10.
 *
 * The overseer and the memory route are the real ones; the live transport
 * and the gateway's search are fakes.
 */

vi.mock('electron', () => ({ ipcMain: { handle: () => undefined } }));
vi.mock('../../../electron/core/agent-manager', () => ({ agents: new Map() }));
vi.mock('../../../electron/services/git-review', () => ({ repoSummary: async () => ({ branch: 'main', status: [] }) }));
const live = vi.hoisted(() => ({ available: true }));
vi.mock('../../../electron/services/hermes-session', () => ({
  liveTransportAvailable: () => live.available,
  createLiveSession: async () => ({
    session: { sessionId: 'live-overseer-1', storedSessionId: 'stored-overseer-1' },
    control: { close: () => {} },
  }),
  askLiveSession: async () => ({ ok: true, envelope: '{"say":"Answered live.","action":null}' }),
}));
const gateway = vi.hoisted(() => ({ hits: [] as Array<Record<string, unknown>>, runId: '' }));
/** A run id as the gateway names them: `cron_<job>_<UTC date>_<UTC time>`. */
const runIdFor = (jobId: string, at = new Date()) => `cron_${jobId}_${at.toISOString().slice(0, 19).replace(/[-:]/g, '').replace('T', '_')}`;
vi.mock('../../../electron/services/hermes-client', async importOriginal => ({
  ...(await importOriginal<typeof import('../../../electron/services/hermes-client')>()),
  // As the gateway does: at most `limit` hits, in its own order.
  searchHermesSessions: async (_conn: unknown, _q: string, limit = 10) => ({ success: true, hits: gateway.hits.slice(0, limit) }),
  updateHermesCron: async () => ({ success: true }),
  hermesCronAction: async () => ({ success: true }),
  fetchHermesCronRuns: async () => ({ success: true, runs: gateway.runId ? [{ id: gateway.runId }] : [] }),
  fetchHermesSessionMessages: async () => ({ success: true, messages: [{ role: 'assistant', content: '{"say":"Answered by the cron.","action":null}' }] }),
  // A reachable gateway, so the super chat's turn opens its live session.
  probeHermes: async () => ({ baseUrl: 'http://127.0.0.1:1', reachable: true, authRequired: false, authFlows: [], authProviders: [], signedIn: true }),
  createHermesCron: async () => ({ success: false as const, error: 'no cron in this test', needsSignIn: false }),
}));

type Handler = (req: unknown, sendJson: (body: unknown, status?: number) => void) => Promise<void>;
let search: Handler;
let overseer: typeof import('../../../electron/services/overseer');
let store: typeof import('../../../electron/services/overseer-store');

async function agentSearches(q: string, limit?: number): Promise<Array<{ ref?: string; source: string }>> {
  let answer: { hits: Array<{ ref?: string; source: string }> } = { hits: [] };
  const url = new URL(`http://localhost/api/memory/search?q=${encodeURIComponent(q)}&sources=hermes${limit ? `&limit=${limit}` : ''}`);
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
  gateway.runId = '';
  live.available = true;
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
    // A file of its own in the private directory: a turn saves the state it
    // loaded when it began, which would drop an id recorded meanwhile.
    const saved = fs.readFileSync(path.join(os.homedir(), '.tars-private', 'overseer-hermes-sessions.json'), 'utf-8');
    expect(saved).toContain('live-overseer-1');
    expect(saved).toContain('stored-overseer-1');
  });

  it('5. leaves out a run of the super chat\'s cron job once the job was replaced', async () => {
    live.available = false;
    store.saveState({ ...store.loadState(), jobId: 'job-before' });
    gateway.runId = runIdFor('job-before');
    const turn = await overseer.askOverseer('Answer through the cron.');
    expect(turn, JSON.stringify(turn)).toMatchObject({ ok: true });

    // The job is made again on the gateway, under another id.
    store.saveState({ ...store.loadState(), jobId: 'job-after' });
    gateway.hits = [{ sessionId: gateway.runId, snippet: 'the fallback turn' }, { sessionId: 'noah-own-5', snippet: 'kept' }];

    expect((await agentSearches('turn')).map(h => h.ref)).toEqual(['noah-own-5']);
  }, 20_000);

  it('6. hands an agent its limit of Noah\'s own hits, however many of the super chat\'s come first', async () => {
    await overseer.askOverseer('Seed the live session.');
    gateway.hits = [
      ...Array.from({ length: 12 }, () => ({ sessionId: 'live-overseer-1', snippet: 'the super chat' })),
      ...Array.from({ length: 15 }, (_, i) => ({ sessionId: `noah-own-${i}`, snippet: 'Noah' })),
    ];

    const hits = await agentSearches('x', 10);

    expect(hits.map(h => h.ref)).toEqual(Array.from({ length: 10 }, (_, i) => `noah-own-${i}`));
  });

  it('7. leaves out a compressed session whose lineage root or parent is the super chat\'s', async () => {
    await overseer.askOverseer('Seed the live session.');
    gateway.hits = [
      { sessionId: 'tip-after-compression', lineageRoot: 'live-overseer-1', snippet: 'the super chat, compressed' },
      { sessionId: 'tip-2', parentSessionId: 'stored-overseer-1', snippet: 'its child' },
      { sessionId: 'noah-tip', lineageRoot: 'noah-root', parentSessionId: 'noah-root', snippet: 'Noah, compressed' },
    ];

    expect((await agentSearches('x')).map(h => h.ref)).toEqual(['noah-tip']);
  });

  it('8. takes 10 hits when the agent names no limit', async () => {
    gateway.hits = Array.from({ length: 15 }, (_, i) => ({ sessionId: `noah-own-${i}`, snippet: 'Noah' }));

    expect(await agentSearches('x')).toHaveLength(10);
  });
});
