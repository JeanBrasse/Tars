'use client';

import { useEffect, useMemo, useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { AlertCircle } from 'lucide-react';
import { useClaude } from '@/hooks/useClaude';
import { getProviderDef } from '@/lib/providers';
import { ProviderIconRenderer } from '@/components/ProviderBadge';
import { BudgetAndLimits } from '@/components/Usage/BudgetAndLimits';
import { LoadingState, PageHeader, Panel, PanelCaption, SegmentedControl } from '@/components/ui';
import type { SegmentedOption } from '@/components/ui';

// Token pricing per million tokens (MTok)
const MODEL_PRICING: Record<string, {
  inputPerMTok: number;
  outputPerMTok: number;
  cacheHitsPerMTok: number;
  cache5mWritePerMTok: number;
  cache1hWritePerMTok: number;
}> = {
  // Fable 5 - Anthropic's most capable widely released model
  'claude-fable-5': { inputPerMTok: 10, outputPerMTok: 50, cacheHitsPerMTok: 1.00, cache5mWritePerMTok: 12.50, cache1hWritePerMTok: 20 },
  'fable': { inputPerMTok: 10, outputPerMTok: 50, cacheHitsPerMTok: 1.00, cache5mWritePerMTok: 12.50, cache1hWritePerMTok: 20 },
  // Opus 5
  'claude-opus-5': { inputPerMTok: 5, outputPerMTok: 25, cacheHitsPerMTok: 0.50, cache5mWritePerMTok: 6.25, cache1hWritePerMTok: 10 },
  // Sonnet 5
  'claude-sonnet-5': { inputPerMTok: 3, outputPerMTok: 15, cacheHitsPerMTok: 0.30, cache5mWritePerMTok: 3.75, cache1hWritePerMTok: 6 },
  // Opus 4.6
  'claude-opus-4-6-20250514': { inputPerMTok: 5, outputPerMTok: 25, cacheHitsPerMTok: 0.50, cache5mWritePerMTok: 6.25, cache1hWritePerMTok: 10 },
  'claude-opus-4-6': { inputPerMTok: 5, outputPerMTok: 25, cacheHitsPerMTok: 0.50, cache5mWritePerMTok: 6.25, cache1hWritePerMTok: 10 },
  // Opus 4.5
  'claude-opus-4-5-20251101': { inputPerMTok: 5, outputPerMTok: 25, cacheHitsPerMTok: 0.50, cache5mWritePerMTok: 6.25, cache1hWritePerMTok: 10 },
  'claude-opus-4-5': { inputPerMTok: 5, outputPerMTok: 25, cacheHitsPerMTok: 0.50, cache5mWritePerMTok: 6.25, cache1hWritePerMTok: 10 },
  // Opus 4.1
  'claude-opus-4-1-20250501': { inputPerMTok: 15, outputPerMTok: 75, cacheHitsPerMTok: 1.50, cache5mWritePerMTok: 18.75, cache1hWritePerMTok: 30 },
  'claude-opus-4-1': { inputPerMTok: 15, outputPerMTok: 75, cacheHitsPerMTok: 1.50, cache5mWritePerMTok: 18.75, cache1hWritePerMTok: 30 },
  // Opus 4
  'claude-opus-4-20250514': { inputPerMTok: 15, outputPerMTok: 75, cacheHitsPerMTok: 1.50, cache5mWritePerMTok: 18.75, cache1hWritePerMTok: 30 },
  'claude-opus-4': { inputPerMTok: 15, outputPerMTok: 75, cacheHitsPerMTok: 1.50, cache5mWritePerMTok: 18.75, cache1hWritePerMTok: 30 },
  // Sonnet 4.6
  'claude-sonnet-4-6-20250514': { inputPerMTok: 3, outputPerMTok: 15, cacheHitsPerMTok: 0.30, cache5mWritePerMTok: 3.75, cache1hWritePerMTok: 6 },
  'claude-sonnet-4-6': { inputPerMTok: 3, outputPerMTok: 15, cacheHitsPerMTok: 0.30, cache5mWritePerMTok: 3.75, cache1hWritePerMTok: 6 },
  // Sonnet 4.5
  'claude-sonnet-4-5-20251022': { inputPerMTok: 3, outputPerMTok: 15, cacheHitsPerMTok: 0.30, cache5mWritePerMTok: 3.75, cache1hWritePerMTok: 6 },
  'claude-sonnet-4-5': { inputPerMTok: 3, outputPerMTok: 15, cacheHitsPerMTok: 0.30, cache5mWritePerMTok: 3.75, cache1hWritePerMTok: 6 },
  // Sonnet 4
  'claude-sonnet-4-20250514': { inputPerMTok: 3, outputPerMTok: 15, cacheHitsPerMTok: 0.30, cache5mWritePerMTok: 3.75, cache1hWritePerMTok: 6 },
  'claude-sonnet-4': { inputPerMTok: 3, outputPerMTok: 15, cacheHitsPerMTok: 0.30, cache5mWritePerMTok: 3.75, cache1hWritePerMTok: 6 },
  // Sonnet 3.7 (deprecated)
  'claude-3-7-sonnet-20250219': { inputPerMTok: 3, outputPerMTok: 15, cacheHitsPerMTok: 0.30, cache5mWritePerMTok: 3.75, cache1hWritePerMTok: 6 },
  'claude-sonnet-3-7': { inputPerMTok: 3, outputPerMTok: 15, cacheHitsPerMTok: 0.30, cache5mWritePerMTok: 3.75, cache1hWritePerMTok: 6 },
  // Haiku 4.5
  'claude-haiku-4-5-20251022': { inputPerMTok: 1, outputPerMTok: 5, cacheHitsPerMTok: 0.10, cache5mWritePerMTok: 1.25, cache1hWritePerMTok: 2 },
  'claude-haiku-4-5': { inputPerMTok: 1, outputPerMTok: 5, cacheHitsPerMTok: 0.10, cache5mWritePerMTok: 1.25, cache1hWritePerMTok: 2 },
  // Haiku 3.5
  'claude-3-5-haiku-20241022': { inputPerMTok: 0.80, outputPerMTok: 4, cacheHitsPerMTok: 0.08, cache5mWritePerMTok: 1, cache1hWritePerMTok: 1.6 },
  'claude-haiku-3-5': { inputPerMTok: 0.80, outputPerMTok: 4, cacheHitsPerMTok: 0.08, cache5mWritePerMTok: 1, cache1hWritePerMTok: 1.6 },
  // Opus 3 (deprecated)
  'claude-3-opus-20240229': { inputPerMTok: 15, outputPerMTok: 75, cacheHitsPerMTok: 1.50, cache5mWritePerMTok: 18.75, cache1hWritePerMTok: 30 },
  'claude-opus-3': { inputPerMTok: 15, outputPerMTok: 75, cacheHitsPerMTok: 1.50, cache5mWritePerMTok: 18.75, cache1hWritePerMTok: 30 },
  // Haiku 3
  'claude-3-haiku-20240307': { inputPerMTok: 0.25, outputPerMTok: 1.25, cacheHitsPerMTok: 0.03, cache5mWritePerMTok: 0.30, cache1hWritePerMTok: 0.50 },
  'claude-haiku-3': { inputPerMTok: 0.25, outputPerMTok: 1.25, cacheHitsPerMTok: 0.03, cache5mWritePerMTok: 0.30, cache1hWritePerMTok: 0.50 },
};

// Get pricing for a model (with fallback)
/**
 * Prices fetched from the live catalogue for the models actually seen in the
 * data. Populated once per page load; the table below is the offline floor.
 */
const livePricing = new Map<string, { inputPerMTok: number; outputPerMTok: number; cacheHitsPerMTok: number; cache5mWritePerMTok: number; cache1hWritePerMTok: number }>();

async function loadLivePricing(modelIds: string[]): Promise<boolean> {
  const missing = modelIds.filter(id => !livePricing.has(id));
  if (missing.length === 0) return false;
  const results = await Promise.all(missing.map(async id => {
    try {
      const res = await window.electronAPI?.models?.price(id);
      return [id, res?.price] as const;
    } catch {
      return [id, null] as const;
    }
  }));
  let changed = false;
  for (const [id, price] of results) {
    if (!price || typeof price.input !== 'number' || typeof price.output !== 'number') continue;
    livePricing.set(id, {
      inputPerMTok: price.input,
      outputPerMTok: price.output,
      cacheHitsPerMTok: price.cache_read ?? price.input * 0.1,
      cache5mWritePerMTok: price.cache_write ?? price.input * 1.25,
      cache1hWritePerMTok: price.input * 2,
    });
    changed = true;
  }
  return changed;
}

/**
 * Which provider a model id belongs to. Transcript entries carry the model,
 * not the CLI that ran it, and every claude-* model comes from a claude-binary
 * provider whichever wrapper was used.
 */
function providerForModel(modelId: string): string {
  const id = modelId.toLowerCase();
  if (id.startsWith('claude-') || /fable|mythos|opus|sonnet|haiku/.test(id)) return 'claude';
  if (id.startsWith('gpt-') || id.includes('codex')) return 'codex';
  if (id.startsWith('gemini')) return 'gemini';
  if (id.startsWith('grok')) return 'grok';
  if (id.startsWith('deepseek')) return 'deepseek';
  if (id.startsWith('kimi') || id.includes('moonshot')) return 'moonshot';
  if (id.startsWith('qwen')) return 'qwen';
  if (id.toLowerCase().startsWith('minimax')) return 'minimax';
  if (id.startsWith('glm') || id.includes('zhipu')) return 'zhipu';
  if (id.startsWith('mimo')) return 'mimo';
  return 'claude';
}

function getModelPricing(modelId: string) {
  const live = livePricing.get(modelId);
  if (live) return live;

  // Try exact match first
  if (MODEL_PRICING[modelId]) return MODEL_PRICING[modelId];

  // Try partial match
  const lowerModel = modelId.toLowerCase();
  if (lowerModel.includes('fable') || lowerModel.includes('mythos')) {
    return MODEL_PRICING['claude-fable-5'];
  }
  if (lowerModel.includes('opus-5') || lowerModel.includes('opus5')) {
    return MODEL_PRICING['claude-opus-5'];
  }
  if (lowerModel.includes('sonnet-5') || lowerModel.includes('sonnet5')) {
    return MODEL_PRICING['claude-sonnet-5'];
  }
  if (lowerModel.includes('opus-4-6') || lowerModel.includes('opus-4.6')) {
    return MODEL_PRICING['claude-opus-4-6'];
  }
  if (lowerModel.includes('opus-4-5') || lowerModel.includes('opus-4.5')) {
    return MODEL_PRICING['claude-opus-4-5'];
  }
  if (lowerModel.includes('opus-4-1') || lowerModel.includes('opus-4.1')) {
    return MODEL_PRICING['claude-opus-4-1'];
  }
  if (lowerModel.includes('opus-4') || lowerModel.includes('opus4')) {
    return MODEL_PRICING['claude-opus-4'];
  }
  if (lowerModel.includes('opus-3') || lowerModel.includes('opus3')) {
    return MODEL_PRICING['claude-opus-3'];
  }
  if (lowerModel.includes('sonnet-4-6') || lowerModel.includes('sonnet-4.6')) {
    return MODEL_PRICING['claude-sonnet-4-6'];
  }
  if (lowerModel.includes('sonnet-4-5') || lowerModel.includes('sonnet-4.5')) {
    return MODEL_PRICING['claude-sonnet-4-5'];
  }
  if (lowerModel.includes('sonnet-4') || lowerModel.includes('sonnet4')) {
    return MODEL_PRICING['claude-sonnet-4'];
  }
  if (lowerModel.includes('sonnet-3') || lowerModel.includes('sonnet3')) {
    return MODEL_PRICING['claude-sonnet-3-7'];
  }
  if (lowerModel.includes('haiku-4-5') || lowerModel.includes('haiku-4.5')) {
    return MODEL_PRICING['claude-haiku-4-5'];
  }
  if (lowerModel.includes('haiku-3-5') || lowerModel.includes('haiku-3.5')) {
    return MODEL_PRICING['claude-haiku-3-5'];
  }
  if (lowerModel.includes('haiku-3') || lowerModel.includes('haiku3')) {
    return MODEL_PRICING['claude-haiku-3'];
  }

  // Default to Sonnet 4 pricing
  return MODEL_PRICING['claude-sonnet-4'];
}

// Calculate cost for a model usage
function calculateModelCost(
  modelId: string,
  inputTokens: number,
  outputTokens: number,
  cacheReadTokens: number = 0,
  cacheWriteTokens: number = 0
): number {
  const pricing = getModelPricing(modelId);

  const inputCost = (inputTokens / 1_000_000) * pricing.inputPerMTok;
  const outputCost = (outputTokens / 1_000_000) * pricing.outputPerMTok;
  const cacheReadCost = (cacheReadTokens / 1_000_000) * pricing.cacheHitsPerMTok;
  // Use 5m cache write pricing (most common)
  const cacheWriteCost = (cacheWriteTokens / 1_000_000) * pricing.cache5mWritePerMTok;

  return inputCost + outputCost + cacheReadCost + cacheWriteCost;
}

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

type TimeRange = 'daily' | 'weekly' | 'monthly';

const COST_RANGES: readonly SegmentedOption<TimeRange>[] = [
  { value: 'daily', label: 'daily' },
  { value: 'weekly', label: 'weekly' },
  { value: 'monthly', label: 'monthly' },
];

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

export default function UsagePage() {
  const { data, loading, error } = useClaude();
  const [costTimeRange, setCostTimeRange] = useState<TimeRange>('daily');
  const [, setPricingLoaded] = useState(0);
  const [ledger, setLedger] = useState<Array<{ provider: string; inputTokens: number; outputTokens: number; costUSD: number; turns: number }>>([]);

  // Calculate total usage and cost from model stats
  // Per-turn usage reported by the agents themselves. This is the only source
  // that covers the CLIs which write no transcript of their own.
  useEffect(() => {
    let cancelled = false;
    window.electronAPI?.usage?.byProvider()
      .then(res => { if (!cancelled) setLedger(res?.providers ?? []); })
      .catch(() => { if (!cancelled) setLedger([]); });
    return () => { cancelled = true; };
  }, []);

  // Pull live prices for whatever models the data actually contains, then
  // nudge a re-render so the figures pick them up.
  useEffect(() => {
    const ids = Object.keys(data?.stats?.modelUsage || {});
    if (ids.length === 0) return;
    let cancelled = false;
    loadLivePricing(ids).then(changed => {
      if (changed && !cancelled) setPricingLoaded(n => n + 1);
    });
    return () => { cancelled = true; };
  }, [data?.stats?.modelUsage]);

  const totalUsage = useMemo(() => {
    if (!data?.stats?.modelUsage) return { totalCost: 0, totalTokens: 0, totalInput: 0, totalOutput: 0, totalCacheRead: 0, totalCacheWrite: 0 };

    let totalCost = 0;
    let totalInput = 0;
    let totalOutput = 0;
    let totalCacheRead = 0;
    let totalCacheWrite = 0;

    Object.entries(data.stats.modelUsage).forEach(([modelId, usage]) => {
      totalInput += usage.inputTokens || 0;
      totalOutput += usage.outputTokens || 0;
      totalCacheRead += usage.cacheReadInputTokens || 0;
      totalCacheWrite += usage.cacheCreationInputTokens || 0;

      // Use actual costUSD if available (Claude tracks this natively), else estimate
      if (usage.costUSD && usage.costUSD > 0) {
        totalCost += usage.costUSD;
      } else {
        totalCost += calculateModelCost(
          modelId,
          usage.inputTokens || 0,
          usage.outputTokens || 0,
          usage.cacheReadInputTokens || 0,
          usage.cacheCreationInputTokens || 0
        );
      }
    });

    return {
      totalCost,
      totalTokens: totalInput + totalOutput,
      totalInput,
      totalOutput,
      totalCacheRead,
      totalCacheWrite,
    };
  }, [data?.stats?.modelUsage]);

  // Cost-per-(input+output)-token rate for each model.
  // dailyModelTokens only tracks input+output tokens per day (not cache).
  // We compute rate = all_time_cost / (all_time_input + all_time_output) per model.
  // This properly amortises cache costs across productive token output.
  const costPerTokenByModel = useMemo(() => {
    if (!data?.stats?.modelUsage) return new Map<string, number>();
    const rateMap = new Map<string, number>();
    Object.entries(data.stats.modelUsage).forEach(([modelId, usage]) => {
      const nonCacheTotal = (usage.inputTokens || 0) + (usage.outputTokens || 0);
      if (nonCacheTotal === 0) return;
      // costUSD is the measured figure — it knows the 1h/5m cache write split,
      // which the flat table below has to guess at.
      const cost = usage.costUSD && usage.costUSD > 0
        ? usage.costUSD
        : calculateModelCost(
          modelId,
          usage.inputTokens || 0,
          usage.outputTokens || 0,
          usage.cacheReadInputTokens || 0,
          usage.cacheCreationInputTokens || 0,
        );
      rateMap.set(modelId, cost / nonCacheTotal);
    });
    return rateMap;
  }, [data?.stats?.modelUsage]);

  // Per-day cost map derived from per-model daily tokens × per-model cost rate
  const dailyCostMap = useMemo(() => {
    if (!data?.stats?.dailyModelTokens) return new Map<string, number>();
    const map = new Map<string, number>();
    data.stats.dailyModelTokens.forEach(day => {
      let dayCost = 0;
      Object.entries(day.tokensByModel).forEach(([modelId, tokens]) => {
        const rate = costPerTokenByModel.get(modelId);
        if (rate !== undefined) {
          dayCost += tokens * rate;
        } else {
          // Fallback: rough estimate assuming even input/output split
          dayCost += calculateModelCost(modelId, tokens / 2, tokens / 2, 0, 0);
        }
      });
      map.set(day.date, dayCost);
    });
    return map;
  }, [data?.stats?.dailyModelTokens, costPerTokenByModel]);

  // Calculate cost breakdown by model
  const modelCostBreakdown = useMemo(() => {
    if (!data?.stats?.modelUsage) return [];

    return Object.entries(data.stats.modelUsage).map(([modelId, usage]) => {
      const cost = usage.costUSD && usage.costUSD > 0
        ? usage.costUSD
        : calculateModelCost(
          modelId,
          usage.inputTokens || 0,
          usage.outputTokens || 0,
          usage.cacheReadInputTokens || 0,
          usage.cacheCreationInputTokens || 0
        );

      const pricing = getModelPricing(modelId);

      return {
        modelId,
        displayName: getModelDisplayName(modelId),
        cost,
        inputTokens: usage.inputTokens || 0,
        outputTokens: usage.outputTokens || 0,
        cacheReadTokens: usage.cacheReadInputTokens || 0,
        cacheWriteTokens: usage.cacheCreationInputTokens || 0,
        webSearchRequests: usage.webSearchRequests || 0,
        pricing,
      };
    }).sort((a, b) => b.cost - a.cost);
  }, [data?.stats?.modelUsage]);

  // Latest available date in stats (stats-cache.json is updated by Claude Code on session end,
  // so it may lag behind real-time - use lastComputedDate instead of today's calendar date)
  const latestDataDate = data?.stats?.lastComputedDate ?? null;

  // Get cost data for charts based on time range.
  // Anchor to lastComputedDate (not today's calendar date) since stats-cache.json
  // is only updated by Claude Code on session completion and may lag behind real-time.
  const costChartData = useMemo(() => {
    // Anchor date: latest date that has data, fallback to today
    const anchor = latestDataDate ? new Date(latestDataDate + 'T00:00:00') : new Date();
    anchor.setHours(0, 0, 0, 0);

    if (costTimeRange === 'daily') {
      // Last 14 calendar days ending at anchor. Fourteen is what fits with a
      // readable day number under every bar; thirty gave a picket fence with
      // five labels on it.
      return Array.from({ length: 14 }, (_, i) => {
        const d = new Date(anchor);
        d.setDate(anchor.getDate() - (13 - i));
        const dateKey = d.toISOString().split('T')[0];
        return {
          date: dateKey,
          label: d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }),
          tick: String(d.getDate()),
          cost: dailyCostMap.get(dateKey) ?? 0,
        };
      });
    } else if (costTimeRange === 'weekly') {
      // Last 12 weeks (Sun–Sat) ending at anchor's week
      return Array.from({ length: 12 }, (_, i) => {
        const weekStart = new Date(anchor);
        weekStart.setDate(anchor.getDate() - anchor.getDay() - (11 - i) * 7);
        const weekKey = weekStart.toISOString().split('T')[0];
        let cost = 0;
        for (let d = 0; d < 7; d++) {
          const day = new Date(weekStart);
          day.setDate(weekStart.getDate() + d);
          const dk = day.toISOString().split('T')[0];
          cost += dailyCostMap.get(dk) ?? 0;
        }
        return {
          date: weekKey,
          label: weekStart.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }),
          tick: String(weekStart.getDate()),
          cost,
        };
      });
    } else {
      // Last 12 months ending at anchor's month
      return Array.from({ length: 12 }, (_, i) => {
        const d = new Date(anchor.getFullYear(), anchor.getMonth() - (11 - i), 1);
        const monthKey = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
        let cost = 0;
        dailyCostMap.forEach((dayCost, dateKey) => {
          if (dateKey.startsWith(monthKey)) cost += dayCost;
        });
        return {
          date: monthKey,
          label: d.toLocaleDateString('en-US', { month: 'short', year: '2-digit' }),
          tick: d.toLocaleDateString('en-US', { month: 'short' }).toLowerCase(),
          cost,
        };
      });
    }
  }, [dailyCostMap, costTimeRange, latestDataDate]);

  // Cost for the latest available day
  const todayCost = useMemo(() => {
    if (!latestDataDate) return 0;
    return dailyCostMap.get(latestDataDate) ?? 0;
  }, [dailyCostMap, latestDataDate]);

  if (loading && !data) {
    return (
      <div className="flex items-center justify-center h-[60vh]">
        <LoadingState loading rows={4} what="Still adding up what you spent…" detail="parsing session transcripts" />
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex items-center justify-center h-[60vh]">
        <div className="text-center text-danger">
          <AlertCircle className="w-8 h-8 mx-auto mb-4" />
          <p className="mb-2">Failed to load usage data</p>
          <p className="text-sm text-muted-foreground">{error}</p>
        </div>
      </div>
    );
  }

  const stats = data?.stats;
  const maxCost = Math.max(...costChartData.map(d => d.cost), 0.01);

  // Latest day: the reconstructed per-day map first, then Tars' own ledger of
  // extra usage, which is the only record for the days the transcripts miss.
  let latestDayCost = todayCost;
  let latestDayLabel = latestDataDate ?? 'no data';
  let latestDayIsExtra = false;
  if (latestDayCost === 0 && data?.tokenStats?.dailyCosts) {
    const days = Object.keys(data.tokenStats.dailyCosts).sort();
    if (days.length > 0) {
      const latest = days[days.length - 1];
      const dc = data.tokenStats.dailyCosts[latest];
      if (dc.extraCost > 0) {
        latestDayCost = dc.extraCost;
        latestDayLabel = latest;
        latestDayIsExtra = true;
      }
    }
  }

  // Token totals come from the model stats when there are any, and from Tars'
  // own counters when there are not.
  const ts = data?.tokenStats;
  const hasModelTokens = totalUsage.totalTokens > 0;
  const totalTok = hasModelTokens ? totalUsage.totalTokens : (ts ? ts.totalInputTokens + ts.totalOutputTokens : 0);
  const inTok = hasModelTokens ? totalUsage.totalInput : (ts?.totalInputTokens ?? 0);
  const outTok = hasModelTokens ? totalUsage.totalOutput : (ts?.totalOutputTokens ?? 0);
  const tokensAreTarsOnly = !hasModelTokens && !!ts && (ts.totalInputTokens + ts.totalOutputTokens) > 0;

  const extraCost = data?.tokenStats?.extraCostUsd ?? 0;

  const chartCaption =
    costTimeRange === 'daily' ? 'DAILY COST · 14 DAYS'
      : costTimeRange === 'weekly' ? 'WEEKLY COST · 12 WEEKS'
        : 'MONTHLY COST · 12 MONTHS';

  return (
    <div className="space-y-3">
      <PageHeader
        title="Usage"
        subtitle="What every provider has cost you, and where the tokens went."
      />

      {/* The four figures. Colour here is reserved for money and for being over budget. */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-2">
        <StatCard
          caption="TOTAL COST"
          value={`$${totalUsage.totalCost > 0 ? totalUsage.totalCost.toFixed(2) : '0.00'}`}
          sub={
            extraCost > 0
              ? `~$${extraCost.toFixed(2)} estimated extra usage`
              : totalUsage.totalCost > 0
                ? `since ${stats?.firstSessionDate ? new Date(stats.firstSessionDate).toLocaleDateString() : 'n/a'}`
                : 'included in subscription'
          }
          subClassName={extraCost > 0 ? 'text-danger' : 'text-muted-foreground'}
        />
        <StatCard
          caption="LATEST DAY"
          value={`$${latestDayCost.toFixed(2)}`}
          sub={`${latestDayLabel}${latestDayIsExtra ? ' · extra usage est.' : ''}`}
        />
        <StatCard
          caption="TOTAL TOKENS"
          value={`${(totalTok / 1000000).toFixed(2)}M`}
          sub={`${(inTok / 1000000).toFixed(2)}M in / ${(outTok / 1000000).toFixed(2)}M out${tokensAreTarsOnly ? ' · tars only' : ''}`}
        />
        <StatCard
          caption="CACHE SAVINGS"
          value={`${(totalUsage.totalCacheRead / 1000000).toFixed(2)}M`}
          sub="tokens served from cache"
        />
      </div>

      {/* Budget & limits — each provider gets the limit it actually has */}
      <BudgetAndLimits
        rateLimits={data?.rateLimits}
        providerSpend={ledger.map(l => ({ provider: l.provider, costUSD: l.costUSD }))}
      />

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-2">
        {/* Usage by Provider */}
        <Panel className="flex flex-col">
          <PanelCaption>BY PROVIDER</PanelCaption>
          {(() => {
            // Two sources, because no single one covers every CLI: Claude Code
            // writes transcripts we can reconstruct after the fact, and every
            // ACP turn reports its own tokens as it happens. Merged by provider.
            const rows = new Map<string, { sessions: number; in: number; out: number; cost: number; models: Set<string> }>();

            const add = (providerId: string, patch: { sessions?: number; in?: number; out?: number; cost?: number; model?: string }) => {
              const row = rows.get(providerId) ?? { sessions: 0, in: 0, out: 0, cost: 0, models: new Set<string>() };
              row.sessions += patch.sessions ?? 0;
              row.in += patch.in ?? 0;
              row.out += patch.out ?? 0;
              row.cost += patch.cost ?? 0;
              if (patch.model) row.models.add(patch.model);
              rows.set(providerId, row);
            };

            for (const model of modelCostBreakdown) {
              add(providerForModel(model.modelId), {
                in: model.inputTokens + model.cacheReadTokens + model.cacheWriteTokens,
                out: model.outputTokens,
                cost: model.cost,
                model: model.modelId,
              });
            }

            for (const entry of ledger) {
              add(entry.provider, {
                sessions: entry.turns,
                in: entry.inputTokens,
                out: entry.outputTokens,
                cost: entry.costUSD,
              });
            }

            const sorted = Array.from(rows.entries()).sort(([, a], [, b]) => b.cost - a.cost);

            if (sorted.length === 0) {
              return (
                <p className="mt-3 text-xs text-muted-foreground">
                  Nothing recorded yet. Claude usage is read from its transcripts, and every other CLI
                  is counted from the turns it reports back - delegate a task and it appears here.
                </p>
              );
            }

            const fmtTokens = (n: number) =>
              n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}M` : n >= 1_000 ? `${(n / 1_000).toFixed(1)}k` : String(n);

            return (
              <div className="mt-2 -mx-1">
                {sorted.map(([providerId, totals]) => {
                  const def = getProviderDef(providerId);
                  const label = def?.label ?? providerId;
                  const icon = def?.icon;
                  return (
                    <div
                      key={providerId}
                      className="flex items-center gap-3 h-8 px-1 hover:bg-secondary"
                    >
                      <div className="flex items-center gap-2 min-w-0 flex-1">
                        {icon && <ProviderIconRenderer icon={icon} className="w-3.5 h-3.5 shrink-0" />}
                        <span className="text-[12.5px] truncate">{label}</span>
                      </div>
                      <span className="hidden md:block text-[11px] font-mono text-muted-foreground truncate max-w-[160px] text-right">
                        {Array.from(totals.models).map(getModelDisplayName).join(', ') || '-'}
                      </span>
                      <span className="text-[11px] font-mono tabular-nums text-muted-foreground w-12 text-right">
                        {fmtTokens(totals.in)}
                      </span>
                      <span className="text-[11px] font-mono tabular-nums text-muted-foreground w-12 text-right">
                        {fmtTokens(totals.out)}
                      </span>
                      <span className="text-[11px] font-mono tabular-nums text-status-running w-16 text-right">
                        {totals.cost > 0 ? `$${totals.cost.toFixed(2)}` : '-'}
                      </span>
                    </div>
                  );
                })}
              </div>
            );
          })()}
        </Panel>

        {/* Cost over time */}
        <Panel className="h-[260px] flex flex-col">
          <div className="flex items-center justify-between gap-3">
            <PanelCaption>{chartCaption}</PanelCaption>
            <SegmentedControl
              options={COST_RANGES}
              value={costTimeRange}
              onChange={setCostTimeRange}
              ariaLabel="Cost range"
            />
          </div>

          <AnimatePresence mode="wait">
            <motion.div
              key={costTimeRange}
              initial={{ opacity: 0, y: 6 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -6 }}
              transition={{ duration: 0.2 }}
              className="flex flex-col flex-1 min-h-0 mt-3"
            >
              {costChartData.length === 0 ? (
                <div className="flex-1 flex items-center justify-center text-muted-foreground text-sm">
                  No cost data available
                </div>
              ) : (
                <>
                  <div className="flex items-stretch gap-1 flex-1 min-h-0">
                    {costChartData.map((item, i) => {
                      const height = maxCost > 0 ? (item.cost / maxCost) * 100 : 0;
                      // Only the latest bucket carries the accent; the rest are
                      // the neutral raised surface.
                      const isLatest = i === costChartData.length - 1;
                      return (
                        <div key={item.date} className="flex-1 min-w-0 flex flex-col items-center gap-1">
                          <div className="w-full flex flex-col justify-end flex-1 min-h-0">
                            <motion.div
                              initial={{ height: 0 }}
                              animate={{ height: `${Math.max(height, 2)}%` }}
                              transition={{ delay: 0.05 + i * 0.02, duration: 0.35 }}
                              className={isLatest ? 'w-full bg-primary' : 'w-full bg-bg-tertiary'}
                              title={`${item.label}: $${item.cost.toFixed(2)}`}
                            />
                          </div>
                          <span className="text-[9px] leading-none text-muted-foreground">{item.tick}</span>
                        </div>
                      );
                    })}
                  </div>
                  <div className="flex items-center justify-between mt-1.5 text-[10px] text-muted-foreground">
                    <span>{costChartData[0]?.label.toLowerCase()}</span>
                    <span>today</span>
                  </div>
                </>
              )}
            </motion.div>
          </AnimatePresence>
        </Panel>
      </div>
    </div>
  );
}
