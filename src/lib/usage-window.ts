import type { ClaudeStats } from '@/lib/claude-code';
import type { ElectronAPI } from '@/types/electron';
import { localDayKey } from '@/lib/usage-dates';

/**
 * The timeframe the Usage page is read over, and every figure on it.
 *
 * The page used to have a timeframe that only its cost chart obeyed: the tiles
 * and the provider rows summed everything ever recorded, the tokens and
 * messages charts took the last fourteen days that had any data, and the four
 * of them added cost up four different ways. The windows below are the cost
 * chart's own, fourteen days, twelve weeks or twelve months, and every figure
 * is now a sum over the one chosen, so the total is the sum of the bars and of
 * the rows under it.
 */

export type Timeframe = 'daily' | 'weekly' | 'monthly';

/** How the page names each timeframe: the control, the captions, the latest tile. */
export const TIMEFRAME_TEXT: Record<Timeframe, { control: string; length: string; unit: string; latest: string; now: string }> = {
  daily: { control: '14 days', length: '14 DAYS', unit: 'DAILY', latest: 'TODAY', now: 'today' },
  weekly: { control: '12 weeks', length: '12 WEEKS', unit: 'WEEKLY', latest: 'THIS WEEK', now: 'this week' },
  monthly: { control: '12 months', length: '12 MONTHS', unit: 'MONTHLY', latest: 'THIS MONTH', now: 'this month' },
};

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** `10 Sep` */
export function dayLabel(d: Date): string {
  return `${d.getDate()} ${MONTHS[d.getMonth()]}`;
}

/** `10 Sep 2026` */
export function dateLabel(d: Date): string {
  return `${dayLabel(d)} ${d.getFullYear()}`;
}

/** A `YYYY-MM-DD` local key back to local midnight of that day. */
export function dayOf(key: string): Date {
  const [y, m, d] = key.split('-').map(Number);
  return new Date(y, m - 1, d);
}

export interface Bucket {
  /** Its first day, as a local key: unique across the window. */
  key: string;
  /** `10 Sep`, `week of 5 Jul`, `Oct 2025`: the card's title and the chart's left edge. */
  label: string;
  /** Under the bar: the day of the month, or the month. */
  tick: string;
}

export interface UsageWindow {
  timeframe: Timeframe;
  buckets: Bucket[];
  /** Which bucket each local day belongs to. A day absent from it is outside the window. */
  bucketOf: Map<string, number>;
  /** The window's first day, and today. */
  start: Date;
  end: Date;
}

/**
 * The window a timeframe stands for, ending today.
 *
 * Fourteen days, twelve Sunday-to-Saturday weeks, or twelve calendar months,
 * the last one being the day, week or month that holds today. Fourteen is what
 * fits with a readable day number under every bar; thirty gave a picket fence
 * with five labels on it. The cost chart
 * used to end on the last day the transcripts had, which a second source
 * cannot share: a turn recorded only in the ledger, after the last transcript,
 * fell outside every window.
 */
export function usageWindow(timeframe: Timeframe, today: Date): UsageWindow {
  const end = new Date(today.getFullYear(), today.getMonth(), today.getDate());
  const buckets: Bucket[] = [];
  const bucketOf = new Map<string, number>();
  const add = (first: Date, days: number, label: string, tick: string) => {
    const index = buckets.push({ key: localDayKey(first), label, tick }) - 1;
    for (let i = 0; i < days; i++) {
      bucketOf.set(localDayKey(new Date(first.getFullYear(), first.getMonth(), first.getDate() + i)), index);
    }
  };

  if (timeframe === 'daily') {
    for (let i = 13; i >= 0; i--) {
      const day = new Date(end.getFullYear(), end.getMonth(), end.getDate() - i);
      add(day, 1, dayLabel(day), String(day.getDate()));
    }
  } else if (timeframe === 'weekly') {
    for (let i = 11; i >= 0; i--) {
      const sunday = new Date(end.getFullYear(), end.getMonth(), end.getDate() - end.getDay() - i * 7);
      add(sunday, 7, `week of ${dayLabel(sunday)}`, String(sunday.getDate()));
    }
  } else {
    for (let i = 11; i >= 0; i--) {
      const first = new Date(end.getFullYear(), end.getMonth() - i, 1);
      const length = new Date(first.getFullYear(), first.getMonth() + 1, 0).getDate();
      add(first, length, `${MONTHS[first.getMonth()]} ${first.getFullYear()}`, MONTHS[first.getMonth()].toLowerCase());
    }
  }

  return { timeframe, buckets, bucketOf, start: dayOf(buckets[0].key), end };
}

