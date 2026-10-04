import { test, expect, _electron as electron, type ElectronApplication, type Page } from '@playwright/test';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { LATEST_RELEASE, WHATS_NEW_STORAGE_KEY } from '@/data/changelog';
import { launchSandboxed, listenForErrors, markWhatsNewSeen, recordValues, seedSandbox, stepShot } from './fixture.mjs';
import { DEV_URL, apiPort } from './ports.mjs';

/**
 * A Claude window past its reset, on the Usage page (the Audit's
 * AUDIT-USAGE-COMPTES.md, gap 7). The status line writes the windows to
 * ~/.dorothy/rate-limits.json as Claude Code reports them; the sandbox's says a
 * 5 h window at 97% that reset a minute ago, and a weekly one still running.
 * The 5 h row must read reset over an empty bar, where it read "97% used ·
 * resetting" until the next status line; the weekly one is as it was. Frame:
 * Usage · limits per account.
 */

let app: ElectronApplication;
let page: Page;
let home: string;
const errors: string[] = [];

test.beforeAll(async () => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'dorothy-e2e-usage-reset-'));
  seedSandbox(home);
  const now = Math.floor(Date.now() / 1000);
  fs.writeFileSync(path.join(home, '.dorothy', 'rate-limits.json'), JSON.stringify({
    five_hour: { used_percentage: 97, resets_at: now - 60 },
    seven_day: { used_percentage: 31, resets_at: now + 3 * 86_400 },
  }));
  app = await launchSandboxed(electron, home, {
    env: { NODE_ENV: 'development', DOROTHY_DEV_URL: DEV_URL, DOROTHY_API_PORT: apiPort(31479), DOROTHY_E2E: '1' },
  });
  page = await app.firstWindow();
  listenForErrors(page, errors);
  await markWhatsNewSeen(page, WHATS_NEW_STORAGE_KEY, String(LATEST_RELEASE.id));
  await page.setViewportSize({ width: 1440, height: 900 });
});

test.afterAll(async () => {
  await app?.close();
  fs.rmSync(home, { recursive: true, force: true });
});

test('usage: a claude window past its reset says reset', async () => {
  test.setTimeout(180_000);
  await page.goto(`${DEV_URL}/usage`, { waitUntil: 'domcontentloaded' });
  await expect(page.getByText('5h window · reset', { exact: true })).toBeVisible({ timeout: 60_000 });
  await expect(page.getByText(/97% used/)).toHaveCount(0);
  await expect(page.getByText(/resetting/)).toHaveCount(0);
  await expect(page.getByText(/^7d window · 31% used · resets in /)).toBeVisible();
  await stepShot(page, '01-a-window-past-its-reset');
  expect(errors, errors.join('\n')).toEqual([]);
  recordValues({ pageErrors: errors });
});
