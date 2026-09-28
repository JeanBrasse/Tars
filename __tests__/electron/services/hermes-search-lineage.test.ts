import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import * as http from 'node:http';

/**
 * What searchHermesSessions reads from the gateway's /api/sessions/search.
 *
 * A session Hermes compressed is split: a child session carries on, with
 * `parent_session_id` naming the one before. The gateway's search answers per
 * lineage: `session_id` is the lineage's newest session and `lineage_root` its
 * first (hermes_cli/web_routers/sessions.py), so the super chat's session,
 * once compressed, is found under an id Tars never recorded.
 *
 * How it fails, written before the code (2026-09-28):
 * 1. `lineage_root` and `parent_session_id` are dropped, so nothing can tell
 *    the child from anybody's session.
 * 2. A caller that asks for more than 50, to filter before it cuts, is
 *    capped at 50 where the gateway gives 100.
 */

const { TMP } = vi.hoisted(() => ({ TMP: `${(process.env.TMPDIR || '/tmp').replace(/\/$/, '')}/tars-hermes-lineage-${process.pid}` }));
vi.mock('../../../electron/constants', async importOriginal => ({
  ...(await importOriginal<typeof import('../../../electron/constants')>()),
  DATA_DIR: TMP,
}));

let server: http.Server;
let port: number;
let asked = '';

beforeAll(async () => {
  server = http.createServer((req, res) => {
    asked = req.url ?? '';
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ results: [
      { session_id: 'tip', lineage_root: 'root', parent_session_id: 'mid', id: 'tip', snippet: 'compressed' },
      { session_id: 'plain', lineage_root: 'plain', parent_session_id: null, snippet: 'never compressed' },
    ] }));
  });
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
  port = (server.address() as { port: number }).port;
});
afterAll(() => new Promise<void>(r => server.close(() => r())));

describe('searchHermesSessions', () => {
  it('1. keeps each hit\'s lineage root and parent', async () => {
    const { searchHermesSessions } = await import('../../../electron/services/hermes-client');
    const res = await searchHermesSessions({ mode: 'local', localPort: port, authMode: 'token', token: 't' } as never, 'x', 10);

    expect(res.success && res.hits.map(h => [h.sessionId, h.lineageRoot, h.parentSessionId])).toEqual([
      ['tip', 'root', 'mid'],
      ['plain', 'plain', undefined],
    ]);
  });

  it('2. asks the gateway for up to 100', async () => {
    const { searchHermesSessions } = await import('../../../electron/services/hermes-client');
    await searchHermesSessions({ mode: 'local', localPort: port, authMode: 'token', token: 't' } as never, 'x', 100);
    expect(new URL(asked, 'http://x').searchParams.get('limit')).toBe('100');
  });
});
