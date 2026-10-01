import { test, expect, _electron as electron, type ElectronApplication, type Locator, type Page } from '@playwright/test';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { LATEST_RELEASE, WHATS_NEW_STORAGE_KEY } from '@/data/changelog';
import { launchSandboxed, listenForErrors, markWhatsNewSeen, recordValues, seedSandbox, stepShot } from './fixture.mjs';
import { DEV_URL, apiPort } from './ports.mjs';

/**
 * An agent's panel header on the Dashboard (Noah, 01/10). Frames: `Panel
 * header · session and fullscreen` and its light copy, and every frame that
 * draws a panel header, in design/tars-redesign.pen. In the real app, in a
 * sandbox where nothing starts:
 * - the panel has no history view: nothing in its header offers one, and no
 *   view switch is left;
 * - the word that named the live view says `session`;
 * - fullscreen is a 26 px button in the header, after start or stop and out
 *   of the menu: a press fills the window, the button turns to exit
 *   fullscreen, and a second press takes the panel back;
 * - the panel's menu offers clear and hide from this board, and fullscreen no
 *   longer; in fullscreen, clear alone.
 */

let app: ElectronApplication;
let page: Page;
let home: string;
const errors: string[] = [];

test.beforeAll(async () => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'dorothy-e2e-panel-header-'));
  seedSandbox(home);
  app = await launchSandboxed(electron, home, {
    env: { NODE_ENV: 'development', DOROTHY_DEV_URL: DEV_URL, DOROTHY_API_PORT: apiPort(31484), DOROTHY_E2E: '1' },
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

/** A panel's header: the smallest block holding the agent's name and its menu button. */
function header(name: string): Locator {
  return page
    .locator('div')
    .filter({ has: page.getByText(name, { exact: true }) })
    .filter({ has: page.getByRole('button', { name: 'Panel actions' }) })
    .last();
}

test("an agent's panel header: its session, no history, and fullscreen in one press", async () => {
  test.setTimeout(180_000);
  await page.goto(`${DEV_URL}/`, { waitUntil: 'domcontentloaded' });
  const h = header('Orchestrator');
  await expect(h).toBeVisible({ timeout: 60_000 });

  // No history view, and no switch left to choose one.
  await expect(h.getByText('history', { exact: true })).toHaveCount(0);
  await expect(h.getByRole('radiogroup')).toHaveCount(0);
  await expect(h.getByText('live', { exact: true })).toHaveCount(0);
  await expect(h.getByText('session', { exact: true })).toBeVisible();

  // Fullscreen is a button of its own, 26 px, after start or stop.
  const fs1 = h.getByRole('button', { name: 'Fullscreen', exact: true });
  await expect(fs1).toBeVisible();
  const box = await fs1.boundingBox();
  expect(box && Math.round(box.height)).toBe(26);
  expect(box && Math.round(box.width)).toBe(26);
  const startStop = h.getByRole('button', { name: /^(start|stop)$/ });
  const ssBox = await startStop.boundingBox();
  expect(ssBox && box && box.x > ssBox.x).toBe(true);
  const restWidth = (await h.boundingBox())!.width;
  expect(restWidth).toBeLessThan(1200);
  await stepShot(page, '01-header-at-rest');

  // Its menu: clear and hide from this board, no fullscreen.
  // The menu opens inside the header, so the header's own button is the one
  // fullscreen control it may hold.
  await h.getByRole('button', { name: 'Panel actions' }).click();
  await expect(h.getByRole('button', { name: 'clear', exact: true })).toBeVisible();
  await expect(h.getByRole('button', { name: 'hide from this board', exact: true })).toBeVisible();
  await expect(h.getByRole('button', { name: /fullscreen/i })).toHaveCount(1);
  await stepShot(page, '02-menu-at-rest');
  // Closed by its own button: Escape would go to the terminal, and type into the agent.
  await h.getByRole('button', { name: 'Panel actions' }).click();
  await expect(h.getByRole('button', { name: 'clear', exact: true })).toHaveCount(0);

  // One press fills the window; the button turns to take it back.
  await fs1.click();
  const exit = page.getByRole('button', { name: 'Exit fullscreen', exact: true });
  await expect(exit).toBeVisible();
  await expect.poll(async () => (await header('Orchestrator').boundingBox())?.width ?? 0).toBeGreaterThan(1400);
  await stepShot(page, '03-fullscreen');
  const full = header('Orchestrator');
  await full.getByRole('button', { name: 'Panel actions' }).click();
  await expect(full.getByRole('button', { name: 'clear', exact: true })).toBeVisible();
  await expect(full.getByRole('button', { name: 'hide from this board', exact: true })).toHaveCount(0);
  await expect(full.getByRole('button', { name: /fullscreen/i })).toHaveCount(1);
  await stepShot(page, '04-menu-in-fullscreen');
  await full.getByRole('button', { name: 'Panel actions' }).click();
  await expect(full.getByRole('button', { name: 'clear', exact: true })).toHaveCount(0);

  await exit.click();
  await expect(page.getByRole('button', { name: 'Exit fullscreen', exact: true })).toHaveCount(0);
  await expect.poll(async () => (await header('Orchestrator').boundingBox())?.width ?? 0).toBeLessThan(1200);
  await stepShot(page, '05-back-on-the-board');

  expect(errors, errors.join('\n')).toEqual([]);
  recordValues({ restWidth, fullscreenButton: box, pageErrors: errors });
});
