import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { readTaskCosts } from '../../../electron/services/task-cost';
import { clearTranscriptUsageCache } from '../../../electron/services/transcript-usage';
import { resetCatalogCache } from '../../../electron/services/model-catalog';
import { DATA_DIR } from '../../../electron/constants';
import type { TaskRecord } from '../../../electron/services/task-ledger';

/**
 * What a task cost when the ledger holds each turn's usage (mods step 4): the state mod reports Claude Code's
 * turn.complete, so a task whose transcript is gone can still be priced.
 *
 * Measured on Claude Code 2.1.289 against a fake Messages API (banc-usage-tour): turn.complete and turn.step give a
 * turn's input, output, cache read and cache creation tokens and its model, summed over the turn's requests, but not
 * how the cache writes split between the 1-hour and the 5-minute cache, nor the web searches, which the transcript
 * keeps. Every cache write of the last 30 transcripts on this machine was a 1-hour one, which costs more. So where a
 * transcript is there, it stays the source.
 *
 * How it fails, written before the code:
 * 20. A task whose transcript is gone reads "not counted" although its turns were recorded; or it is priced otherwise
 *     than a transcript line without the split (cache writes at the 5-minute rate, transcript-usage.ts); or nothing
 *     says which source priced it.
 * 21. Where both exist, the turns change the figures: added on top of the transcript, or taken in its place.
 */

const T0 = Date.UTC(2026, 9, 6, 9, 0, 0);
const MODEL = 'claude-opus-5';
let home: string;

function task(over: Partial<TaskRecord>): TaskRecord {
  return {
    id: 'task-a', agentId: 'worker-1', projectPath: '/work/tars', worktreePath: null, provider: 'claude', model: null,
    accountId: null, source: 'tars', requesterAgentId: null, parentTaskId: null, text: 'build it',
    startedAt: T0, endedAt: T0 + 60_000, lastAt: T0 + 60_000, outcome: 'completed', turns: 1, sessionIds: ['sess-1'],
    ...over,
  };
}

function transcript(name: string, lines: unknown[]): void {
  const full = path.join(home, '.claude', 'projects', '-work-tars');
  fs.mkdirSync(full, { recursive: true });
  fs.writeFileSync(path.join(full, name), lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
}

/** Opus at $1 a million tokens in, $2 out, $0.1 cache read, $1.25 a 5-minute cache write. */
beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'tars-task-cost-turns-'));
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(path.join(DATA_DIR, 'model-catalog.json'), JSON.stringify({
    anthropic: { models: { [MODEL]: { id: MODEL, name: 'Claude Opus 5', cost: { input: 1, output: 2, cache_read: 0.1, cache_write: 1.25 } } } },
  }));
  resetCatalogCache();
  clearTranscriptUsageCache();
});

afterEach(() => {
  fs.rmSync(home, { recursive: true, force: true });
});

const turns = { [MODEL]: { input: 1_000_000, output: 500_000, cacheRead: 2_000_000, cacheWrite: 400_000 } };

describe('a task priced from its turns', () => {
  it('20. with no transcript, it is priced from the turns, cache writes at the 5-minute rate, and says so', async () => {
    const costs = await readTaskCosts([task({ usageByModel: turns, usageTurns: 2 })], { homeDir: home });
    const cost = costs.get('task-a')!;
    // 1 + 1 + 0.2 + 0.5
    expect(cost.costUSD).toBeCloseTo(2.7, 9);
    expect(cost.tokens).toEqual({ input: 1_000_000, output: 500_000, cacheRead: 2_000_000, cacheWrite: 400_000 });
    expect(cost.byModel[MODEL]).toBeCloseTo(2.7, 9);
    expect(cost.from).toBe('turns');
  });

  it('20. with neither, it is still not counted', async () => {
    const cost = (await readTaskCosts([task({})], { homeDir: home })).get('task-a')!;
    expect(cost).toMatchObject({ costUSD: null, tokens: null, from: null });
  });

  it('21. with both, the transcript stays the source: the same figures as without the turns', async () => {
    transcript('sess-1.jsonl', [{
      type: 'assistant', requestId: 'req_1', timestamp: new Date(T0 + 1_000).toISOString(),
      message: { id: 'm1', model: MODEL, usage: { input_tokens: 3_000_000, output_tokens: 0, cache_creation_input_tokens: 1_000_000, cache_creation: { ephemeral_1h_input_tokens: 1_000_000, ephemeral_5m_input_tokens: 0 } } },
    }]);
    const without = (await readTaskCosts([task({})], { homeDir: home })).get('task-a')!;
    clearTranscriptUsageCache();
    const withTurns = (await readTaskCosts([task({ usageByModel: turns, usageTurns: 2 })], { homeDir: home })).get('task-a')!;
    expect(withTurns.costUSD).toBe(without.costUSD);
    expect(withTurns.tokens).toEqual(without.tokens);
    expect(withTurns.byModel).toEqual(without.byModel);
    expect(withTurns.from).toBe('transcript');
  });
});