/** `10 Sep to 23 Sep`, with the years once the window crosses one. */
export function spanLabel(window: UsageWindow): string {
  const { start, end } = window;
  return start.getFullYear() === end.getFullYear()
    ? `${dayLabel(start)} to ${dayLabel(end)}`
    : `${dateLabel(start)} to ${dateLabel(end)}`;
}

type LedgerDay = Awaited<ReturnType<NonNullable<ElectronAPI['usage']>['byProvider']>>['daily'][number];
type TranscriptDay = ClaudeStats['dailyModelTokens'][number];

/**
 * One provider and model on one local day, from either source, in the page's
 * own terms.
 *
 * Tokens mean one thing everywhere on the page: in is input, cache reads and
 * cache writes together, which is everything the model was sent as the bill
 * counts it, and out is output.
 */
export interface UsageRow {
  date: string;
  provider: string;
  /** null when the ledger recorded a turn without one */
  model: string | null;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cost: number;
  /** Replies, which only the transcripts count. */
  messages: number;
}

/**
 * Which provider a model id belongs to. Transcript entries carry the model,
 * not the CLI that ran it, and every claude-* model comes from a claude-binary
 * provider whichever wrapper was used.
 */
export function providerForModel(modelId: string): string {
  const id = modelId.toLowerCase();
  if (id.startsWith('claude-') || /fable|mythos|opus|sonnet|haiku/.test(id)) return 'claude';
  if (id.startsWith('gpt-') || id.includes('codex')) return 'codex';
  if (id.startsWith('gemini')) return 'gemini';
  if (id.startsWith('grok')) return 'grok';
  if (id.startsWith('deepseek')) return 'deepseek';
  if (id.startsWith('kimi') || id.includes('moonshot')) return 'moonshot';
  if (id.startsWith('qwen')) return 'qwen';
  if (id.startsWith('minimax')) return 'minimax';
  if (id.startsWith('glm') || id.includes('zhipu')) return 'zhipu';
  if (id.startsWith('mimo')) return 'mimo';
  return 'claude';
}

/**
 * Every day both sources hold, as rows.
 *
 * One definition of cost: the transcripts priced per model by the main process
 * (`costByModel`), plus the ledger's turns of every provider but Claude. A
 * `claude` ledger row is an ACP turn of the claude binary, which writes its own
 * transcript: counting it again made Claude's row larger than Claude's spend.
 * Nothing is added from token-stats.json either; every session in it ran in
 * the claude binary too, so its cost is already in the transcripts.
 *
 * A day without the per-model split is the legacy stats-cache.json shape,
 * which the main process only returns when there is no transcript at all: its
 * tokens leave out the cache and it carries no price, so it has nothing to add
 * to figures defined as above.
 */
export function usageRows(days: TranscriptDay[] | undefined, ledger: LedgerDay[]): UsageRow[] {
  const rows: UsageRow[] = [];
  for (const day of days ?? []) {
    const models = new Set([
      ...Object.keys(day.breakdownByModel ?? {}),
      ...Object.keys(day.costByModel ?? {}),
      ...Object.keys(day.messagesByModel ?? {}),
    ]);
    for (const model of models) {
      const split = day.breakdownByModel?.[model];
      rows.push({
        date: day.date,
        provider: providerForModel(model),
        model,
        input: split?.input ?? 0,
        output: split?.output ?? 0,
        cacheRead: split?.cacheRead ?? 0,
        cacheWrite: split?.cacheWrite ?? 0,
        cost: day.costByModel?.[model] ?? 0,
        messages: day.messagesByModel?.[model] ?? 0,
      });
    }
  }
  for (const turn of ledger) {
    if (turn.provider === 'claude') continue;
    rows.push({
      date: turn.date,
      provider: turn.provider,
      model: turn.model,
      input: turn.inputTokens,
      output: turn.outputTokens,
      cacheRead: turn.cachedReadTokens,
      cacheWrite: turn.cachedWriteTokens,
      cost: turn.costUSD,
      messages: 0,
    });
  }
  return rows;
}

