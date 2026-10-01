import { test, expect, _electron as electron, type Locator, type Page } from '@playwright/test';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { LATEST_RELEASE, WHATS_NEW_STORAGE_KEY } from '@/data/changelog';
import { launchSandboxed, listenForErrors, markWhatsNewSeen, recordValues, seedSandbox, stepShot } from './fixture.mjs';
import { DEV_URL, apiPort } from './ports.mjs';

/**
 * The Usage page's "24 hours" view, in the real app, on #275's contract.
 * Frames: `Usage · last 24 hours` and its light copy.
 *
 * The sandbox holds real transcripts and a real ledger, written the way Claude
 * Code and the agents write them, spread around the window's edges:
 * - Claude turns this hour, 3 h, 22 h, 30 h and three days ago;
 * - a claude-sonnet-5 session that token-stats.json says ran through
 *   OpenRouter, 2 h ago;
 * - Codex in the ledger 1 h and 30 h ago, and a claude ACP turn in the ledger
 *   20 minutes ago, which its transcript already counts.
 * Main prices the transcripts; the page's figures are then checked against an
 * independent sum of what main sends (claude:getData and usage:by-provider),
 * over the current hour and the 23 before it, the ledger's claude rows left
 * out. The bars are counted, the edges read, every hover card is measured
 * against its panel, and 14 days is checked to file the OpenRouter model under
 * OpenRouter too.
 *
 * The artefact: a screenshot per step, and values.json with the expected and
 * shown figures.
 */

