import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import { priceFor } from './model-catalog';

/**
 * Token usage read from the Claude Code transcripts themselves.
 *
 * Claude Code only writes ~/.claude/stats-cache.json for some account types;
 * without it the Usage page had no tokens and therefore no cost at all. Every
 * assistant message in ~/.claude/projects/**\/*.jsonl carries its own usage
 * block, so the numbers are right there: that is what this reads.
 */

export interface ModelUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadInputTokens: number;
  cacheCreationInputTokens: number;
  /** 1h cache writes cost 2x base, 5m writes 1.25x, kept apart to price them */
  cacheCreation1hTokens: number;
  cacheCreation5mTokens: number;
  webSearchRequests: number;
  costUSD: number;
}

export interface TranscriptUsage {
  modelUsage: Record<string, ModelUsage>;
  /**
   * `costUSD` is the day priced from that day's own tokens, cache included.
   * `tokensByModel` stays input+output only, which is why the number has to
   * travel with it: the Usage page used to rebuild the day's cost by
   * multiplying those tokens by an all-time blended $/token rate, and a day
   * whose cache-read-to-output ratio differed from the all-time average came
   * out anywhere from 80% under to 157% over. Cache reads are the bill here -
   * 1.08bn read tokens against 1.5m output tokens on this author's history -
   * and they were not in the daily map at all.
   */
  dailyModelTokens: Array<{ date: string; tokensByModel: Record<string, number>; costUSD: number }>;
  /** Most recent day with real activity */
  lastComputedDate: string | null;
}

interface Pricing {
  input: number;
  output: number;
  cacheRead: number;
  cache5m: number;
  cache1h: number;
}

/** Used only when the live catalogue has never been reachable. */
const FALLBACK: Record<string, Pricing> = {
  fable: { input: 10, output: 50, cacheRead: 1, cache5m: 12.5, cache1h: 20 },
  mythos: { input: 10, output: 50, cacheRead: 1, cache5m: 12.5, cache1h: 20 },
  opus: { input: 5, output: 25, cacheRead: 0.5, cache5m: 6.25, cache1h: 10 },
  sonnet: { input: 3, output: 15, cacheRead: 0.3, cache5m: 3.75, cache1h: 6 },
  haiku: { input: 1, output: 5, cacheRead: 0.1, cache5m: 1.25, cache1h: 2 },
};

/**
 * Live price for a model. models.dev publishes input/output/cache_read and the
 * 5m cache_write; the 1h write is 2x base where the 5m one is 1.25x, which is
 * how Anthropic prices both, so it is derived rather than guessed.
 */
function pricingFor(modelId: string): Pricing {
  const live = priceFor(modelId, 'claude');
  if (live && typeof live.input === 'number' && typeof live.output === 'number') {
    const input = live.input;
    return {
      input,
      output: live.output,
      cacheRead: live.cache_read ?? input * 0.1,
      cache5m: live.cache_write ?? input * 1.25,
      cache1h: input * 2,
    };
  }
  const id = modelId.toLowerCase();
  for (const key of Object.keys(FALLBACK)) {
    if (id.includes(key)) return FALLBACK[key];
  }
  return FALLBACK.sonnet;
}

/** The raw counts on one usage block. */
interface Counts {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  write1h: number;
  write5m: number;
  searches: number;
}

const COUNT_KEYS: Array<keyof Counts> = [
  'input', 'output', 'cacheRead', 'cacheWrite', 'write1h', 'write5m', 'searches',
];

/** What `a` adds on top of `b`, never negative. */
function diff(a: Counts, b: Counts): Counts {
  const out = {} as Counts;
  for (const k of COUNT_KEYS) out[k] = Math.max(0, a[k] - b[k]);
  return out;
}

function add(a: Counts, b: Counts): Counts {
  const out = {} as Counts;
  for (const k of COUNT_KEYS) out[k] = a[k] + b[k];
  return out;
}

function isZero(c: Counts): boolean {
  return COUNT_KEYS.every(k => c[k] === 0);
}

function costOf(model: string, c: Counts): number {
  const price = pricingFor(model);
  return (
    (c.input / 1e6) * price.input +
    (c.output / 1e6) * price.output +
    (c.cacheRead / 1e6) * price.cacheRead +
    (c.write5m / 1e6) * price.cache5m +
    (c.write1h / 1e6) * price.cache1h
  );
}

function emptyUsage(): ModelUsage {
  return {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadInputTokens: 0,
    cacheCreationInputTokens: 0,
    cacheCreation1hTokens: 0,
    cacheCreation5mTokens: 0,
    webSearchRequests: 0,
    costUSD: 0,
  };
}

/** Every *.jsonl under ~/.claude/projects, at any depth. */
function listTranscripts(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string, depth: number) => {
    if (depth > 4) return;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full, depth + 1);
      else if (entry.name.endsWith('.jsonl')) out.push(full);
    }
  };
  walk(root, 0);
  return out;
}

let cache: { at: number; value: TranscriptUsage } | null = null;
const CACHE_TTL = 60_000;

/**
 * `YYYY-MM-DD` in the machine's own timezone.
 *
 * Costs are read by a person who means their own calendar day. A turn at 01:00
 * local in Tbilisi is 21:00 UTC the day before; counting it as yesterday makes
 * "what did I spend today" wrong for everyone east of Greenwich.
 */
