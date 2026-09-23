import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import {
  marketplaceListing, resetMarketplaceCache, MARKETPLACE_CACHE_FILE, MARKETPLACE_TTL_MS,
} from '../../../electron/services/skills-marketplace';

/**
 * Extensions fetched skills.sh on every visit, about a second before the page
 * could show anything (the Audit, 2026-09-23). The listing is now served from
 * the last one at once and fetched again behind it once it is an hour old.
 */

const page = (skills: Array<{ source: string; name: string; installs: number }>) =>
  `<script>self.__next_f.push([1,"initialSkills\\":${JSON.stringify(skills).replace(/"/g, '\\"')}"])</script>`;

let fetches: number;
let serve: () => Promise<Response>;

beforeEach(() => {
  resetMarketplaceCache();
  fs.rmSync(MARKETPLACE_CACHE_FILE, { force: true });
  fetches = 0;
  serve = async () => new Response(page([{ source: 'a/b', name: 'first', installs: 1500 }]));
  vi.stubGlobal('fetch', vi.fn(async () => { fetches++; return serve(); }));
});

afterEach(() => {
  vi.unstubAllGlobals();
});

const names = (listing: { skills: Array<{ name: string }> | null }) => listing.skills?.map(s => s.name);

describe('the skills.sh listing', () => {
  it('waits on the network only the first time, and keeps what it fetched on disk', async () => {
    const first = await marketplaceListing();
    const second = await marketplaceListing();

    expect(names(first)).toEqual(['first']);
    expect(first.skills![0]).toMatchObject({ rank: 1, repo: 'a/b', installs: '1.5K', installsNum: 1500 });
    expect(second).toBe(first);
    expect(fetches).toBe(1);
    expect(JSON.parse(fs.readFileSync(MARKETPLACE_CACHE_FILE, 'utf-8')).skills[0].name).toBe('first');
  });

  it('serves the kept listing after a restart without fetching', async () => {
    await marketplaceListing();
    resetMarketplaceCache();

    const afterRestart = await marketplaceListing();

    expect(names(afterRestart)).toEqual(['first']);
    expect(fetches).toBe(1);
  });

  it('once an hour old, answers the old listing at once and the new one next time', async () => {
    const first = await marketplaceListing();
    serve = async () => new Response(page([{ source: 'c/d', name: 'second', installs: 7 }]));

    const stale = await marketplaceListing(first.fetchedAt! + MARKETPLACE_TTL_MS + 1);
    expect(names(stale)).toEqual(['first']);
    await vi.waitFor(() => expect(fetches).toBe(2));
    await vi.waitFor(async () => expect(names(await marketplaceListing())).toEqual(['second']));
  });

  it('keeps the old listing when skills.sh fails or changes its page', async () => {
    const first = await marketplaceListing();
    serve = async () => { throw new Error('offline'); };
    await marketplaceListing(first.fetchedAt! + MARKETPLACE_TTL_MS + 1);
    await vi.waitFor(() => expect(fetches).toBe(2));
    // Let that refresh finish: one in flight is shared, not started again.
    await new Promise(resolve => setTimeout(resolve, 20));
    serve = async () => new Response('<html>redesigned</html>');
    await marketplaceListing(first.fetchedAt! + MARKETPLACE_TTL_MS + 1);
    await vi.waitFor(() => expect(fetches).toBe(3));

    expect(names(await marketplaceListing())).toEqual(['first']);
  });

  it('says there is nothing when the very first fetch fails, and fetches once for callers arriving together', async () => {
    serve = async () => new Response('down', { status: 503 });
    const [a, b] = await Promise.all([marketplaceListing(), marketplaceListing()]);

    expect(a).toEqual({ skills: null });
    expect(b).toEqual({ skills: null });
    expect(fetches).toBe(1);
  });
});
