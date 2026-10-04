/**
 * Each Claude account's 5 h and weekly windows read from Claude Code itself,
 * with `get_usage`, instead of the status line's files
 * (electron/services/claude-accounts/usage-probe.ts; PLAN-1.9.3.md, taken
 * from T3 Code).
 *
 * Measured on 2026-10-04 with claude 2.1.289 (usage-sdk-study/ in the review
 * folder): `claude -p --input-format stream-json --output-format stream-json`
 * answers a `get_usage` control request with the plan's windows, as
 * percentages 0 to 100 and ISO reset times, plus per-model weeklies
 * (`model_scoped`); a folder with no login answers `rate_limits_available:
 * false`; with CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC set the windows are
 * null. Claude Code reads its own credential: Tars never sees one.
 *
 * How it fails, written before the code (2026-10-04):
 * 1. A percentage is read as a fraction, or the other way round.
 * 2. A reset time is read in the wrong unit: an ISO string must become epoch
 *    seconds, and one that does not parse is no window.
 * 3. An answer that is no reading (an error, `rate_limits_available: false`,
 *    null windows) reads as 0 %: an account nobody measured looks empty.
 * 4. A value that is not a number, out of 0..100, or a model name with
 *    control characters or no end, reaches the chooser or the page.
 * 5. The per-model weeklies are lost, or an absent list reads as an empty one.
 * 6. A CLI that never answers keeps the probe, and what it started, running;
 *    one that exits without answering is waited for.
 * 7. The probe runs with the traffic switch (no windows), with another
 *    account's folder, or with a folder set for account 1.
 * 8. A probe starts during the quit.
 * 9. Merged with the status line: an older probe hides a newer status line,
 *    or a newer probe loses to an older file.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { parseUsageAnswer, probeUsage, usageProbeEnv, recordProbe, resetProbes } from '../../../electron/services/claude-accounts/usage-probe';
import { readAccountUsage, countersDir } from '../../../electron/services/claude-accounts/counters';

const NOW = Date.UTC(2026, 9, 4, 19, 37, 0);
const S = (ms: number) => Math.floor(ms / 1000);
const iso = (ms: number) => new Date(ms).toISOString();

/** The `response` of a control_response to get_usage, as claude 2.1.289 sent it (trimmed). */
function answer(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    subscription_type: 'max',
    rate_limits_available: true,
    rate_limits: {
      five_hour: { utilization: 32, resets_at: iso(NOW + 3 * 3600_000), limit_dollars: null },
      seven_day: { utilization: 9, resets_at: iso(NOW + 6 * 86400_000) },
      seven_day_opus: null,
      model_scoped: [{ display_name: 'Fable', utilization: 0, resets_at: iso(NOW + 6 * 86400_000) }],
    },
    ...over,
  };
}

describe('reading an answer', () => {
  it('1, 2, 5. keeps percentages as percentages, reset times as epoch seconds, and the per-model weeklies', () => {
    expect(parseUsageAnswer(answer())).toEqual({
      available: true,
      fiveHour: { usedPercentage: 32, resetsAt: S(NOW + 3 * 3600_000) },
      sevenDay: { usedPercentage: 9, resetsAt: S(NOW + 6 * 86400_000) },
      models: [{ name: 'Fable', usedPercentage: 0, resetsAt: S(NOW + 6 * 86400_000) }],
    });
  });

  it('2. a reset time that does not parse is no window', () => {
    const a = answer();
    (a.rate_limits as Record<string, unknown>).five_hour = { utilization: 32, resets_at: 'tomorrow' };
    expect(parseUsageAnswer(a).fiveHour).toBeNull();
  });

  it('3. no reading is no reading: not available, an error, or nothing at all', () => {
    const none = { available: false, fiveHour: null, sevenDay: null, models: [] };
    expect(parseUsageAnswer(answer({ rate_limits_available: false, rate_limits: null }))).toEqual(none);
    // Windows sent beside "not available" (an answer served from old data) are no reading either.
    expect(parseUsageAnswer(answer({ rate_limits_available: false }))).toEqual(none);
    expect(parseUsageAnswer(answer({ rate_limits: null }))).toEqual(none);
    expect(parseUsageAnswer(null)).toEqual(none);
    expect(parseUsageAnswer('x')).toEqual(none);
  });

  it('4. a value that is not a percentage is no window, and a model name is one short line', () => {
    const a = answer();
    const limits = a.rate_limits as Record<string, unknown>;
    limits.five_hour = { utilization: '32', resets_at: iso(NOW + 1000) };
    limits.seven_day = { utilization: 140, resets_at: iso(NOW + 1000) };
    limits.model_scoped = [
      { display_name: 'Fa\u001b[31mble\nnext line', utilization: 5, resets_at: iso(NOW + 1000) },
      { display_name: 'x'.repeat(500), utilization: 1, resets_at: iso(NOW + 1000) },
      { display_name: 'bad', utilization: Number.NaN, resets_at: iso(NOW + 1000) },
      'not an object',
    ];
    const read = parseUsageAnswer(a);
    expect(read.fiveHour).toBeNull();
    expect(read.sevenDay).toBeNull();
    expect(read.models).toHaveLength(2);
    expect(read.models[0].name).toBe('Fa[31mble next line');
    expect(read.models[1].name.length).toBeLessThanOrEqual(40);
  });

  it('5. no list is no list, and an empty one is empty', () => {
    const a = answer();
    delete (a.rate_limits as Record<string, unknown>).model_scoped;
    expect(parseUsageAnswer(a).models).toEqual([]);
  });
});