function localDateKey(isoTimestamp: string): string | null {
  const d = new Date(isoTimestamp);
  if (Number.isNaN(d.getTime())) return null;
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

export function computeTranscriptUsage(homeDir = os.homedir()): TranscriptUsage {
  if (cache && Date.now() - cache.at < CACHE_TTL) return cache.value;

  const root = path.join(homeDir, '.claude', 'projects');
  // Null-prototype: a transcript's model id is attacker-influenceable, and
  // `modelUsage[model] ||= …` on a plain object would let "__proto__" write
  // onto Object.prototype inside the main process.
  const modelUsage: Record<string, ModelUsage> = Object.create(null);
  const dailyMap = new Map<string, Record<string, number>>();
  const dailyCost = new Map<string, number>();
  let lastComputedDate: string | null = null;

  // One API response is written as several lines - one per content block - all
  // carrying the same message id and requestId, and counting them all would
  // roughly double every cost on the page. But the earlier lines carry a
  // *partial* usage block: the final line is the one with the whole
  // output_tokens count. Keeping the first and skipping the rest, which is what
  // this did, threw away 279,904 output tokens ($7.00) of the author's history.
  // So: remember what each key has already contributed and top it up.
  const applied = new Map<string, Counts>();

  for (const file of listTranscripts(root)) {
    let content: string;
    try {
      content = fs.readFileSync(file, 'utf-8');
    } catch {
      continue;
    }

    for (const line of content.split('\n')) {
      if (!line.includes('"usage"')) continue;

      let entry: Record<string, unknown>;
      try {
        entry = JSON.parse(line);
      } catch {
        continue;
      }
      if (entry.type !== 'assistant') continue;

      const message = entry.message as Record<string, unknown> | undefined;
      const usage = message?.usage as Record<string, unknown> | undefined;
      if (!message || !usage) continue;

      const model = typeof message.model === 'string' ? message.model : null;
      if (!model || model === '<synthetic>') continue;
      if (model === '__proto__' || model === 'constructor' || model === 'prototype') continue;

      const split = usage.cache_creation as Record<string, unknown> | undefined;
      const cacheWrite = Number(usage.cache_creation_input_tokens) || 0;
      const raw: Counts = {
        input: Number(usage.input_tokens) || 0,
        output: Number(usage.output_tokens) || 0,
        cacheRead: Number(usage.cache_read_input_tokens) || 0,
        cacheWrite,
        write1h: Number(split?.ephemeral_1h_input_tokens) || 0,
        write5m: Number(split?.ephemeral_5m_input_tokens) || (split ? 0 : cacheWrite),
        searches: Number(
          (usage.server_tool_use as Record<string, unknown> | undefined)?.web_search_requests,
        ) || 0,
      };

      // Only what this line adds beyond the same message's earlier lines.
      let delta = raw;
      const key = `${message.id ?? ''}:${entry.requestId ?? ''}`;
      if (key !== ':') {
        const prev = applied.get(key);
        if (prev) {
          delta = diff(raw, prev);
          if (isZero(delta)) continue;
          applied.set(key, add(prev, delta));
        } else {
          applied.set(key, raw);
        }
      }

      const bucket = (modelUsage[model] ||= emptyUsage());
      bucket.inputTokens += delta.input;
      bucket.outputTokens += delta.output;
      bucket.cacheReadInputTokens += delta.cacheRead;
      bucket.cacheCreationInputTokens += delta.cacheWrite;
      bucket.cacheCreation1hTokens += delta.write1h;
      bucket.cacheCreation5mTokens += delta.write5m;
      bucket.webSearchRequests += delta.searches;

      const cost = costOf(model, delta);
      bucket.costUSD += cost;

      const timestamp = typeof entry.timestamp === 'string' ? entry.timestamp : null;
      // The user's day, not UTC's. Transcript timestamps are ISO/Z, so slicing
      // the first ten characters gave the UTC date, while the chart labelled
      // its bars with the LOCAL date. At UTC+4 that put every bar one day out:
      // the bar marked 23 carried the 22nd's spend, which is why the chart and
      // the "latest day" card disagreed by a whole day while each was
      // internally consistent.
      const date = timestamp ? localDateKey(timestamp) : null;
      if (date) {
        const day = dailyMap.get(date) ?? {};
        day[model] = (day[model] || 0) + delta.input + delta.output;
        dailyMap.set(date, day);
        // The day priced from its own tokens - cache reads and cache writes
        // included - rather than left to be reconstructed downstream from
        // input+output alone.
        dailyCost.set(date, (dailyCost.get(date) ?? 0) + cost);
        if (!lastComputedDate || date > lastComputedDate) lastComputedDate = date;
      }
    }
  }

  const value: TranscriptUsage = {
    modelUsage: { ...modelUsage },
    dailyModelTokens: Array.from(dailyMap.entries())
      .map(([date, tokensByModel]) => ({ date, tokensByModel, costUSD: dailyCost.get(date) ?? 0 }))
      .sort((a, b) => a.date.localeCompare(b.date)),
    lastComputedDate,
  };

  cache = { at: Date.now(), value };
  return value;
}

/** Drops the memo so a test or a refresh sees fresh numbers. */
export function clearTranscriptUsageCache(): void {
  cache = null;
}
