import { test, expect, _electron as electron, type ElectronApplication, type Locator, type Page } from '@playwright/test';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { LATEST_RELEASE, WHATS_NEW_STORAGE_KEY } from '@/data/changelog';
import { launchSandboxed, listenForErrors, markWhatsNewSeen, recordValues, seedSandbox, stepShot } from './fixture.mjs';
import { DEV_URL, apiPort } from './ports.mjs';

/**
 * Two defects on main, seen by #281's e2e on 01/10, in the real app in the
 * seeded sandbox:
 * - an agent window closed while its terminal is still loading logged
 *   "Failed to initialize terminal: Error: Terminal requires a parent
 *   element.": useAgentDialogTerminal imported xterm, then opened the terminal
 *   on an element the window no longer had. Here the xterm chunk is held at the
 *   network until the window has closed, which is that moment made certain;
 * - every custom project Claude Code has not run in showed "Invalid Date" on
 *   its card and in its own view: projects.json keeps bare paths, and
 *   fs:list-projects sends no date. The seeded projects are two of those.
 *
 * The artefact: a screenshot per step, and values.json with the chunk held,
 * the errors the window logged, and what the project's card and view say.
 */

let app: ElectronApplication;
let page: Page;
let home: string;
const errors: string[] = [];

test.beforeAll(async () => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'dorothy-e2e-window-close-'));
  seedSandbox(home);
  app = await launchSandboxed(electron, home, {
    env: { NODE_ENV: 'development', DOROTHY_DEV_URL: DEV_URL, DOROTHY_API_PORT: apiPort(31483), DOROTHY_E2E: '1' },
  });
  page = await app.firstWindow();
  listenForErrors(page, errors);
  await markWhatsNewSeen(page, WHATS_NEW_STORAGE_KEY, String(LATEST_RELEASE.id));
  await page.setViewportSize({ width: 1440, height: 900 });
});

test.afterAll(async ({}, testInfo) => {
  // Under next dev the app's process can linger a minute after it quits.
  testInfo.setTimeout(180_000);
  await app?.close().catch(() => { /* gone */ });
  if (home) fs.rmSync(home, { recursive: true, force: true });
});

/** An Agents card: the smallest block holding the name and its row of actions. */
function agentCard(name: string): Locator {
  return page.locator('div')
    .filter({ has: page.getByText(name, { exact: true }) })
    .filter({ has: page.getByRole('button', { name: 'edit', exact: true }) })
    .last();
}

test('an agent window closed while its terminal loads logs nothing', async () => {
  test.setTimeout(180_000);
  const from = errors.length;
  await page.goto(`${DEV_URL}/agents`, { waitUntil: 'domcontentloaded' });
  await expect(agentCard('Frontend Engineer')).toBeVisible({ timeout: 60_000 });

  // From here on, xterm's chunk waits at the network until the window has closed.
  const held: string[] = [];
  let release!: () => void;
  const released = new Promise<void>(resolve => { release = resolve; });
  await page.route(/xterm_lib_xterm/, async route => {
    held.push(route.request().url());
    await released;
    await route.continue();
  });

  await agentCard('Frontend Engineer').getByRole('button', { name: 'open', exact: true }).click();
  const win = page.getByRole('dialog');
  await expect(win).toBeVisible();
  // The window's terminal is loading: its import of xterm is the request held.
  await expect.poll(() => held.length, { timeout: 15_000 }).toBeGreaterThan(0);
  await stepShot(page, '01-window-while-its-terminal-loads');
  await win.getByRole('button', { name: 'close', exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);

  const loaded = page.waitForResponse(/xterm_lib_xterm/);
  release();
  await loaded;
  // The import resolves, and the hook runs to its end, within a few ticks.
  await page.evaluate(() => new Promise(resolve => setTimeout(resolve, 1000)));
  await page.unroute(/xterm_lib_xterm/);
  await stepShot(page, '02-window-closed');

  const logged = errors.slice(from);
  recordValues({ held, windowErrors: logged });
  expect(logged, logged.join('\n')).toEqual([]);
});

test('a custom project Claude Code has not run in shows no Invalid Date', async () => {
  test.setTimeout(120_000);
  const from = errors.length;
  await page.goto(`${DEV_URL}/projects`, { waitUntil: 'domcontentloaded' });
  const title = page.getByRole('heading', { name: 'tars', exact: true });
  await expect(title).toBeVisible({ timeout: 60_000 });
  const card = page.locator('div')
    .filter({ has: title })
    .filter({ has: page.getByRole('button', { name: 'open', exact: true }) })
    .last();
  await expect(card.getByText('0 sessions', { exact: true })).toBeVisible();
  await expect(card.getByText('custom', { exact: true })).toBeVisible();
  await expect(page.getByText('Invalid Date')).toHaveCount(0);
  const cardText = await card.innerText();
  await stepShot(page, '03-projects');

  // Its own view says the last activity is not known.
  await card.getByRole('button', { name: 'open', exact: true }).click();
  const tile = page.locator('div').filter({ has: page.getByText('Last active', { exact: true }) }).last();
  await expect(tile.getByText('unknown', { exact: true })).toBeVisible({ timeout: 30_000 });
  await expect(page.getByText('Invalid Date')).toHaveCount(0);
  await stepShot(page, '04-project-view');

  const logged = errors.slice(from);
  recordValues({ cardText, lastActive: await tile.innerText(), projectErrors: logged });
  expect(logged, logged.join('\n')).toEqual([]);
});
