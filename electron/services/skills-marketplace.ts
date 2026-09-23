import * as fs from 'fs';
import { dataPath } from '../constants';
import { writeAtomicSync } from '../utils/secret-file';

/**
 * The skills.sh directory, for the Extensions page.
 *
 * It was fetched live on every visit: about a second of someone else's server
 * before the page could show its list (the Audit, 2026-09-23), and nothing at
 * all when skills.sh was slow or down. The listing changes by the day, not by
 * the visit, so the last one is served at once, from memory or from
 * ~/.dorothy/skills-marketplace.json after a restart, and fetched again behind
 * it once it is older than an hour. Only the very first visit, with nothing
 * kept yet, waits on the network. A failed fetch keeps what was there.
 */

export interface MarketplaceSkill {
  rank: number;
  name: string;
  repo: string;
  installs: string;
  installsNum: number;
}

export interface MarketplaceListing {
  skills: MarketplaceSkill[] | null;
  /** When the listing served was fetched, in ms since the epoch; absent when there is none. */
  fetchedAt?: number;
}

export const MARKETPLACE_CACHE_FILE = dataPath('skills-marketplace.json');
export const MARKETPLACE_TTL_MS = 60 * 60 * 1000;
const FETCH_TIMEOUT_MS = 15_000;

let kept: { skills: MarketplaceSkill[]; fetchedAt: number } | null = null;
let inFlight: Promise<MarketplaceListing> | null = null;

/** The listing as skills.sh publishes it in its page, or null when it cannot be read. */
export function parseMarketplace(html: string): MarketplaceSkill[] | null {
  const match = html.match(/initialSkills.*?(\[\{.*?\}\])/);
  if (!match) return null;
  const raw = match[1].replace(/\\"/g, '"');
  const allSkills: { source: string; name: string; installs: number }[] = JSON.parse(raw);
  // The directory publishes ~600 skills; the old 300 cap hid half of them
  // behind a search box that only filters what was already downloaded.
  return allSkills.map((s, i) => ({
    rank: i + 1,
    name: s.name,
    repo: s.source,
    installs: s.installs >= 1000
      ? `${(s.installs / 1000).toFixed(1).replace(/\.0$/, '')}K`
      : String(s.installs),
    installsNum: s.installs,
  }));
}

function readKept(): typeof kept {
  if (kept) return kept;
  try {
    const parsed = JSON.parse(fs.readFileSync(MARKETPLACE_CACHE_FILE, 'utf-8'));
    if (Array.isArray(parsed?.skills) && typeof parsed.fetchedAt === 'number') kept = parsed;
  } catch {
    // Nothing kept yet, or unreadable: the next fetch writes it.
  }
  return kept;
}

function refresh(): Promise<MarketplaceListing> {
  if (inFlight) return inFlight;
  inFlight = (async (): Promise<MarketplaceListing> => {
    try {
      const res = await fetch('https://skills.sh/', {
        headers: { 'User-Agent': 'Tars/1.0' },
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });
      const skills = res.ok ? parseMarketplace(await res.text()) : null;
      if (!skills) return readKept() ?? { skills: null };
      kept = { skills, fetchedAt: Date.now() };
      try {
        writeAtomicSync(MARKETPLACE_CACHE_FILE, JSON.stringify(kept));
      } catch (err) {
        console.warn('[marketplace] could not keep the listing:', err);
      }
      return kept;
    } catch {
      return readKept() ?? { skills: null };
    } finally {
      inFlight = null;
    }
  })();
  return inFlight;
}

/** The listing to show now: the kept one at once, refreshed behind it when stale. */
export async function marketplaceListing(now = Date.now()): Promise<MarketplaceListing> {
  const current = readKept();
  if (!current) return refresh();
  if (now - current.fetchedAt > MARKETPLACE_TTL_MS) void refresh();
  return current;
}

/** Test seam. */
export function resetMarketplaceCache(): void {
  kept = null;
  inFlight = null;
}
