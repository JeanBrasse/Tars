// Plugin database for Claude Code plugins marketplace
// Supports multiple data sources with per-source localStorage caching

import { useState, useEffect, useRef } from 'react';

// ── Public types ──

export interface Plugin {
  name: string;
  description: string;
  category: string;
  marketplace: string;
  version?: string;
  author?: string;
  tags?: string[];
  homepage?: string;
  binaryRequired?: string;
  installCommand?: string;
}

export interface Marketplace {
  id: string;
  name: string;
  description: string;
  source: string;
}

export type PluginCategory = string;

// ── Remote schema ──

interface RemotePlugin {
  id: string;
  name: string;
  description: string;
  source: string;
  marketplace: string;
  marketplaceUrl: string;
  category: string;
  installCommand?: string;
  version?: string;
  author?: { name: string; email?: string };
  tags?: string[];
}

// ── Data source abstraction ──

interface PluginSource {
  /** Unique key: used as localStorage cache key suffix */
  id: string;
  /** Human-readable label */
  name: string;
  /** Fetches raw plugin data from the source */
  fetch: () => Promise<RemotePlugin[]>;
  /** Cache TTL in ms (default: DEFAULT_TTL) */
  ttl?: number;
}

const DEFAULT_TTL = 86_400_000; // 24 hours
const CACHE_PREFIX = 'dorothy-plugins-src-';

// ── Source registry ──
// Each entry is a real Claude Code marketplace: its repo publishes a
// .claude-plugin/marketplace.json, which is what `claude plugin marketplace
// add` reads. Fetched, cached and merged independently, so one dead repo
// costs its own plugins and nothing else.

interface MarketplaceRepo {
  /** owner/repo on GitHub, also the argument to `plugin marketplace add` */
  repo: string;
  /** Branch holding the manifest */
  branch?: string;
}

const MARKETPLACE_REPOS: MarketplaceRepo[] = [
  { repo: 'anthropics/claude-code' },
  { repo: 'wshobson/agents' },
  { repo: 'jeremylongshore/claude-code-plugins-plus-skills' },
  { repo: 'davepoon/buildwithclaude' },
  { repo: 'obra/superpowers-marketplace' },
  { repo: 'fivetaku/gptaku_plugins' },
  { repo: 'numman-ali/n-skills' },
];

/** Shape of a .claude-plugin/marketplace.json entry. */
interface ManifestPlugin {
  name: string;
  description?: string;
  source?: string;
  category?: string;
  version?: string;
  author?: { name?: string; email?: string; url?: string } | string;
  homepage?: string;
  keywords?: string[];
  tags?: string[];
}

interface Manifest {
  name: string;
  description?: string;
  owner?: { name?: string; email?: string };
  plugins?: ManifestPlugin[];
}

/** owner/repo, plugin and marketplace names, as the CLI accepts them. */
const SAFE_TOKEN = /^[A-Za-z0-9._-]+$/;

/**
 * The marketplace manifest is fetched from a repository we do not control and
 * its strings end up in a command. Anything that is not a plain name is
 * refused rather than escaped, so there is no quoting to get wrong.
 */
function safeInstallCommand(repo: string, plugin: string, marketplace: string): string | undefined {
  const [owner, name, ...rest] = repo.split('/');
  if (rest.length > 0 || !SAFE_TOKEN.test(owner ?? '') || !SAFE_TOKEN.test(name ?? '')) return undefined;
  if (!SAFE_TOKEN.test(plugin) || !SAFE_TOKEN.test(marketplace)) return undefined;
  return `claude plugin marketplace add ${owner}/${name} && claude plugin install ${plugin}@${marketplace} -y`;
}

function manifestToRemote(manifest: Manifest, repo: string): RemotePlugin[] {
  const marketplace = manifest.name || repo;
  return (manifest.plugins || []).map((p) => ({
    id: `${p.name}@${marketplace}`,
    name: p.name,
    description: p.description || '',
    source: repo,
    marketplace,
    marketplaceUrl: `https://github.com/${repo}`,
    category: p.category || 'community',
    // Built here from validated parts, never taken from the manifest: this
    // string is executed, and the manifest is remote data.
    installCommand: safeInstallCommand(repo, p.name, marketplace),
    version: p.version,
    author:
      typeof p.author === 'string'
        ? { name: p.author }
        : p.author?.name
          ? { name: p.author.name, email: p.author.email }
          : manifest.owner?.name
            ? { name: manifest.owner.name }
            : undefined,
    tags: p.tags || p.keywords,
  }));
}

const SOURCES: PluginSource[] = MARKETPLACE_REPOS.map(({ repo, branch = 'main' }) => ({
  id: repo.replace('/', '-'),
  name: repo,
  fetch: async () => {
    const res = await fetch(
      `https://raw.githubusercontent.com/${repo}/${branch}/.claude-plugin/marketplace.json`,
    );
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return manifestToRemote(await res.json(), repo);
  },
}));

// ── Plugin filters ──
// Add predicates here to exclude plugins from the final list.
// A plugin is kept only if ALL filters return true.

type PluginFilter = (plugin: Plugin) => boolean;

const FILTERS: PluginFilter[] = [];

// ── Per-source localStorage cache ──

interface CacheEntry {
  timestamp: number;
  data: RemotePlugin[];
}

function readCache(sourceId: string): CacheEntry | null {
  try {
    const raw = localStorage.getItem(CACHE_PREFIX + sourceId);
    if (!raw) return null;
    return JSON.parse(raw) as CacheEntry;
  } catch {
    return null;
  }
}

