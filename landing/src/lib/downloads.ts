/**
 * The download counter: GitHub's own count, which the site reads and keeps
 * nothing of. The privacy policy says so ("The download counter shows GitHub's
 * own count of release downloads. The site keeps no download log.").
 *
 * Only the .dmg of each release is counted. latest-mac.yml is fetched by every
 * installed Tars at each update check and the zip is what an update downloads,
 * so counting them counts update checks and updates, not people downloading
 * Tars: on 2026-09-24 they were 1,434 of 1,439.
 */

export const REPO = 'JeanBrasse/Tars';

interface Asset {
  name: string;
  download_count?: number;
}

interface Release {
  assets?: Asset[];
}

export function countDmgDownloads(releases: Release[]): number {
  return releases.reduce(
    (total, release) => total + (release.assets ?? [])
      .filter(asset => asset.name.toLowerCase().endsWith('.dmg'))
      .reduce((sum, asset) => sum + (asset.download_count ?? 0), 0),
    0,
  );
}

const PER_PAGE = 100;
/** Two thousand releases: past that, the answer is not a list that ends. */
const MAX_PAGES = 20;

/**
 * Every release's .dmg downloads, from every page GitHub has. Null when any
 * page does not come back whole, or the pages never end: no count is better
 * than a false one.
 */
export async function downloadCount(fetchImpl: typeof fetch = fetch): Promise<number | null> {
  const releases: Release[] = [];
  try {
    for (let page = 1; ; page += 1) {
      if (page > MAX_PAGES) return null;
      const res = await fetchImpl(`https://api.github.com/repos/${REPO}/releases?per_page=${PER_PAGE}&page=${page}`, {
        headers: { Accept: 'application/vnd.github+json' },
        // An hour of cache keeps the site well inside the unauthenticated rate limit.
        next: { revalidate: 3600 },
      } as RequestInit);
      if (!res.ok) return null;
      const batch: unknown = await res.json();
      if (!Array.isArray(batch)) return null;
      releases.push(...(batch as Release[]));
      if (batch.length < PER_PAGE) break;
    }
  } catch {
    return null;
  }
  return countDmgDownloads(releases);
}