describe('the environment of a probe', () => {
  it('7. drops the traffic switch and names the account folder, none for account 1', () => {
    const base = { PATH: '/usr/bin', CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1', CLAUDE_CONFIG_DIR: '/elsewhere', TARS_CLAUDE_ACCOUNT: 'acct-000000' };
    const second = usageProbeEnv('/Users/x/.claude-accounts/acct-1a2b3c', base);
    expect(second.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC).toBeUndefined();
    expect(second.CLAUDE_CONFIG_DIR).toBe('/Users/x/.claude-accounts/acct-1a2b3c');
    expect(second.TARS_CLAUDE_ACCOUNT).toBeUndefined();
    const first = usageProbeEnv(null, base);
    expect(first.CLAUDE_CONFIG_DIR).toBeUndefined();
    expect(first.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC).toBeUndefined();
  });
});

describe('a probe of the real protocol, against a stand-in claude', () => {
  let dir: string;
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tars-usage-probe-')); });
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

  /** A claude that reads one control request on stdin and does what `script` says. */
  function standIn(script: string): string {
    const bin = path.join(dir, 'claude');
    fs.writeFileSync(bin, [
      `#!${process.execPath}`,
      "const fs = require('fs');",
      `fs.writeFileSync(__filename + '.argv', JSON.stringify({ argv: process.argv.slice(2), config: process.env.CLAUDE_CONFIG_DIR ?? null, traffic: process.env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC ?? null }));`,
      "let buf = '';",
      "process.stdin.on('data', d => { buf += d; const nl = buf.indexOf('\\n'); if (nl < 0) return; const req = JSON.parse(buf.slice(0, nl)); buf = buf.slice(nl + 1); onRequest(req); });",
      script,
      '',
    ].join('\n'), { mode: 0o755 });
    return bin;
  }

  it('asks get_usage over stream-json, skipping the transcript scan, and reads the answer', async () => {
    const bin = standIn(`function onRequest(req) {
      fs.writeFileSync(__filename + '.request', JSON.stringify(req));
      process.stdout.write(JSON.stringify({ type: 'system', subtype: 'init' }) + '\\n');
      process.stdout.write(JSON.stringify({ type: 'control_response', response: { subtype: 'success', request_id: req.request_id, response: ${JSON.stringify(answer())} } }) + '\\n');
    }`);
    const read = await probeUsage(bin, usageProbeEnv('/acct/dir', { PATH: process.env.PATH, CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1' }));
    expect(read.fiveHour).toEqual({ usedPercentage: 32, resetsAt: S(NOW + 3 * 3600_000) });
    const request = JSON.parse(fs.readFileSync(`${bin}.request`, 'utf8'));
    expect(request).toMatchObject({ type: 'control_request', request: { subtype: 'get_usage', skip_behaviors: true } });
    const seen = JSON.parse(fs.readFileSync(`${bin}.argv`, 'utf8'));
    expect(seen.argv).toEqual(expect.arrayContaining(['-p', '--input-format', 'stream-json', '--output-format', 'stream-json']));
    expect(seen).toMatchObject({ config: '/acct/dir', traffic: null });
  });

  it('3. an error answer is no reading', async () => {
    const bin = standIn(`function onRequest(req) {
      process.stdout.write(JSON.stringify({ type: 'control_response', response: { subtype: 'error', request_id: req.request_id, error: 'nope' } }) + '\\n');
    }`);
    await expect(probeUsage(bin, process.env)).rejects.toThrow(/nope/);
  });

  it('6. a CLI that never answers is ended at the timeout, with what it started', async () => {
    const bin = standIn(`function onRequest() {
      require('child_process').spawn(process.execPath, ['-e', 'setTimeout(() => require("fs").writeFileSync(process.argv[1], ""), 5000)', __filename + '.child'], { stdio: 'ignore' });
      fs.writeFileSync(__filename + '.started', '');
    }`);
    const began = Date.now();
    // The child writes 5 s after it starts, so only past the probe's 3 s timeout.
    await expect(probeUsage(bin, process.env, 3000)).rejects.toThrow(/did not answer/);
    expect(Date.now() - began).toBeLessThan(6000);
    await new Promise(r => setTimeout(r, 4000));
    expect(fs.existsSync(`${bin}.started`)).toBe(true);
    expect(fs.existsSync(`${bin}.child`), 'what the probe started outlived it').toBe(false);
  }, 20_000);

  it('6. a CLI that exits without answering is not waited for', async () => {
    const bin = standIn('function onRequest() { process.exit(3); }');
    const began = Date.now();
    await expect(probeUsage(bin, process.env, 15_000)).rejects.toThrow(/exited/);
    expect(Date.now() - began).toBeLessThan(5000);
  });

  it('8. starts nothing during the quit', async () => {
    vi.resetModules();
    const quit = await import('../../../electron/core/quit-state');
    const probe = await import('../../../electron/services/claude-accounts/usage-probe');
    const bin = standIn("function onRequest() {}\nfs.writeFileSync(__filename + '.ran', '');");
    quit.beginQuit();
    await expect(probe.probeUsage(bin, process.env)).rejects.toThrow(/quitting/);
    await new Promise(r => setTimeout(r, 300));
    expect(fs.existsSync(`${bin}.ran`)).toBe(false);
  });
});

describe('merged with the status line', () => {
  function writeStatusLine(name: string, updatedAtMs: number, five: number): void {
    fs.mkdirSync(countersDir(), { recursive: true });
    fs.writeFileSync(path.join(countersDir(), name), JSON.stringify({
      updatedAt: S(updatedAtMs),
      rate_limits: { five_hour: { used_percentage: five, resets_at: S(NOW + 3600_000) }, seven_day: { used_percentage: 1, resets_at: S(NOW + 86400_000) } },
    }));
  }
  beforeEach(() => {
    resetProbes();
    if (fs.existsSync(countersDir())) fs.rmSync(countersDir(), { recursive: true });
  });

  it('9. a probe newer than the status line wins, with its per-model weeklies', () => {
    writeStatusLine('default.json', NOW - 60_000, 31);
    recordProbe('default', parseUsageAnswer(answer()), NOW);
    expect(readAccountUsage().default).toEqual({
      fiveHour: { usedPercentage: 32, resetsAt: S(NOW + 3 * 3600_000) },
      sevenDay: { usedPercentage: 9, resetsAt: S(NOW + 6 * 86400_000) },
      models: [{ name: 'Fable', usedPercentage: 0, resetsAt: S(NOW + 6 * 86400_000) }],
      updatedAt: NOW,
    });
  });

  it('9. a status line newer than the probe wins, and a probe with no reading never hides one', () => {
    writeStatusLine('default.json', NOW + 60_000, 40);
    recordProbe('default', parseUsageAnswer(answer()), NOW);
    expect(readAccountUsage().default.fiveHour?.usedPercentage).toBe(40);

    writeStatusLine('acct-1a2b3c.json', NOW - 60_000, 12);
    recordProbe('acct-1a2b3c', parseUsageAnswer(null), NOW);
    expect(readAccountUsage()['acct-1a2b3c'].fiveHour?.usedPercentage).toBe(12);
  });

  it('9. an account only a probe has read is read', () => {
    recordProbe('acct-1a2b3c', parseUsageAnswer(answer()), NOW);
    expect(readAccountUsage()['acct-1a2b3c']).toMatchObject({ fiveHour: { usedPercentage: 32 }, updatedAt: NOW });
  });
});
