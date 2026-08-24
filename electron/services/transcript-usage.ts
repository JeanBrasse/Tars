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
  dailyModelTokens: Array<{
    date: string;
    tokensByModel: Record<string, number>;
    /** Per model, split the way the bill is: what went in, what came out, and
     *  what was read from or written to cache. `tokensByModel` above stays
     *  input+output so nothing that already read it changes meaning. */
    breakdownByModel: Record<string, { input: number; output: number; cacheRead: number; cacheWrite: number }>;
    costUSD: number;
  }>;
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
 * What one transcript file contributes, remembered so it is parsed once.
 *
 * The whole walk used to re-read and re-parse every .jsonl under
 * ~/.claude/projects on each cache miss: measured at 450 to 700ms against 451MB
 * across 1698 files on the author's machine, synchronously on the main process,
 * once a minute for as long as a Usage, Agents or Projects tab is open. Every
 * PTY's output handler, every other IPC call and the local HTTP server stall
 * for that whole time, and the cost only grows because Tars never prunes old
 * transcripts.
 *
 * Almost all of that work is re-reading files that cannot have changed: a
 * closed session's transcript is finished forever. Keyed on (mtimeMs, size), a
 * file is parsed once and its contribution reused, so the recurring cost falls
 * to a stat per file plus a real parse of only the session still being written.
 *
 * The first run after a launch still pays full price on the main thread. Moving
 * the walk to a worker is the remaining half of this and is not done here.
 */
interface TurnEntry {
  /** `${message.id}:${requestId}`, the identity of one API response. */
  key: string;
  model: string;
  /** Local calendar day, or null when the line carried no usable timestamp. */
  date: string | null;
  counts: Counts;
}

/**
 * The turns one file holds, not their totals.
 *
 * Totals cannot be cached per file: resuming a session replays earlier messages
 * into a NEW transcript, so the same message id appears in two files and
 * counting both would double it. Deduplication has to stay global, which means
 * what a file contributes is its list of turns, and the merge decides what is
 * new. Measured on the author's machine: 66 files, 116MB, 9359 usage lines,
 * 4895 distinct messages, about 0.8MB held here against a 467ms parse.
 */
type FileContribution = TurnEntry[];

const fileCache = new Map<string, { mtimeMs: number; size: number; value: FileContribution }>();

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

/**
 * The turns one transcript file holds.
 *
 * No aggregation here: the caller deduplicates across files, because a resumed
 * session replays its earlier messages into a new transcript and both copies
 * carry the same message id.
 */
