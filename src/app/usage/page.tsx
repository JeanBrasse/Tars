'use client';

import { useEffect, useMemo, useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { useClaude } from '@/hooks/useClaude';
import { getProviderDef } from '@/lib/providers';
import { localDayKey } from '@/lib/usage-dates';
import {
  TIMEFRAME_TEXT,
  dateLabel,
  dayOf,
  monthToDateByProvider,
  recordsStart,
  spanLabel,
  usageRows,
  usageWindow,
  windowTotals,
} from '@/lib/usage-window';
import type { ModelTotals, Timeframe } from '@/lib/usage-window';
import type { ElectronAPI } from '@/types/electron';
import { ProviderIconRenderer } from '@/components/ui/ProviderBadge';
import { BudgetAndLimits } from '@/components/Usage/BudgetAndLimits';
import { ErrorState, LoadingState, PageHeader, Panel, PanelCaption, SegmentedControl } from '@/components/ui';
import type { SegmentedOption } from '@/components/ui';

// Get friendly model name
function getModelDisplayName(modelId: string): string {
  const lower = modelId.toLowerCase();
  if (lower.includes('fable')) return 'Fable 5';
  if (lower.includes('mythos')) return 'Mythos 5';
  if (lower.includes('opus-5') || lower.includes('opus5')) return 'Opus 5';
  if (lower.includes('sonnet-5') || lower.includes('sonnet5')) return 'Sonnet 5';
  const lowerModel = modelId.toLowerCase();
  if (lowerModel.includes('opus-4-6') || lowerModel.includes('opus-4.6')) return 'Claude Opus 4.6';
  if (lowerModel.includes('opus-4-5') || lowerModel.includes('opus-4.5')) return 'Claude Opus 4.5';
  if (lowerModel.includes('opus-4-1') || lowerModel.includes('opus-4.1')) return 'Claude Opus 4.1';
  if (lowerModel.includes('opus-4') || lowerModel.includes('opus4')) return 'Claude Opus 4';
  if (lowerModel.includes('opus-3') || lowerModel.includes('opus3')) return 'Claude Opus 3';
  if (lowerModel.includes('sonnet-4-6') || lowerModel.includes('sonnet-4.6')) return 'Claude Sonnet 4.6';
  if (lowerModel.includes('sonnet-4-5') || lowerModel.includes('sonnet-4.5')) return 'Claude Sonnet 4.5';
  if (lowerModel.includes('sonnet-4') || lowerModel.includes('sonnet4')) return 'Claude Sonnet 4';
  if (lowerModel.includes('sonnet-3') || lowerModel.includes('sonnet3')) return 'Claude Sonnet 3.7';
  if (lowerModel.includes('haiku-4-5') || lowerModel.includes('haiku-4.5')) return 'Claude Haiku 4.5';
  if (lowerModel.includes('haiku-3-5') || lowerModel.includes('haiku-3.5')) return 'Claude Haiku 3.5';
  if (lowerModel.includes('haiku-3') || lowerModel.includes('haiku3')) return 'Claude Haiku 3';
  return modelId;
}

/**
 * The page's one timeframe, in the header because every figure on the page is
 * read over it. Named by the window it selects rather than by its bars:
 * `daily` over a total read as the day's total.
 */
const TIMEFRAMES: readonly SegmentedOption<Timeframe>[] = (['daily', 'weekly', 'monthly'] as const)
  .map(value => ({ value, label: TIMEFRAME_TEXT[value].control }));

/**
 * One of the four figures across the top. Caption, then the number in the
 * display serif, then a mono line saying what it is measured against.
 *
 * No tinted icon tile and no coloured value: on this page colour means money
 * (the cost column) or being over budget, nothing else.
 */
function StatCard({
  caption,
  value,
  sub,
  subClassName = 'text-muted-foreground',
}: {
  caption: string;
  value: string;
  sub: string;
  subClassName?: string;
}) {
  return (
    <Panel>
      <PanelCaption>{caption}</PanelCaption>
      <p className="mt-2 font-serif text-[28px] leading-none text-foreground">{value}</p>
      <p className={`mt-2 text-[11px] font-mono ${subClassName}`}>{sub}</p>
    </Panel>
  );
}

/**
 * 4200000 reads as 4.2M. Shared by the tiles, the charts and the provider
 * table. Counted with the cache, a fortnight runs to billions: without the B,
 * a provider row printed 111342.2M and ran into the column beside it.
 */
function fmtTokens(n: number): string {
  if (n >= 1_000_000_000) return `${(n / 1_000_000_000).toFixed(1)}B`;
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

/** $10,227.39: the tiles, the provider rows and the cost card. */
function fmtUsd(n: number): string {
  return `$${n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

/** A row or a card's name for a model, or its provider's when the ledger recorded none. */
function modelName(model: Pick<ModelTotals, 'provider' | 'model'>): string {
  return model.model ? getModelDisplayName(model.model) : (getProviderDef(model.provider)?.label ?? model.provider);
}

type Ledger = Pick<Awaited<ReturnType<NonNullable<ElectronAPI['usage']>['byProvider']>>, 'daily' | 'oldest'>;

/**
 * Where a bar's hover card hangs, by the bar's place in the series.
 *
 * The card used to have no horizontal anchor at all, so it started at the
 * hovered bar's left edge and grew rightwards: on the last bars of a chart it
 * left the panel, widened the document and made the whole page scroll sideways
 * to read a number that was already under the cursor. Anchored to the bar's own
 * edge near either end and centred in between, it lands inside the panel on
 * every bar. Frame: `Usage · daily messages`.
 *
 * Four and not two. The card is 190px wide and a bar is only as wide as the
 * panel divided by fourteen: at the 1024px breakpoint, where the charts are
 * still two to a row, that is about 20px, so centring the card on the third bar
 * would already hang it 36px off the left edge. Four covers every width the
 * window can take, down to a phone.
 */
const ANCHORED_BARS = 4;

function hoverCardAnchor(index: number, count: number): string {
  if (index < ANCHORED_BARS) return 'left-0';
  if (index >= count - ANCHORED_BARS) return 'right-0';
  return 'left-1/2 -translate-x-1/2';
}

/** The models of a bar's tokens card, biggest first, as the card lists them. */
function byTokens(models: ModelTotals[]) {
  return models
    .map(m => ({ ...m, total: m.input + m.cacheRead + m.cacheWrite + m.output }))
    .filter(m => m.total > 0)
    .sort((a, b) => b.total - a.total);
}

export default function UsagePage() {
  const { data, loading, error, refresh } = useClaude();
  const [timeframe, setTimeframe] = useState<Timeframe>('daily');
  /** Which bar the pointer is over, so the chart can show its own card. */
  const [hoveredBar, setHoveredBar] = useState<string | null>(null);
  const [hoveredTokenBar, setHoveredTokenBar] = useState<string | null>(null);
  const [hoveredMessageBar, setHoveredMessageBar] = useState<string | null>(null);
  const [ledger, setLedger] = useState<Ledger>({ daily: [], oldest: null });

  // Per-turn usage reported by the agents themselves. This is the only source
  // that covers the CLIs which write no transcript of their own. Read per day,
  // so it can be cut to the window like everything else.
  useEffect(() => {
    let cancelled = false;
    window.electronAPI?.usage?.byProvider()
      .then(res => { if (!cancelled) setLedger({ daily: res?.daily ?? [], oldest: res?.oldest ?? null }); })
      .catch(() => { if (!cancelled) setLedger({ daily: [], oldest: null }); });
    return () => { cancelled = true; };
  }, []);

  const days = data?.stats?.dailyModelTokens;
  const rows = useMemo(() => usageRows(days, ledger.daily), [days, ledger.daily]);

  // Read at every render rather than once, so the window moves on at midnight
  // without waiting for the figures to change.
  const todayKey = localDayKey(new Date());
  const period = useMemo(() => usageWindow(timeframe, dayOf(todayKey)), [timeframe, todayKey]);
  const totals = useMemo(() => windowTotals(rows, period), [rows, period]);
  const firstRecord = useMemo(() => recordsStart(days, ledger.oldest), [days, ledger.oldest]);

  // Who gets a budget row is who the ledger has seen, as before. What they
  // spent is this month's, on the page's one definition of cost: the row says
  // "this month", and used to print everything the ledger had ever recorded.
  const providerSpend = useMemo(() => {
    const spend = monthToDateByProvider(rows, dayOf(todayKey));
    return [...new Set(ledger.daily.map(turn => turn.provider))]
      .map(provider => ({ provider, costUSD: spend.get(provider) ?? 0 }))
      .sort((a, b) => b.costUSD - a.costUSD);
  }, [rows, ledger.daily, todayKey]);

  // The share of the window's spend that token-stats.json marks as past a
  // quota. A part of the total, never added to it: every one of those sessions
  // ran in the claude binary, so its cost is in the transcripts already. It is
  // an estimate as well, since a session is filed whole under the day it was
  // last seen on.
  const dailyCosts = data?.tokenStats?.dailyCosts;
  const overQuota = useMemo(() => {
    let sum = 0;
    for (const [date, entry] of Object.entries(dailyCosts ?? {})) {
      if (period.bucketOf.has(date)) sum += entry?.extraCost ?? 0;
    }
    return sum;
  }, [dailyCosts, period]);

  if (loading && !data) {
    return (
      <div className="flex items-center justify-center h-[60vh]">
        <LoadingState loading what="Still adding up what you spent…" detail="parsing session transcripts" />
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex h-[60vh] items-center justify-center">
        <ErrorState
          title="Could not read what your agents have spent."
          detail={error}
          onRetry={refresh}
        />
      </div>
    );
  }

  const stats = data?.stats;
  // Only the transcript path sets this, and only when it had to reconstruct
  // the figures itself, so it is absent far more often than it is zero.
  const unreadableCount = stats?.unreadable ?? 0;

  const text = TIMEFRAME_TEXT[timeframe];
  // One list of bars for the three charts, the latest tile and the edges under
  // them: the charts used to show three different periods side by side.
  const bars = period.buckets.map((bucket, i) => ({ ...bucket, ...totals.buckets[i] }));
  const latest = bars[bars.length - 1];
  const firstEdge = bars[0].label.toLowerCase();
  const maxCost = Math.max(...bars.map(b => b.cost), 0.01);
  const maxTokens = Math.max(...bars.map(b => b.tokens), 0);
  const maxMessages = Math.max(...bars.map(b => b.messages), 0);

  // Claude Code deletes its transcripts after about thirty days, so twelve
  // weeks or twelve months mostly reach back past anything recorded. Said
  // where the timeframe is chosen, rather than left for an empty bar to imply.
  const recordsLine = firstRecord && firstRecord > bars[0].key
    ? `records start ${dateLabel(dayOf(firstRecord))}`
    : null;

  return (
    // `overflow-x-clip`, not `overflow-x-hidden`: clip leaves the vertical axis
    // visible, so the hover cards still stand above their bars and out of the
    // panel, while nothing can widen the page. The anchoring above already keeps
    // every card inside its panel; this is what makes a sideways scrollbar
    // impossible rather than merely unlikely.
    <div className="space-y-3 overflow-x-clip">
      <PageHeader
        title="Usage"
        subtitle={
          <>
            What every provider has cost you, and where the tokens went.
            {/* A reserve on the figures, not an error: the total is right for
                what was read, and lower than the truth by however many
                transcripts could not be opened. Warning rather than danger,
                because nothing here is broken. */}
            {unreadableCount > 0 && (
              <span className="block mt-0.5 text-[11.5px] text-warning">
                {unreadableCount === 1
                  ? '1 transcript could not be read. These figures cover everything else.'
                  : `${unreadableCount} transcripts could not be read. These figures cover everything else.`}
              </span>
            )}
          </>
        }
        actions={
          <>
            {recordsLine && (
              <span className="mr-1 font-mono text-[11px] text-muted-foreground">{recordsLine}</span>
            )}
            <SegmentedControl
              options={TIMEFRAMES}
              value={timeframe}
              onChange={setTimeframe}
              ariaLabel="Timeframe"
            />
          </>
        }
      />

      {/* The four figures, over the timeframe. Colour here is reserved for money and for being over budget. */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-2">
        <StatCard
          caption="TOTAL COST"
          value={fmtUsd(totals.cost)}
          sub={overQuota > 0 ? `of which ~${fmtUsd(overQuota)} over quota` : spanLabel(period)}
          subClassName={overQuota > 0 ? 'text-danger' : 'text-muted-foreground'}
        />
        <StatCard caption={text.latest} value={fmtUsd(latest.cost)} sub={latest.label} />
        <StatCard
          caption="TOTAL TOKENS"
          value={fmtTokens(totals.tokensIn + totals.tokensOut)}
          sub={`${fmtTokens(totals.tokensIn)} in / ${fmtTokens(totals.tokensOut)} out`}
        />
        <StatCard
          caption="CACHE READS"
          value={fmtTokens(totals.cacheRead)}
          sub={totals.tokensIn > 0
            ? `${((totals.cacheRead / totals.tokensIn) * 100).toFixed(1)}% of tokens in`
            : 'tokens read from cache'}
        />
      </div>

      {/* Budget & limits: each provider gets the limit it actually has. Month
          to date and live, whatever the timeframe, and the panel says so. */}
      <BudgetAndLimits rateLimits={data?.rateLimits} providerSpend={providerSpend} />

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-2">
        {/* Usage by Provider, over the timeframe. Two sources, because no
            single one covers every CLI: Claude Code writes transcripts we can
            reconstruct after the fact, and every ACP turn reports its own
            tokens as it happens. */}
        <Panel className="flex flex-col">
          <PanelCaption>{`BY PROVIDER · ${text.length}`}</PanelCaption>
          {totals.providers.length === 0 ? (
            <p className="mt-3 text-xs text-muted-foreground">
              {rows.length > 0
                ? `Nothing recorded in these ${text.control}.`
                : 'Nothing recorded yet. Claude usage is read from its transcripts, and every other CLI is counted from the turns it reports back: delegate a task and it appears here.'}
            </p>
          ) : (
            <div className="mt-2 -mx-1">
              {totals.providers.map(totalsOf => {
                const def = getProviderDef(totalsOf.provider);
                const label = def?.label ?? totalsOf.provider;
                const icon = def?.icon;
                const names = [...new Set(totalsOf.models.flatMap(m => (m ? [getModelDisplayName(m)] : [])))];
                return (
                  <div
                    key={totalsOf.provider}
                    className="flex items-center gap-3 h-8 px-1 hover:bg-secondary"
                  >
                    <div className="flex items-center gap-2 min-w-0 flex-1">
                      {icon && <ProviderIconRenderer icon={icon} className="w-3.5 h-3.5 shrink-0" />}
                      <span className="text-[12.5px] truncate">{label}</span>
                    </div>
                    <span className="hidden md:block text-[11px] font-mono text-muted-foreground truncate max-w-[160px] text-right">
                      {names.join(', ') || '-'}
                    </span>
                    <span className="text-[11px] font-mono tabular-nums text-muted-foreground w-12 text-right">
                      {fmtTokens(totalsOf.tokensIn)}
                    </span>
                    <span className="text-[11px] font-mono tabular-nums text-muted-foreground w-12 text-right">
                      {fmtTokens(totalsOf.tokensOut)}
                    </span>
                    <span className="text-[11px] font-mono tabular-nums text-status-running w-20 text-right">
                      {totalsOf.cost > 0 ? fmtUsd(totalsOf.cost) : '-'}
                    </span>
                  </div>
                );
              })}
            </div>
          )}
        </Panel>

        {/* Cost over time */}
        <Panel className="h-[260px] flex flex-col">
          <PanelCaption className="shrink-0">{`${text.unit} COST · ${text.length}`}</PanelCaption>

          <AnimatePresence mode="wait">
            <motion.div
              key={timeframe}
              initial={{ opacity: 0, y: 6 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -6 }}
              transition={{ duration: 0.2 }}
              className="flex flex-col flex-1 min-h-0 mt-3"
            >
              <div className="flex items-stretch gap-1 flex-1 min-h-0">
                {bars.map((item, i) => {
                  const height = maxCost > 0 ? (item.cost / maxCost) * 100 : 0;
                  // Only the latest bucket carries the accent; the rest are
                  // the neutral raised surface.
                  const isLatest = i === bars.length - 1;
                  return (
                    <div
                      key={item.key}
                      className="group relative flex-1 min-w-0 flex flex-col items-center gap-1"
                      onMouseEnter={() => setHoveredBar(item.key)}
                      onMouseLeave={() => setHoveredBar(null)}
                    >
                      {/* The app's own card, not the operating system's
                          tooltip: `title` renders a grey system box in a
                          system font that ignores the palette entirely. */}
                      {hoveredBar === item.key && (
                        <div className={`absolute ${hoverCardAnchor(i, bars.length)} bottom-full mb-1.5 z-20 pointer-events-none border border-border bg-secondary px-2.5 py-1.5 whitespace-nowrap`}>
                          <p className="font-mono text-[10px] text-muted-foreground">{item.label}</p>
                          <p className="font-mono text-xs font-medium text-foreground">
                            {fmtUsd(item.cost)}
                          </p>
                        </div>
                      )}
                      <div className="w-full flex flex-col justify-end flex-1 min-h-0">
                        <motion.div
                          initial={{ height: 0 }}
                          animate={{ height: `${Math.max(height, 2)}%` }}
                          transition={{ delay: 0.05 + i * 0.02, duration: 0.35 }}
                          className={`w-full transition-colors ${
                            isLatest ? 'bg-primary' : 'bg-bg-tertiary'
                          } ${hoveredBar === item.key ? 'bg-primary' : ''}`}
                        />
                      </div>
                      <span className="text-[9px] leading-none text-muted-foreground">{item.tick}</span>
                    </div>
                  );
                })}
              </div>
              <div className="flex items-center justify-between mt-1.5 text-[10px] text-muted-foreground">
                <span>{firstEdge}</span>
                <span>{text.now}</span>
              </div>
            </motion.div>
          </AnimatePresence>
        </Panel>
        {/* Tokens over time. The cost chart says what a bar cost; this says
            what it was made of, and its card breaks the bar down per model
            into input, cache and output. A single total hides which model is
            doing the spending, and cache reads dwarf everything. */}
        <Panel className="h-[260px] flex flex-col">
          <PanelCaption className="shrink-0">{`${text.unit} TOKENS · ${text.length}`}</PanelCaption>

          <div className="flex flex-col flex-1 min-h-0 mt-3">
            <div className="flex items-stretch gap-1 flex-1 min-h-0">
              {bars.map((bar, i) => {
                const height = maxTokens > 0 ? (bar.tokens / maxTokens) * 100 : 0;
                const isLatest = i === bars.length - 1;
                const open = hoveredTokenBar === bar.key;
                return (
                  <div
                    key={bar.key}
                    className="relative flex-1 min-w-0 flex flex-col items-center gap-1"
                    onMouseEnter={() => setHoveredTokenBar(bar.key)}
                    onMouseLeave={() => setHoveredTokenBar(null)}
                  >
                    {open && (
                      <div className={`absolute ${hoverCardAnchor(i, bars.length)} bottom-full mb-1.5 z-20 pointer-events-none border border-border bg-secondary px-3 py-2 min-w-[190px]`}>
                        <p className="font-mono text-[11px] font-medium text-foreground">
                          {bar.label} · {fmtTokens(bar.tokens)} tokens
                        </p>
                        {byTokens(bar.models).slice(0, 3).map(model => (
                          <div key={model.key} className="mt-2">
                            <p className="font-mono text-[10px] font-medium text-text-secondary truncate">
                              {modelName(model)}
                            </p>
                            {/* In order: the three parts of what went in, then
                                what came out. The tiles call their sum in. */}
                            {([
                              ['input', model.input],
                              ['cache read', model.cacheRead],
                              ['cache write', model.cacheWrite],
                              ['output', model.output],
                            ] as const).map(([label, n]) => (
                              <div key={label} className="flex items-baseline justify-between gap-4">
                                <span className="font-mono text-[10px] text-muted-foreground">{label}</span>
                                <span className="font-mono text-[10px] tabular-nums text-text-secondary">
                                  {fmtTokens(n)}
                                </span>
                              </div>
                            ))}
                          </div>
                        ))}
                      </div>
                    )}
                    <div className="w-full flex flex-col justify-end flex-1 min-h-0">
                      <div
                        className={`w-full transition-colors ${
                          isLatest || open ? 'bg-primary' : 'bg-bg-tertiary'
                        }`}
                        style={{ height: `${Math.max(height, 2)}%` }}
                      />
                    </div>
                    <span className="text-[9px] leading-none text-muted-foreground">{bar.tick}</span>
                  </div>
                );
              })}
            </div>
            <div className="flex items-center justify-between mt-1.5 text-[10px] text-muted-foreground">
              <span>{firstEdge}</span>
              <span>{text.now}</span>
            </div>
          </div>
        </Panel>

        {/* How many replies came back, which tokens cannot answer: one long
            turn and forty short ones look alike by volume. A reply is counted
            once even though the transcript writes one API response as several
            lines; transcript-usage.ts counts off the message id the token
            dedup uses. Frame: `Usage · daily messages`. */}
        <Panel className="h-[260px] flex flex-col">
          <PanelCaption className="shrink-0">{`${text.unit} MESSAGES · ${text.length}`}</PanelCaption>

          <div className="flex flex-col flex-1 min-h-0 mt-3">
            <div className="flex items-stretch gap-1 flex-1 min-h-0">
              {bars.map((bar, i) => {
                const height = maxMessages > 0 ? (bar.messages / maxMessages) * 100 : 0;
                const isLatest = i === bars.length - 1;
                const open = hoveredMessageBar === bar.key;
                const models = bar.models.filter(m => m.messages > 0).sort((a, b) => b.messages - a.messages);
                return (
                  <div
                    key={bar.key}
                    className="relative flex-1 min-w-0 flex flex-col items-center gap-1"
                    onMouseEnter={() => setHoveredMessageBar(bar.key)}
                    onMouseLeave={() => setHoveredMessageBar(null)}
                  >
                    {open && (
                      <div className={`absolute ${hoverCardAnchor(i, bars.length)} bottom-full mb-1.5 z-20 pointer-events-none border border-border bg-secondary px-3 py-2 min-w-[190px]`}>
                        <p className="font-mono text-[11px] font-medium text-foreground">
                          {bar.label} · {bar.messages.toLocaleString()} {bar.messages === 1 ? 'message' : 'messages'}
                        </p>
                        {models.slice(0, 4).map(model => (
                          <div key={model.key} className="mt-1.5 flex items-baseline justify-between gap-4">
                            <span className="font-mono text-[10px] text-muted-foreground truncate">
                              {modelName(model)}
                            </span>
                            <span className="font-mono text-[10px] tabular-nums text-text-secondary">
                              {model.messages.toLocaleString()}
                            </span>
                          </div>
                        ))}
                      </div>
                    )}
                    <div className="w-full flex flex-col justify-end flex-1 min-h-0">
                      <div
                        className={`w-full transition-colors ${
                          isLatest || open ? 'bg-primary' : 'bg-bg-tertiary'
                        }`}
                        style={{ height: `${Math.max(height, 2)}%` }}
                      />
                    </div>
                    <span className="text-[9px] leading-none text-muted-foreground">{bar.tick}</span>
                  </div>
                );
              })}
            </div>
            <div className="flex items-center justify-between mt-1.5 text-[10px] text-muted-foreground">
              <span>{firstEdge}</span>
              <span>{text.now}</span>
            </div>
          </div>
        </Panel>

      </div>
    </div>
  );
}
