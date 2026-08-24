import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { computeTranscriptUsage, clearTranscriptUsageCache } from '../../../electron/services/transcript-usage';

let home: string;

function writeTranscript(name: string, lines: unknown[]) {
  const dir = path.join(home, '.claude', 'projects', 'demo');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, name), lines.map(l => JSON.stringify(l)).join('\n'));
}

function assistant(id: string, requestId: string, over: Record<string, unknown> = {}) {
  return {
    type: 'assistant',
    requestId,
    timestamp: '2026-08-20T12:00:00.000Z',
    message: {
      id,
      model: 'claude-opus-5',
      usage: {
        input_tokens: 1000,
        output_tokens: 500,
        cache_read_input_tokens: 2000,
        cache_creation_input_tokens: 4000,
        cache_creation: { ephemeral_1h_input_tokens: 4000, ephemeral_5m_input_tokens: 0 },
        ...over,
      },
    },
  };
}

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'tars-usage-'));
  clearTranscriptUsageCache();
});

afterEach(() => {
  fs.rmSync(home, { recursive: true, force: true });
  clearTranscriptUsageCache();
});

describe('computeTranscriptUsage', () => {
  it('sums tokens per model from the transcripts', () => {
    writeTranscript('a.jsonl', [assistant('msg_1', 'req_1'), assistant('msg_2', 'req_2')]);

    const { modelUsage } = computeTranscriptUsage(home);

    expect(modelUsage['claude-opus-5'].inputTokens).toBe(2000);
    expect(modelUsage['claude-opus-5'].outputTokens).toBe(1000);
    expect(modelUsage['claude-opus-5'].cacheReadInputTokens).toBe(4000);
  });

  it('counts a resumed message once, not once per transcript', () => {
    writeTranscript('a.jsonl', [assistant('msg_1', 'req_1')]);
    writeTranscript('b-resumed.jsonl', [assistant('msg_1', 'req_1'), assistant('msg_9', 'req_9')]);

    const { modelUsage } = computeTranscriptUsage(home);

    expect(modelUsage['claude-opus-5'].inputTokens).toBe(2000);
  });

  it('prices 1h cache writes above 5m ones', () => {
    writeTranscript('hour.jsonl', [assistant('msg_1', 'req_1')]);
    const hourly = computeTranscriptUsage(home).modelUsage['claude-opus-5'].costUSD;

    clearTranscriptUsageCache();
    fs.rmSync(path.join(home, '.claude', 'projects', 'demo'), { recursive: true });
    writeTranscript('five.jsonl', [
      assistant('msg_1', 'req_1', {
        cache_creation: { ephemeral_1h_input_tokens: 0, ephemeral_5m_input_tokens: 4000 },
      }),
    ]);
    const fiveMin = computeTranscriptUsage(home).modelUsage['claude-opus-5'].costUSD;

    expect(hourly).toBeGreaterThan(fiveMin);
    // Opus 5: 4000 tokens at $10/MTok vs $6.25/MTok
    expect(hourly - fiveMin).toBeCloseTo((4000 / 1e6) * (10 - 6.25), 6);
  });

  it('ignores synthetic messages and rolls tokens up per day', () => {
    writeTranscript('a.jsonl', [
      assistant('msg_1', 'req_1'),
      { ...assistant('msg_2', 'req_2'), message: { id: 'msg_2', model: '<synthetic>', usage: { input_tokens: 99 } } },
    ]);

    const usage = computeTranscriptUsage(home);

    expect(Object.keys(usage.modelUsage)).toEqual(['claude-opus-5']);
    expect(usage.dailyModelTokens).toHaveLength(1);
    expect(usage.dailyModelTokens[0].date).toBe('2026-08-20');
    expect(usage.dailyModelTokens[0].tokensByModel).toEqual({ 'claude-opus-5': 1500 });
    expect(usage.lastComputedDate).toBe('2026-08-20');
  });

  it('prices each day from that day\'s own tokens, cache reads included', () => {
    // Two days with identical input+output but wildly different cache reads.
    // The page used to rebuild a day from input+output times an all-time
    // blended rate, which made these two days cost exactly the same.
    const cheap = {
      ...assistant('msg_cheap', 'req_cheap', {
        cache_read_input_tokens: 0,
        cache_creation_input_tokens: 0,
        cache_creation: { ephemeral_1h_input_tokens: 0, ephemeral_5m_input_tokens: 0 },
      }),
      timestamp: '2026-08-20T12:00:00.000Z',
    };
    const dear = {
      ...assistant('msg_dear', 'req_dear', {
        cache_read_input_tokens: 100_000_000,
        cache_creation_input_tokens: 0,
        cache_creation: { ephemeral_1h_input_tokens: 0, ephemeral_5m_input_tokens: 0 },
      }),
      timestamp: '2026-08-21T12:00:00.000Z',
    };
    writeTranscript('a.jsonl', [cheap, dear]);

    const days = computeTranscriptUsage(home).dailyModelTokens;
    const byDate = Object.fromEntries(days.map(d => [d.date, d]));

    // Same tokensByModel on both days - that is exactly why the old estimate
    // could not tell them apart.
    expect(byDate['2026-08-20'].tokensByModel).toEqual(byDate['2026-08-21'].tokensByModel);

    // Opus 5: input $5, output $25, cache read $0.50 per MTok.
    expect(byDate['2026-08-20'].costUSD).toBeCloseTo(
      (1000 / 1e6) * 5 + (500 / 1e6) * 25, 6,
    );
    expect(byDate['2026-08-21'].costUSD).toBeCloseTo(
      (1000 / 1e6) * 5 + (500 / 1e6) * 25 + (100_000_000 / 1e6) * 0.5, 6,
    );

    // And the days still add up to the all-time total.
    const total = days.reduce((sum, d) => sum + d.costUSD, 0);
    expect(total).toBeCloseTo(computeTranscriptUsage(home).modelUsage['claude-opus-5'].costUSD, 6);
  });

  it('tops up a message written as several lines instead of keeping the first', () => {
    // Claude Code writes one line per content block; the earlier lines carry a
    // partial output_tokens and the last line carries the real one.
    writeTranscript('a.jsonl', [
      assistant('msg_1', 'req_1', { output_tokens: 1 }),
      assistant('msg_1', 'req_1', { output_tokens: 1 }),
      assistant('msg_1', 'req_1', { output_tokens: 500 }),
    ]);

    const usage = computeTranscriptUsage(home);

    // 500, not 1 (first-wins) and not 502 (no dedupe at all).
    expect(usage.modelUsage['claude-opus-5'].outputTokens).toBe(500);
    expect(usage.modelUsage['claude-opus-5'].inputTokens).toBe(1000);
    expect(usage.modelUsage['claude-opus-5'].cacheReadInputTokens).toBe(2000);
    expect(usage.dailyModelTokens[0].tokensByModel['claude-opus-5']).toBe(1500);
  });
});