function writeCache(sourceId: string, data: RemotePlugin[]): void {
  try {
    const entry: CacheEntry = { timestamp: Date.now(), data };
    localStorage.setItem(CACHE_PREFIX + sourceId, JSON.stringify(entry));
  } catch {
    // Quota exceeded or other storage error: ignore
  }
}

function isFresh(entry: CacheEntry, ttl: number): boolean {
  return Date.now() - entry.timestamp < ttl;
}

// ── Mapping & derivation ──

function mapRemotePlugin(remote: RemotePlugin): Plugin {
  return {
    name: remote.name,
    description: remote.description || '',
    category: remote.category || 'community',
    marketplace: remote.marketplace,
    author: remote.author?.name,
    tags: remote.tags,
    homepage: remote.marketplaceUrl,
    installCommand: remote.installCommand,
    version: remote.version,
  };
}

function deriveCategories(plugins: Plugin[]): string[] {
  const categories = new Set<string>();
  for (const p of plugins) {
    // Only expose categories that start with a capital letter
    if (p.category && /^[A-Z]/.test(p.category)) categories.add(p.category);
  }
  return Array.from(categories).sort();
}

function deriveAuthors(plugins: Plugin[]): string[] {
  const authors = new Set<string>();
  for (const p of plugins) {
    if (p.author) authors.add(p.author);
  }
  return Array.from(authors).sort();
}

/** Every marketplace that returned plugins shows up in the source dropdown. */
function deriveMarketplaces(plugins: Plugin[]): Marketplace[] {
  const seen = new Map<string, { mp: Marketplace; count: number }>();
  for (const p of plugins) {
    const entry = seen.get(p.marketplace);
    if (entry) { entry.count++; continue; }
    seen.set(p.marketplace, {
      count: 1,
      mp: {
        id: p.marketplace,
        name: p.marketplace,
        description: '',
        source: p.homepage || p.marketplace,
      },
    });
  }
  return Array.from(seen.values())
    .map(({ mp, count }) => ({ ...mp, description: `${count} plugin${count > 1 ? 's' : ''}` }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

// ── Fetch a single source (cache-first) ──

async function fetchSource(source: PluginSource): Promise<RemotePlugin[]> {
  const ttl = source.ttl ?? DEFAULT_TTL;
  const cached = readCache(source.id);

  // Fresh cache → return immediately
  if (cached && isFresh(cached, ttl)) {
    return cached.data;
  }

  // Fetch from remote
  try {
    const data = await source.fetch();
    writeCache(source.id, data);
    return data;
  } catch {
    // Fetch failed: fall back to stale cache if available
    if (cached) return cached.data;
    return [];
  }
}

// ── Aggregate all sources ──

let cachedPlugins: Plugin[] | null = null;
let cachedCategories: string[] | null = null;
let cachedMarketplaces: Marketplace[] | null = null;
let cachedAuthors: string[] | null = null;
let fetchPromise: Promise<Plugin[]> | null = null;

async function fetchPlugins(): Promise<Plugin[]> {
  if (cachedPlugins) return cachedPlugins;
  if (fetchPromise) return fetchPromise;

  fetchPromise = Promise.allSettled(SOURCES.map(fetchSource))
    .then((results) => {
      const allRemote: RemotePlugin[] = [];
      for (const result of results) {
        if (result.status === 'fulfilled') {
          allRemote.push(...result.value);
        }
      }

      // Deduplicate by name@marketplace
      const seen = new Set<string>();
      const unique: RemotePlugin[] = [];
      for (const p of allRemote) {
        const key = `${p.name}@${p.marketplace}`;
        if (!seen.has(key)) {
          seen.add(key);
          unique.push(p);
        }
      }

      cachedPlugins = unique.map(mapRemotePlugin).filter(
        (p) => FILTERS.every((fn) => fn(p)),
      );
      cachedCategories = deriveCategories(cachedPlugins);
      cachedMarketplaces = deriveMarketplaces(cachedPlugins);
      cachedAuthors = deriveAuthors(cachedPlugins);
      fetchPromise = null;
      return cachedPlugins;
    })
    .catch((err) => {
      fetchPromise = null;
      throw err;
    });

  return fetchPromise;
}

// ── React hook ──

export function usePluginsDatabase() {
  const [plugins, setPlugins] = useState<Plugin[]>(cachedPlugins || []);
  const [categories, setCategories] = useState<string[]>(cachedCategories || []);
  const [marketplaces, setMarketplaces] = useState<Marketplace[]>(cachedMarketplaces || []);
  const [authors, setAuthors] = useState<string[]>(cachedAuthors || []);
  const [loading, setLoading] = useState(!cachedPlugins);
  const [error, setError] = useState<string | null>(null);
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    if (cachedPlugins) return;

    fetchPlugins()
      .then((data) => {
        if (!mounted.current) return;
        setPlugins(data);
        setCategories(cachedCategories!);
        setMarketplaces(cachedMarketplaces!);
        setAuthors(cachedAuthors!);
        setLoading(false);
      })
      .catch((err) => {
        if (!mounted.current) return;
        setError(err instanceof Error ? err.message : 'Failed to fetch plugins');
        setLoading(false);
      });

    return () => {
      mounted.current = false;
    };
  }, []);

  return { plugins, categories, marketplaces, authors, loading, error };
}
