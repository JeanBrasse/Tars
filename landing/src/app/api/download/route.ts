import { NextResponse } from 'next/server';
import { REPO } from '@/lib/downloads';

/**
 * Where the download comes from.
 *
 * This used to be a hardcoded URL, and it pointed at
 * `Charlie85270/dorothy/releases/download/1.2.9/dorothy-1.2.9-arm64.dmg`: the
 * upstream project's build, three minor versions behind, from a repository this
 * fork deliberately never touches. Every visitor who clicked "Download for Mac"
 * got someone else's app.
 *
 * Resolving the latest release at request time means the button cannot go stale
 * again, and it can only ever serve a build from this repository.
 *
 * Nothing about the download is kept. The route used to keep the time, the
 * platform and the browser of each one in a database; the counter now reads
 * GitHub's own count (src/lib/downloads.ts), as the privacy policy says.
 */
const RELEASES_PAGE = `https://github.com/${REPO}/releases/latest`;

interface ReleaseAsset {
  name: string;
  browser_download_url: string;
}

/** Prefer an Apple-silicon dmg, then any dmg, then any asset at all. */
function pickMacAsset(assets: ReleaseAsset[]): string | undefined {
  const dmgs = assets.filter(a => a.name.toLowerCase().endsWith('.dmg'));
  const arm = dmgs.find(a => /arm64|aarch64|apple.?silicon/i.test(a.name));
  return (arm ?? dmgs[0])?.browser_download_url;
}

async function latestDownloadUrl(): Promise<string> {
  try {
    const res = await fetch(`https://api.github.com/repos/${REPO}/releases/latest`, {
      headers: { Accept: 'application/vnd.github+json' },
      // A release lands rarely; an hour of cache keeps us well inside the
      // unauthenticated rate limit.
      next: { revalidate: 3600 },
    });
    if (!res.ok) return RELEASES_PAGE;

    const release = (await res.json()) as { assets?: ReleaseAsset[] };
    return pickMacAsset(release.assets ?? []) ?? RELEASES_PAGE;
  } catch {
    // Send people to the releases page rather than to a wrong binary.
    return RELEASES_PAGE;
  }
}

export async function GET() {
  return NextResponse.redirect(await latestDownloadUrl());
}
