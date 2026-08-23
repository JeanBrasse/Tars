import * as fs from 'fs';
import * as path from 'path';
import { DATA_DIR } from '../constants';
import { priceFor } from './model-catalog';

/**
 * Per-turn usage, for every provider.
 *
 * Claude Code writes its own transcripts, so its usage can be reconstructed
 * after the fact. No other CLI does, which is why "Usage by Provider" showed
 * nothing: it read a file only the statusline wrote, and the statusline is off
 * by default. Every ACP turn reports its tokens, so this records them as they
 * happen - that is the only source that covers Codex, Gemini, Grok and the rest.
 */

const LEDGER_FILE = path.join(DATA_DIR, 'usage-ledger.jsonl');
const MAX_LINES = 20_000;
const TRIM_TO = 12_000;

export interface UsageEntry {
  ts: string;
  agentId: string;
  provider: string;
  model?: string;
  inputTokens: number;
  outputTokens: number;
  cachedReadTokens?: number;
  cachedWriteTokens?: number;
  costUSD?: number;
  transport: 'acp' | 'pty';
}

export interface ProviderTotals {
  provider: string;
  inputTokens: number;
  outputTokens: number;
  costUSD: number;
  turns: number;
  models: string[];
  /** true when at least one entry carried a cost from the agent itself */
  measured: boolean;
}

export function recordUsage(entry: Omit<UsageEntry, 'ts'>): void {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });

    // Price it here when the agent did not: the catalogue knows the rate.
    let costUSD = entry.costUSD;
    if (costUSD == null && entry.model) {
      const price = priceFor(entry.model, entry.provider);
      if (price?.input != null && price?.output != null) {
        costUSD =
          (entry.inputTokens / 1e6) * price.input +
          (entry.outputTokens / 1e6) * price.output +
          ((entry.cachedReadTokens ?? 0) / 1e6) * (price.cache_read ?? price.input * 0.1) +
          ((entry.cachedWriteTokens ?? 0) / 1e6) * (price.cache_write ?? price.input * 1.25);
      }
    }

    const record: UsageEntry = { ts: new Date().toISOString(), ...entry, costUSD };
    fs.appendFileSync(LEDGER_FILE, `${JSON.stringify(record)}\n`);

    const lines = fs.readFileSync(LEDGER_FILE, 'utf-8').trimEnd().split('\n');
    if (lines.length > MAX_LINES) {
      fs.writeFileSync(LEDGER_FILE, `${lines.slice(-TRIM_TO).join('\n')}\n`);
    }
  } catch (err) {
    console.error('[usage] could not record a turn:', err);
  }
}

export function readLedger(sinceDays?: number): UsageEntry[] {
  try {
    if (!fs.existsSync(LEDGER_FILE)) return [];
    const cutoff = sinceDays
      ? new Date(Date.now() - sinceDays * 86_400_000).toISOString()
      : null;

    return fs.readFileSync(LEDGER_FILE, 'utf-8').trimEnd().split('\n').flatMap(line => {
      try {
        const entry = JSON.parse(line) as UsageEntry;
        if (cutoff && entry.ts < cutoff) return [];
        return [entry];
      } catch {
        return [];
      }
    });
  } catch {
    return [];
  }
}

/** Totals per provider, from the ledger alone. */
export function providerTotals(sinceDays?: number): ProviderTotals[] {
  const byProvider = new Map<string, ProviderTotals>();

  for (const entry of readLedger(sinceDays)) {
    const totals = byProvider.get(entry.provider) ?? {
      provider: entry.provider,
      inputTokens: 0,
      outputTokens: 0,
      costUSD: 0,
      turns: 0,
      models: [],
      measured: false,
    };
    totals.inputTokens += entry.inputTokens || 0;
    totals.outputTokens += entry.outputTokens || 0;
    totals.costUSD += entry.costUSD || 0;
    totals.turns += 1;
    if (entry.model && !totals.models.includes(entry.model)) totals.models.push(entry.model);
    byProvider.set(entry.provider, totals);
  }

  return Array.from(byProvider.values()).sort((a, b) => b.costUSD - a.costUSD);
}

/**
 * Daily cost from the ledger, for charting alongside the transcript data.
 *
 * `entry.ts` is `Date.toISOString()`, i.e. UTC. Slicing its first ten
 * characters keys a turn by its UTC calendar day, which disagrees with the
 * local day transcript-usage.ts and the Usage page key by - the same bug
 * class fixed there: a turn at 02:30 local in Tbilisi (22:30 UTC the day
 * before) landed under yesterday's date.
 */
export function dailyCost(sinceDays = 30): Record<string, number> {
  const out: Record<string, number> = {};
  const pad = (n: number) => String(n).padStart(2, '0');
  for (const entry of readLedger(sinceDays)) {
    const d = new Date(entry.ts);
    if (Number.isNaN(d.getTime())) continue;
    const day = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
    out[day] = (out[day] || 0) + (entry.costUSD || 0);
  }
  return out;
}

/** Test seam. */
export function ledgerPath(): string {
  return LEDGER_FILE;
}