const HOUR = 3_600_000;
const pad = (n: number) => String(n).padStart(2, '0');
const usd = (n: number) => `$${n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

function assistant(id: string, model: string, at: number, tokens: number): string {
  return JSON.stringify({
    type: 'assistant',
    requestId: `req_${id}`,
    timestamp: new Date(at).toISOString(),
    message: {
      id: `msg_${id}`,
      model,
      usage: {
        input_tokens: tokens, output_tokens: Math.round(tokens / 4),
        cache_read_input_tokens: tokens * 3, cache_creation_input_tokens: 0,
      },
    },
  });
}

function seed(home: string, now: number) {
  seedSandbox(home);
  const dir = path.join(home, '.claude', 'projects', '-tmp-usage-24h');
  fs.mkdirSync(dir, { recursive: true });
  const ago = (minutes: number) => now - minutes * 60_000;
  fs.writeFileSync(path.join(dir, 'sess-claude.jsonl'), [
    assistant('c0', 'claude-opus-5', ago(2), 10_000),
    assistant('c3', 'claude-opus-5', ago(180), 20_000),
    assistant('c22', 'claude-opus-5', ago(22 * 60), 30_000),
    assistant('c30', 'claude-opus-5', ago(30 * 60), 40_000),
    assistant('c3d', 'claude-opus-5', ago(3 * 24 * 60), 50_000),
  ].join('\n'));
  fs.writeFileSync(path.join(dir, 'sess-or.jsonl'), assistant('o2', 'claude-sonnet-5', ago(120), 60_000));
  const dorothy = path.join(home, '.dorothy');
  fs.mkdirSync(dorothy, { recursive: true });
  fs.writeFileSync(path.join(dorothy, 'token-stats.json'), JSON.stringify({
    'sess-claude': { provider: 'claude', model: 'claude-opus-5', in: 0, out: 0, cost: 0 },
    'sess-or': { provider: 'openrouter', model: 'claude-sonnet-5', in: 0, out: 0, cost: 0 },
  }));
  const turn = (minutes: number, provider: string, model: string, costUSD: number) => JSON.stringify({
    ts: new Date(ago(minutes)).toISOString(), agentId: 'a2', provider, model,
    inputTokens: 1000, outputTokens: 200, cachedReadTokens: 0, cachedWriteTokens: 0, costUSD, transport: 'acp',
  });
  fs.writeFileSync(path.join(dorothy, 'usage-ledger.jsonl'), [
    turn(60, 'codex', 'gpt-5.3-codex', 3.21),
    turn(20, 'claude', 'claude-opus-5', 50),
    turn(30 * 60, 'codex', 'gpt-5.3-codex', 30),
  ].join('\n') + '\n');
}

type Hour = { hour: number; costUSD?: number; costByModel?: Record<string, number> };
type LedgerHour = { hour: number; provider: string; model: string | null; costUSD: number };
type Api = { electronAPI: {
  claude: { getData(): Promise<{ stats?: { hourlyModelTokens?: Hour[]; providerByModel?: Record<string, string> } }> };
  usage: { byProvider(): Promise<{ hourly?: LedgerHour[] }> };
} };

/** A panel by its caption: the smallest block holding the caption. */
const panel = (page: Page, caption: string): Locator =>
  page.locator('div').filter({ has: page.getByText(caption, { exact: true }) }).filter({ hasNot: page.locator('main') }).last();

test('the Usage page shows the last 24 hours, hour by hour, from both sources, Claude counted once', async () => {
  test.setTimeout(240_000);
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dorothy-e2e-usage-24h-'));
  seed(home, Date.now());
  const app = await launchSandboxed(electron, home, {
    env: { NODE_ENV: 'development', DOROTHY_DEV_URL: DEV_URL, DOROTHY_API_PORT: apiPort(31490), DOROTHY_E2E: '1' },
  });
  const errors: string[] = [];
  try {
    const page = await app.firstWindow();
    listenForErrors(page, errors);
    await markWhatsNewSeen(page, WHATS_NEW_STORAGE_KEY, String(LATEST_RELEASE.id));
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(`${DEV_URL}/usage`, { waitUntil: 'domcontentloaded' });
    await expect(page.getByText('TOTAL COST', { exact: true })).toBeVisible({ timeout: 60_000 });

    await page.getByRole('radio', { name: '24 hours' }).click();
    await expect(page.getByText('HOURLY COST · 24 HOURS', { exact: true })).toBeVisible();

    // What main sends, summed on its own: the current hour and the 23 before it.
    const sent = await page.evaluate(async () => {
      const api = (window as unknown as Api).electronAPI;
      const [claude, ledger] = await Promise.all([api.claude.getData(), api.usage.byProvider()]);
      return { hours: claude.stats?.hourlyModelTokens ?? [], byModel: claude.stats?.providerByModel ?? {}, ledger: ledger.hourly ?? [], now: Date.now() };
    });
    const last = Math.floor(sent.now / HOUR) * HOUR;
    const first = last - 23 * HOUR;
    const inside = (hour: number) => hour >= first && hour <= last;
    const byProvider = new Map<string, number>();
    let total = 0;
    let thisHour = 0;
    for (const h of sent.hours.filter(x => inside(x.hour))) {
      for (const [model, cost] of Object.entries(h.costByModel ?? {})) {
        const provider = sent.byModel[model] ?? 'claude';
        byProvider.set(provider, (byProvider.get(provider) ?? 0) + cost);
        total += cost;
        if (h.hour === last) thisHour += cost;
      }
    }
    for (const t of sent.ledger.filter(x => inside(x.hour) && x.provider !== 'claude')) {
      byProvider.set(t.provider, (byProvider.get(t.provider) ?? 0) + t.costUSD);
      total += t.costUSD;
      if (t.hour === last) thisHour += t.costUSD;
    }
    // The seed reached main: priced Claude hours, the OpenRouter session filed by its session, the ledger's hours.
    expect(sent.byModel['claude-sonnet-5']).toBe('openrouter');
    expect(byProvider.get('openrouter') ?? 0).toBeGreaterThan(0);
    expect(byProvider.get('codex')).toBeCloseTo(3.21, 6);
    expect(sent.ledger.some(t => t.provider === 'claude' && inside(t.hour))).toBe(true);

    const tile = async (caption: string) => (await page.getByText(caption, { exact: true }).locator('xpath=..').innerText()).split('\n').map(s => s.trim()).filter(Boolean);
    const totalTile = await tile('TOTAL COST');
    const hourTile = await tile('THIS HOUR');
    const startClock = `${pad(new Date(first).getHours())}:${pad(new Date(first).getMinutes())}`;
    const sameDay = new Date(first).toDateString() === new Date(last).toDateString();
    expect(totalTile).toEqual(['TOTAL COST', usd(total), `since ${startClock} ${sameDay ? 'today' : 'yesterday'}`]);
    expect(hourTile).toEqual(['THIS HOUR', usd(thisHour), `${pad(new Date(last).getHours())}:${pad(new Date(last).getMinutes())}`]);

    // Each provider's row, the ledger's claude turn nowhere in Claude's.
    const rows = await panel(page, 'BY PROVIDER · 24 HOURS').locator('div.h-8').evaluateAll(els => els.map(el => {
      const spans = [...el.querySelectorAll('span')].map(s => s.textContent ?? '');
      return { label: spans[0], cost: spans[spans.length - 1] };
    }));
    const labels: Record<string, string> = { claude: 'Claude', openrouter: 'OpenRouter', codex: 'Codex' };
    const expected = [...byProvider.entries()].filter(([, c]) => c > 0).sort(([, a], [, b]) => b - a).map(([p, c]) => ({ label: labels[p] ?? p, cost: usd(c) }));
    expect(rows.filter(r => r.label in { Claude: 1, OpenRouter: 1, Codex: 1 })).toEqual(expected);

    // 24 bars, from the window's first hour to this hour.
    const cost = panel(page, 'HOURLY COST · 24 HOURS');
    const bars = cost.locator('div.relative.flex-1.min-w-0');
    await expect(bars).toHaveCount(24);
    const ticks = await bars.evaluateAll(els => els.map(el => el.querySelector('span')?.textContent ?? ''));
    expect(ticks[0]).toBe(pad(new Date(first).getHours()));
    expect(ticks[23]).toBe(pad(new Date(last).getHours()));
    await expect(cost.getByText('this hour', { exact: true })).toBeVisible();
    await expect(cost.getByText(startClock, { exact: true })).toBeVisible();
    await stepShot(page, '01-last-24-hours');

    // Every hover card inside its panel, on the tokens chart, whose card is the widest.
    const tokens = panel(page, 'HOURLY TOKENS · 24 HOURS');
    const box = (await tokens.boundingBox())!;
    const outside: number[] = [];
    const tokenBars = tokens.locator('div.relative.flex-1.min-w-0');
    for (let i = 0; i < 24; i++) {
      await tokenBars.nth(i).hover();
      const cardBox = await tokenBars.nth(i).locator('div.bottom-full').boundingBox();
      if (cardBox && (cardBox.x < box.x - 0.5 || cardBox.x + cardBox.width > box.x + box.width + 0.5)) outside.push(i);
    }
    await page.mouse.move(5, 5);
    expect(outside, `cards out of their panel: ${outside.join(', ')}`).toEqual([]);

    // 14 days: the OpenRouter model under OpenRouter there too.
    await page.getByRole('radio', { name: '14 days' }).click();
    await expect(page.getByText('BY PROVIDER · 14 DAYS', { exact: true })).toBeVisible();
    await expect(panel(page, 'BY PROVIDER · 14 DAYS').getByText('OpenRouter', { exact: true })).toBeVisible();
    await stepShot(page, '02-fourteen-days');

    recordValues({ window: { first: new Date(first).toISOString(), last: new Date(last).toISOString() }, total, thisHour, byProvider: Object.fromEntries(byProvider), totalTile, hourTile, rows, ticks, pageErrors: errors });
    expect(errors, errors.join('\n')).toEqual([]);
  } finally {
    await app.close().catch(() => { /* gone */ });
    fs.rmSync(home, { recursive: true, force: true });
  }
});
