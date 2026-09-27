import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

/**
 * Reports to Noah's Telegram as things happen (step 4 of PLAN-RELAIS-SENTRY.md,
 * the design's part A2; Noah: "en fonction de ce qui se passe").
 *
 * An event (an agent gone to error, a PR merged, changes requested on a PR)
 * waits up to 2 minutes for others, and they leave together in one message.
 * At most 40 messages a day; past that, events are counted and the next day's
 * first message opens with one line saying how many were held. No quiet hours.
 * Nothing is sent, and nothing kept for later, while the Telegram bot is off.
 *
 * How it fails, written before the code (2026-09-28):
 * 1. With the bot off, an event is sent, or kept and sent once it is on: a
 *    flood of stale news.
 * 2. Every event is its own message, or one waits past its 2 minutes.
 * 3. The same event is sent twice: an agent still in error, a PR seen merged
 *    at every poll.
 * 4. More than 40 messages a day; or the events past the limit vanish
 *    without a word.
 * 5. An agent's name, a PR title or an error text goes out as markup, or
 *    with a secret in it.
 * 6. A restart forgets the day's count, and the limit is only per run.
 * 7. (the Audit's gate of #234) The error text is cut before its secrets are
 *    masked: a key that starts near the cut leaves its first characters in
 *    clear.
 */

type Reports = typeof import('../../../electron/services/event-reports');
let r: Reports;
const sent: string[] = [];
let on = true;
const channel = { async send(html: string) { sent.push(html); return 1; } };

const T0 = new Date(2026, 8, 28, 9, 0, 0).getTime();
const error = (agentId: string, reason = 'The API refused the request') =>
  ({ kind: 'agent-error' as const, agentId, agentName: `Agent ${agentId}`, project: 'tars', reason });
const merged = (n: number, title = `PR ${n}`) =>
  ({ kind: 'pr-merged' as const, repo: 'JeanBrasse/Tars', number: n, title, url: `https://github.com/JeanBrasse/Tars/pull/${n}` });

async function load() {
  vi.resetModules();
  r = await import('../../../electron/services/event-reports');
  r.setReportChannel(on ? channel : null);
}

beforeEach(async () => {
  vi.useFakeTimers();
  vi.setSystemTime(T0);
  sent.length = 0;
  on = true;
  fs.rmSync(path.join(os.homedir(), '.tars-private'), { recursive: true, force: true });
  await load();
});
afterEach(() => vi.useRealTimers());

const minutes = async (n: number) => { await vi.advanceTimersByTimeAsync(n * 60_000); };

describe('an event report', () => {
  it('1. is neither sent nor kept while the Telegram bot is off', async () => {
    r.setReportChannel(null);
    r.reportEvent(error('a1'));
    // Back on before the 2 minutes are up: what came while it was off still does not go.
    await minutes(1);
    r.setReportChannel(channel);
    await minutes(3);
    expect(sent).toEqual([]);
  });

  it('2. waits 2 minutes for others, and they leave together', async () => {
    r.reportEvent(error('a1'));
    await minutes(1);
    r.reportEvent(merged(231));
    expect(sent).toEqual([]);
    await minutes(1.01);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toContain('Agent a1');
    expect(sent[0]).toContain('#231');
    await minutes(5);
    expect(sent).toHaveLength(1);
  });

  it('3. says an event once, and again only once it happened again', async () => {
    r.reportEvent(error('a1'));
    r.reportEvent(error('a1'));
    r.reportEvent(merged(231));
    r.reportEvent(merged(231));
    await minutes(2.01);
    expect(sent).toHaveLength(1);
    expect(sent[0].match(/Agent a1/g)).toHaveLength(1);
    expect(sent[0].match(/#231/g)).toHaveLength(1);
    // Still in error, said again in a later window: not news.
    r.reportEvent(error('a1'));
    await minutes(2.01);
    expect(sent).toHaveLength(1);
    // Out of error, then in it again: a new event.
    r.agentRecovered('a1');
    r.reportEvent(error('a1'));
    r.reportEvent(merged(231));
    await minutes(2.01);
    expect(sent).toHaveLength(2);
    expect(sent[1]).toContain('Agent a1');
    expect(sent[1]).not.toContain('#231');
  });

  it('4, 6. sends at most 40 messages a day, across a restart, and the next day says how many were held', async () => {
    for (let i = 0; i < 30; i++) { r.reportEvent(merged(i)); await minutes(2.01); }
    await load();
    for (let i = 30; i < 45; i++) { r.reportEvent(merged(i)); await minutes(2.01); }
    expect(sent).toHaveLength(40);
    expect(sent[39]).toMatch(/40 reports today/);

    vi.setSystemTime(new Date(2026, 8, 29, 8, 0, 0));
    r.reportEvent(merged(100));
    await minutes(2.01);
    expect(sent).toHaveLength(41);
    expect(sent[40]).toMatch(/5 events? after yesterday's limit/);
    expect(sent[40]).toContain('#100');
  });

  it('7. masks a key that the cut of a long error text would split', async () => {
    r.reportEvent({ ...error('a9'), reason: `${'x'.repeat(285)}sk-ant-api03-QrStUvWxYz0123456789AbCdEfGh` });
    await minutes(2.01);
    expect(sent[0]).not.toContain('sk-ant-api03');
  });

  it('5. escapes names, titles and error texts, and masks secrets', async () => {
    r.reportEvent({ ...error('a<b>'), reason: 'failed with key sk-ant-api03-AbCdEfGhIjKlMnOpQrStUvWxYz0123456789 & <i>x</i>' });
    r.reportEvent(merged(7, 'Fix <script>alert(1)</script> & more'));
    await minutes(2.01);
    expect(sent[0]).toContain('Agent a&lt;b&gt;');
    expect(sent[0]).toContain('&amp; &lt;i&gt;x&lt;/i&gt;');
    expect(sent[0]).toContain('Fix &lt;script&gt;alert(1)&lt;/script&gt; &amp; more');
    expect(sent[0]).not.toContain('AbCdEfGh');
  });
});
