import { NextRequest, NextResponse } from 'next/server';
import { Redis } from '@upstash/redis';

// Initialize Redis client (only if env vars are set)
const redis = process.env.UPSTASH_REDIS_REST_URL && process.env.UPSTASH_REDIS_REST_TOKEN
  ? new Redis({
      url: process.env.UPSTASH_REDIS_REST_URL,
      token: process.env.UPSTASH_REDIS_REST_TOKEN,
    })
  : null;

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
 */
const REPO = 'JeanBrasse/Tars';
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

export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const platform = searchParams.get('platform') || 'mac';

  try {
    // Track download in Redis if available
    if (redis) {
      const today = new Date().toISOString().split('T')[0]; // YYYY-MM-DD

      // Increment total downloads
      await redis.incr('downloads:total');

      // Increment daily downloads
      await redis.incr(`downloads:daily:${today}`);

      // Increment platform-specific downloads
      await redis.incr(`downloads:platform:${platform}`);

      // Add to download log (keep last 1000)
      await redis.lpush('downloads:log', JSON.stringify({
        timestamp: new Date().toISOString(),
        platform,
        userAgent: request.headers.get('user-agent') || 'unknown',
      }));
      await redis.ltrim('downloads:log', 0, 999);
    }
  } catch (error) {
    // Don't fail the download if tracking fails
    console.error('Failed to track download:', error);
  }

  return NextResponse.redirect(await latestDownloadUrl());
}
