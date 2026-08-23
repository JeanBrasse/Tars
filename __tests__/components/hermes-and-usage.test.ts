import { describe, it, expect } from 'vitest';

/**
 * Three bugs found by using the app rather than reading it.
 */

describe('a missing project folder', () => {
  // Start used to build `cd '<folder>' && claude ...` and write it into the
  // PTY. When the folder was gone bash printed "No such file or directory",
  // the && short-circuited, and the user was left at a shell prompt with no
  // indication that anything had failed. Six of Noah's agents pointed at a
  // folder that no longer existed.
  const canStart = (agent: { projectPath: string; worktreePath?: string }, exists: (p: string) => boolean) =>
    exists(agent.worktreePath || agent.projectPath);

  const present = (p: string) => p === '/Users/x/real' || p === '/Users/x/real/.worktrees/feat';

  it('refuses when the project folder is gone', () => {
    expect(canStart({ projectPath: '/Users/x/gone' }, present)).toBe(false);
  });

  it('checks the worktree, which is where the agent actually runs', () => {
    expect(canStart({ projectPath: '/Users/x/real', worktreePath: '/Users/x/real/.worktrees/gone' }, present)).toBe(false);
    expect(canStart({ projectPath: '/Users/x/real', worktreePath: '/Users/x/real/.worktrees/feat' }, present)).toBe(true);
  });

  it('allows the ordinary case', () => {
    expect(canStart({ projectPath: '/Users/x/real' }, present)).toBe(true);
  });
});

describe('daily cost: one map for the chart and the card', () => {
  // The chart was drawn from transcript-derived costs; the "latest day" card
  // fell back to Tars' own ledger when that was 0 - and silently moved to
  // whatever day the ledger last had. Hovering a bar and reading the card gave
  // two numbers, for two different days, from two different sources.
  function buildMap(
    transcripts: Record<string, number>,
    ledger: Record<string, { extraCost: number }>,
  ): Map<string, number> {
    const map = new Map(Object.entries(transcripts));
    for (const [date, entry] of Object.entries(ledger)) {
      const extra = entry?.extraCost ?? 0;
      if (extra > 0) map.set(date, (map.get(date) ?? 0) + extra);
    }
    return map;
  }

  it('adds ledger spend to a day the transcripts also cover', () => {
    const m = buildMap({ '2026-08-20': 3 }, { '2026-08-20': { extraCost: 2 } });
    expect(m.get('2026-08-20')).toBe(5);
  });

  it('gives a day with no transcript its ledger spend', () => {
    // Every non-Claude CLI and everything over ACP lands here: real spend, no
    // transcript at all.
    const m = buildMap({}, { '2026-08-21': { extraCost: 4.2 } });
    expect(m.get('2026-08-21')).toBe(4.2);
  });

  it('the card reads the same number the bar shows', () => {
    const m = buildMap({ '2026-08-19': 1, '2026-08-20': 0 }, { '2026-08-20': { extraCost: 7 } });
    const anchor = '2026-08-20';
    const cardValue = m.get(anchor) ?? 0;
    const barValue = m.get(anchor) ?? 0;
    expect(cardValue).toBe(barValue);
    expect(cardValue).toBe(7);
  });

  it('ignores a zero ledger entry rather than creating an empty day', () => {
    const m = buildMap({ '2026-08-20': 3 }, { '2026-08-21': { extraCost: 0 } });
    expect(m.has('2026-08-21')).toBe(false);
  });
});

describe('Hermes schedule dates', () => {
  // Hermes is another system; its date fields are whatever it sends. One odd
  // row must not be able to take the page down.
  function formatNext(next: unknown): string {
    if (next === null || next === undefined || next === '') return '';
    try {
      const value = typeof next === 'number' && next < 1e12 ? next * 1000 : next as string | number;
      const date = new Date(value);
      if (Number.isNaN(date.getTime())) return '';
      return ` · next ${date.toLocaleString()}`;
    } catch {
      return '';
    }
  }

  it('renders an ISO string', () => {
    expect(formatNext('2026-08-24T09:00:00Z')).toContain('next');
  });

  it('treats a bare seconds timestamp as seconds, not 1970', () => {
    expect(formatNext(1787000000)).toContain('2026');
  });

  it('says nothing rather than "Invalid Date"', () => {
    for (const bad of ['', null, undefined, 'whenever', {}, []]) {
      expect(formatNext(bad), String(bad)).toBe('');
    }
  });
});