describe('the per-file cache', () => {
  /**
   * Every cache miss used to re-read and re-parse every transcript under
   * ~/.claude/projects, measured at 414ms against 116MB on the author's
   * machine, synchronously on the main process, once a minute for as long as a
   * Usage, Agents or Projects tab was open. A file is keyed on (mtimeMs, size)
   * now, so the recurring cost is a stat per file: 7ms on the same data, with
   * identical totals.
   *
   * These tests pin the two things that could go wrong: a changed file must be
   * re-read, and a stale file must not keep contributing after it is deleted.
   */

  /** Force the 60s result memo to expire without clearing the per-file map. */
  function expireResultMemo() {
    const real = Date.now;
    const at = real();
    Date.now = () => at + 61_000;
    try {
      return computeTranscriptUsage(home);
    } finally {
      Date.now = real;
    }
  }

  it('re-reads a transcript that has grown', () => {
    writeTranscript('a.jsonl', [assistant('msg_1', 'req_1')]);
    expect(computeTranscriptUsage(home).modelUsage['claude-opus-5'].inputTokens).toBe(1000);

    // A live session appends. Size changes, so the cache key changes.
    writeTranscript('a.jsonl', [assistant('msg_1', 'req_1'), assistant('msg_2', 'req_2')]);
    expect(expireResultMemo().modelUsage['claude-opus-5'].inputTokens).toBe(2000);
  });

  it('stops counting a transcript that has been deleted', () => {
    writeTranscript('a.jsonl', [assistant('msg_1', 'req_1')]);
    writeTranscript('b.jsonl', [assistant('msg_2', 'req_2')]);
    expect(computeTranscriptUsage(home).modelUsage['claude-opus-5'].inputTokens).toBe(2000);

    fs.unlinkSync(path.join(home, '.claude', 'projects', 'demo', 'b.jsonl'));
    expect(expireResultMemo().modelUsage['claude-opus-5'].inputTokens).toBe(1000);
  });

  it('still deduplicates across files when the second read is cached', () => {
    // A resumed session replays its earlier messages into a new transcript, so
    // the same message id lands in two files. Caching per file must not turn
    // that back into double counting on the second pass.
    writeTranscript('a.jsonl', [assistant('msg_1', 'req_1')]);
    writeTranscript('b.jsonl', [assistant('msg_1', 'req_1'), assistant('msg_9', 'req_9')]);

    const first = computeTranscriptUsage(home).modelUsage['claude-opus-5'].inputTokens;
    const second = expireResultMemo().modelUsage['claude-opus-5'].inputTokens;

    expect(first).toBe(2000);
    expect(second).toBe(2000);
  });

  it('gives the same answer warm as it does cold', () => {
    writeTranscript('a.jsonl', [assistant('msg_1', 'req_1'), assistant('msg_2', 'req_2')]);
    writeTranscript('b.jsonl', [assistant('msg_3', 'req_3')]);

    const cold = computeTranscriptUsage(home);
    const warm = expireResultMemo();
    clearTranscriptUsageCache();
    const coldAgain = computeTranscriptUsage(home);

    expect(warm).toEqual(cold);
    expect(coldAgain).toEqual(cold);
  });

  /* ── Messages per day ─────────────────────────────────────────────────── */

  it('counts a reply once even though it is written as several lines', () => {
    // One API response, three content blocks, same message id: the token
    // totals top up across them, but it is one message. Counting lines here
    // roughly doubles every day on the chart.
    writeTranscript('a.jsonl', [
      assistant('msg_1', 'req_1', { output_tokens: 100 }),
      assistant('msg_1', 'req_1', { output_tokens: 300 }),
      assistant('msg_1', 'req_1', { output_tokens: 500 }),
    ]);

    const { dailyModelTokens } = computeTranscriptUsage(home);

    expect(dailyModelTokens).toHaveLength(1);
    expect(dailyModelTokens[0].messagesByModel['claude-opus-5']).toBe(1);
  });

  it('counts distinct replies separately', () => {
    writeTranscript('a.jsonl', [assistant('msg_1', 'req_1'), assistant('msg_2', 'req_2')]);

    const { dailyModelTokens } = computeTranscriptUsage(home);

    expect(dailyModelTokens[0].messagesByModel['claude-opus-5']).toBe(2);
  });

  it('keeps the count per model, so a day of two models splits', () => {
    const other = { ...assistant('msg_9', 'req_9') };
    other.message = { ...other.message, model: 'claude-sonnet-5' };
    writeTranscript('a.jsonl', [assistant('msg_1', 'req_1'), other]);

    const { dailyModelTokens } = computeTranscriptUsage(home);

    expect(dailyModelTokens[0].messagesByModel).toEqual({
      'claude-opus-5': 1,
      'claude-sonnet-5': 1,
    });
  });

  it('does not count a replayed message twice across transcripts', () => {
    // A resumed session replays its earlier messages into a new file under the
    // same ids, which is why the dedup is global rather than per file.
    writeTranscript('a.jsonl', [assistant('msg_1', 'req_1')]);
    writeTranscript('b.jsonl', [assistant('msg_1', 'req_1')]);

    const { dailyModelTokens } = computeTranscriptUsage(home);

    expect(dailyModelTokens[0].messagesByModel['claude-opus-5']).toBe(1);
  });

  it('still reports the day cost alongside the count', () => {
    writeTranscript('a.jsonl', [assistant('msg_1', 'req_1')]);

    const { dailyModelTokens } = computeTranscriptUsage(home);

    // costUSD was briefly dropped from the interface while the count was
    // added, and nothing failed: the literal is built inside a .map(), so
    // excess-property checking never sees it.
    expect(typeof dailyModelTokens[0].costUSD).toBe('number');
    expect(dailyModelTokens[0].costUSD).toBeGreaterThan(0);
  });
});