function readTranscript(file: string): FileContribution {
  const turns: FileContribution = [];

  let content: string;
  try {
    content = fs.readFileSync(file, 'utf-8');
  } catch {
    return turns;
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
    // A transcript's model id is attacker-influenceable and is used as an object
    // key downstream, so the three that would reach Object.prototype are dropped.
    if (model === '__proto__' || model === 'constructor' || model === 'prototype') continue;

    const split = usage.cache_creation as Record<string, unknown> | undefined;
    const cacheWrite = Number(usage.cache_creation_input_tokens) || 0;
    const counts: Counts = {
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

    const timestamp = typeof entry.timestamp === 'string' ? entry.timestamp : null;
    turns.push({
      key: `${message.id ?? ''}:${entry.requestId ?? ''}`,
      model,
      // The user's day, not UTC's. Transcript timestamps are ISO/Z, so slicing
      // the first ten characters gave the UTC date while the chart labelled its
      // bars with the local one, putting every bar a day out east of Greenwich.
      date: timestamp ? localDateKey(timestamp) : null,
      counts,
    });
  }

  return turns;
}

/** The file's contribution, parsed only if it has changed since last time. */
function contributionFor(file: string): FileContribution | null {
  let stat: fs.Stats;
  try {
    stat = fs.statSync(file);
  } catch {
    return null;
  }
  const hit = fileCache.get(file);
  if (hit && hit.mtimeMs === stat.mtimeMs && hit.size === stat.size) return hit.value;

  const value = readTranscript(file);
  fileCache.set(file, { mtimeMs: stat.mtimeMs, size: stat.size, value });
  return value;
}

export function computeTranscriptUsage(homeDir = os.homedir()): TranscriptUsage {
  if (cache && Date.now() - cache.at < CACHE_TTL) return cache.value;

  const root = path.join(homeDir, '.claude', 'projects');
  // Null-prototype: a transcript's model id is attacker-influenceable, and
  // `modelUsage[model] ||= …` on a plain object would let "__proto__" write
  // onto Object.prototype inside the main process.
  const modelUsage: Record<string, ModelUsage> = Object.create(null);
  const dailyMap = new Map<string, Record<string, number>>();
  type Split = { input: number; output: number; cacheRead: number; cacheWrite: number };
  const dailyBreakdown = new Map<string, Record<string, Split>>();
  const dailyCost = new Map<string, number>();
  let lastComputedDate: string | null = null;

  // One API response is written as several lines, one per content block, all
  // carrying the same message id and requestId, and counting them all would
  // roughly double every cost on the page. But the earlier lines carry a
  // *partial* usage block: the final line is the one with the whole
  // output_tokens count. Keeping the first and skipping the rest threw away
  // 279,904 output tokens ($7.00) of the author's history. So: remember what
  // each key has already contributed and top it up.
  //
  // This stays global rather than per file, because a resumed session replays
  // its earlier messages into a new transcript under the same ids.
  const applied = new Map<string, Counts>();

  const files = listTranscripts(root);
  for (const file of files) {
    const turns = contributionFor(file);
    if (!turns) continue;

    for (const turn of turns) {
      let delta = turn.counts;
      if (turn.key !== ':') {
        const prev = applied.get(turn.key);
        if (prev) {
          delta = diff(turn.counts, prev);
          if (isZero(delta)) continue;
          applied.set(turn.key, add(prev, delta));
        } else {
          applied.set(turn.key, turn.counts);
        }
      }

      const bucket = (modelUsage[turn.model] ||= emptyUsage());
      bucket.inputTokens += delta.input;
      bucket.outputTokens += delta.output;
      bucket.cacheReadInputTokens += delta.cacheRead;
      bucket.cacheCreationInputTokens += delta.cacheWrite;
      bucket.cacheCreation1hTokens += delta.write1h;
      bucket.cacheCreation5mTokens += delta.write5m;
      bucket.webSearchRequests += delta.searches;

      const cost = costOf(turn.model, delta);
      bucket.costUSD += cost;

      if (turn.date) {
        const day = dailyMap.get(turn.date) ?? Object.create(null);
        day[turn.model] = (day[turn.model] || 0) + delta.input + delta.output;
        dailyMap.set(turn.date, day);

        const split = dailyBreakdown.get(turn.date) ?? Object.create(null);
        const cell = split[turn.model] ?? (split[turn.model] = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
        cell.input += delta.input;
        cell.output += delta.output;
        cell.cacheRead += delta.cacheRead;
        cell.cacheWrite += delta.cacheWrite;
        dailyBreakdown.set(turn.date, split);
        // The day priced from its own tokens, cache reads and cache writes
        // included, rather than left to be reconstructed downstream from
        // input+output alone.
        dailyCost.set(turn.date, (dailyCost.get(turn.date) ?? 0) + cost);
        if (!lastComputedDate || turn.date > lastComputedDate) lastComputedDate = turn.date;
      }
    }
  }

  // A transcript that has been deleted must stop contributing, and must not sit
  // in the map forever.
  if (fileCache.size > files.length) {
    const live = new Set(files);
    for (const key of fileCache.keys()) if (!live.has(key)) fileCache.delete(key);
  }

  const value: TranscriptUsage = {
    modelUsage: { ...modelUsage },
    dailyModelTokens: Array.from(dailyMap.entries())
      .map(([date, tokensByModel]) => ({
        date,
        tokensByModel: { ...tokensByModel },
        breakdownByModel: { ...(dailyBreakdown.get(date) ?? {}) },
        costUSD: dailyCost.get(date) ?? 0,
      }))
      .sort((a, b) => a.date.localeCompare(b.date)),
    lastComputedDate,
  };

  cache = { at: Date.now(), value };
  return value;
}

/**
 * Drops both memos so a test or a refresh sees fresh numbers.
 *
 * The per-file map has to go too: a test that rewrites a fixture within the
 * same millisecond and to the same length would otherwise be handed the old
 * parse, since (mtimeMs, size) is all that identifies it.
 */
export function clearTranscriptUsageCache(): void {
  cache = null;
  fileCache.clear();
}