/**
 * The first day anything was recorded: the oldest transcript day or the
 * ledger's first day, whichever is earlier. Claude Code deletes transcripts
 * after about thirty days, so a window of twelve weeks or twelve months starts
 * before it, and the page has to say so.
 */
export function recordsStart(days: TranscriptDay[] | undefined, ledgerOldest: string | null): string | null {
  let first = ledgerOldest;
  for (const day of days ?? []) {
    if (!first || day.date < first) first = day.date;
  }
  return first;
}

export interface ModelTotals {
  key: string;
  provider: string;
  model: string | null;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cost: number;
  messages: number;
}

export interface BucketTotals {
  cost: number;
  /** in + out */
  tokens: number;
  messages: number;
  models: ModelTotals[];
}

export interface WindowTotals {
  cost: number;
  tokensIn: number;
  tokensOut: number;
  cacheRead: number;
  buckets: BucketTotals[];
  /** Per provider, with the models that did anything in the window. */
  providers: Array<{ provider: string; tokensIn: number; tokensOut: number; cost: number; models: Array<string | null> }>;
}

const emptyModel = (key: string, provider: string, model: string | null): ModelTotals =>
  ({ key, provider, model, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, messages: 0 });

/** Every figure the window holds, from one pass over the rows. */
export function windowTotals(rows: UsageRow[], window: UsageWindow): WindowTotals {
  const perBucket = window.buckets.map(() => new Map<string, ModelTotals>());
  for (const row of rows) {
    const index = window.bucketOf.get(row.date);
    if (index === undefined) continue;
    const key = `${row.provider}:${row.model ?? ''}`;
    const models = perBucket[index];
    const m = models.get(key) ?? emptyModel(key, row.provider, row.model);
    m.input += row.input;
    m.output += row.output;
    m.cacheRead += row.cacheRead;
    m.cacheWrite += row.cacheWrite;
    m.cost += row.cost;
    m.messages += row.messages;
    models.set(key, m);
  }

  const totals: WindowTotals = { cost: 0, tokensIn: 0, tokensOut: 0, cacheRead: 0, buckets: [], providers: [] };
  const providers = new Map<string, WindowTotals['providers'][number]>();
  for (const models of perBucket) {
    const bucket: BucketTotals = { cost: 0, tokens: 0, messages: 0, models: [...models.values()] };
    for (const m of models.values()) {
      const tokensIn = m.input + m.cacheRead + m.cacheWrite;
      bucket.cost += m.cost;
      bucket.tokens += tokensIn + m.output;
      bucket.messages += m.messages;
      totals.tokensIn += tokensIn;
      totals.tokensOut += m.output;
      totals.cacheRead += m.cacheRead;
      const p = providers.get(m.provider) ?? { provider: m.provider, tokensIn: 0, tokensOut: 0, cost: 0, models: [] };
      p.tokensIn += tokensIn;
      p.tokensOut += m.output;
      p.cost += m.cost;
      // A model that did nothing here is not named: transcripts carry a few
      // synthetic ids with no tokens at all.
      if ((tokensIn + m.output > 0 || m.cost > 0) && !p.models.includes(m.model)) p.models.push(m.model);
      providers.set(m.provider, p);
    }
    totals.cost += bucket.cost;
    totals.buckets.push(bucket);
  }
  totals.providers = [...providers.values()]
    .filter(p => p.cost > 0 || p.tokensIn + p.tokensOut > 0)
    .sort((a, b) => b.cost - a.cost || (b.tokensIn + b.tokensOut) - (a.tokensIn + a.tokensOut));
  return totals;
}

/**
 * Spend per provider from the first of this month to today, whatever the
 * timeframe: a budget is monthly, so comparing it with fourteen days or twelve
 * months would say nothing true.
 */
export function monthToDateByProvider(rows: UsageRow[], today: Date): Map<string, number> {
  const from = localDayKey(new Date(today.getFullYear(), today.getMonth(), 1));
  const to = localDayKey(today);
  const spend = new Map<string, number>();
  for (const row of rows) {
    if (row.date < from || row.date > to) continue;
    spend.set(row.provider, (spend.get(row.provider) ?? 0) + row.cost);
  }
  return spend;
}
