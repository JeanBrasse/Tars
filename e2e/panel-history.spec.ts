import { test, expect, _electron as electron, ElectronApplication, Locator, Page } from '@playwright/test';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { PANEL_HISTORY } from './surfaces.mjs';
import { seedSandbox } from './fixture.mjs';

/**
 * A Dashboard panel switched to its history view, in a sandbox where nothing
 * starts.
 *
 * Two things live here. The panel history surfaces, photographed like every
 * other surface but against a transcript seeded on disk (fixture.mjs says why
 * that needs a sandbox of its own). And the check the three reverted attempts
 * at these panels never had: switching a panel to history and back leaves its
 * terminal exactly as it was.
 */

const DEV_URL = process.env.DOROTHY_DEV_URL || 'http://localhost:3100';

let app: ElectronApplication;
let page: Page;
let sandboxHome: string;
const pageErrors: string[] = [];

type PanelSurface = { name: string; route: string; clickText: string; within: string; shows: string };

interface TerminalGeometry {
  cols: number;
  rows: number;
  cell: { width: number; height: number };
  screen: { width: number; height: number };
  viewport: { width: number; height: number };
}

test.beforeAll(async () => {
  sandboxHome = fs.mkdtempSync(path.join(os.tmpdir(), 'dorothy-e2e-history-'));
  seedSandbox(sandboxHome, { panelHistory: true });
  app = await electron.launch({
    args: ['.'],
    // The renderer reads the clock too, and it is the one that formats the rows.
    timezoneId: 'UTC',
    env: {
      ...process.env,
      HOME: sandboxHome,
      NODE_ENV: 'development',
      DOROTHY_DEV_URL: DEV_URL,
      // Its own port: the two other suites may still be holding 31498 and 31497.
      DOROTHY_API_PORT: '31496',
      DOROTHY_E2E: '1',
      // The view prints each message in local time, so the clock is pinned
      // here rather than left to whichever machine records the baseline.
      TZ: 'UTC',
    },
  });
  page = await app.firstWindow();
  page.on('pageerror', err => pageErrors.push(String(err)));
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.waitForLoadState('domcontentloaded');
});

test.afterAll(async () => {
  await app?.close();
  fs.rmSync(sandboxHome, { recursive: true, force: true });
});

/** A panel's header: the smallest block holding both the agent's name and its view switch. */
function panelHeader(agentName: string): Locator {
  return page
    .locator('div')
    .filter({ has: page.getByText(agentName, { exact: true }) })
    .filter({ has: page.getByRole('radiogroup', { name: 'Panel view' }) })
    .last();
}

/**
 * The terminal bodies of the panels still on `live`, masked for the reason the
 * main sweep masks them: a blinking cursor never matches twice. The panel on
 * `history` is left unmasked, since its terminal sits under the view being
 * photographed.
 */
async function liveTerminalMasks(): Promise<Locator[]> {
  const screens = page.locator('.xterm-screen');
  const live = await screens.evaluateAll(elements => elements.flatMap((element, index) => {
    let panel = element.parentElement;
    while (panel && !panel.querySelector('[role="radiogroup"][aria-label="Panel view"]')) panel = panel.parentElement;
    return panel?.querySelector('[role="radio"][aria-checked="true"]')?.textContent === 'live' ? [index] : [];
  }));
  return [...live.map(index => screens.nth(index)), page.locator('[data-volatile]')];
}

/**
 * The emulator's own numbers.
 *
 * xterm 5.3's DOM renderer sizes the screen to cols times the cell width by
 * rows times the cell height, and its row container holds one element per row.
 * The cell width is not in the stylesheet it writes, so this reads it where
 * xterm measures it itself: the span of 32 W's kept in the terminal's helpers.
 */
function measure(terminal: Locator): Promise<TerminalGeometry> {
  return terminal.evaluate(element => {
    const screen = element.querySelector<HTMLElement>('.xterm-screen');
    const viewport = element.querySelector<HTMLElement>('.xterm-viewport')?.getBoundingClientRect();
    const measured = element.querySelector<HTMLElement>('.xterm-char-measure-element')?.getBoundingClientRect();
    const rows = element.querySelector('.xterm-rows')?.childElementCount ?? 0;
    const width = parseFloat(screen?.style.width ?? '') || 0;
    const height = parseFloat(screen?.style.height ?? '') || 0;
    // 32 is xterm's own repeat count for that span, in CharSizeService.
    const cellWidth = measured ? measured.width / 32 : 0;
    return {
      // -1 rather than a silent NaN: a terminal that cannot be measured has to
      // fail the assertions below, not compare equal to itself.
      cols: cellWidth > 0 ? Math.round(width / cellWidth) : -1,
      rows,
      cell: { width: cellWidth, height: rows > 0 ? height / rows : 0 },
      screen: { width, height },
      viewport: { width: viewport?.width ?? 0, height: viewport?.height ?? 0 },
    };
  });
}

/** The geometry once it has held still for about a second: after a load the grid lays out and fits on its own clock. */
async function settled(terminal: Locator): Promise<TerminalGeometry> {
  let last = await measure(terminal);
  let held = 0;
  for (let attempt = 0; attempt < 60; attempt++) {
    await page.waitForTimeout(300);
    const next = await measure(terminal);
    held = JSON.stringify(next) === JSON.stringify(last) ? held + 1 : 0;
    last = next;
    if (held >= 3) return next;
  }
  throw new Error(`the terminal never held still: ${JSON.stringify(last)}`);
}

for (const surface of PANEL_HISTORY as PanelSurface[]) {
  test(`surface: ${surface.name}`, async () => {
    const errorsBefore = pageErrors.length;

    await page.goto(DEV_URL + surface.route, { waitUntil: 'domcontentloaded' });
    const header = panelHeader(surface.within);
    const control = header.getByRole('radio', { name: surface.clickText, exact: true });
    await control.waitFor({ state: 'visible', timeout: 15_000 });
    await control.click();

    // The view reads the transcript over IPC: photograph what it read, not the
    // skeleton in front of it.
    await expect(header.locator('xpath=..').getByText(surface.shows, { exact: true })).toBeVisible();
    await page.waitForTimeout(900);

    expect(pageErrors.slice(errorsBefore), `uncaught page errors on ${surface.name}`).toEqual([]);

    await expect(page).toHaveScreenshot(`${surface.name}.png`, {
      // The main sweep's tolerance, for the reasons written next to it in
      // surfaces.spec.ts.
      maxDiffPixelRatio: 0.002,
      animations: 'disabled',
      mask: await liveTerminalMasks(),
    });
  });
}

test('switching a panel to history and back leaves its terminal exactly as it was', async () => {
  const errorsBefore = pageErrors.length;
  await page.goto(DEV_URL + '/', { waitUntil: 'domcontentloaded' });

  const header = panelHeader('Orchestrator');
  const panel = header.locator('xpath=..');
  const terminal = panel.locator('.xterm');
  await terminal.waitFor({ state: 'attached', timeout: 15_000 });

  const before = await settled(terminal);
  // Two broken terminals compare equal as well, so this one has to be worth comparing.
  expect(before.cols, 'columns before the switch').toBeGreaterThan(20);
  expect(before.rows, 'rows before the switch').toBeGreaterThan(5);
  const emulator = await terminal.elementHandle();

  await header.getByRole('radio', { name: 'history', exact: true }).click();
  await expect(panel.getByText('Ship it, with the test that caught it.', { exact: true })).toBeVisible();
  // Drawn over the terminal, never instead of it: the xterm underneath keeps its size.
  expect(await settled(terminal), 'terminal while history is shown').toEqual(before);

  await header.getByRole('radio', { name: 'live', exact: true }).click();
  await expect(panel.getByText('Orchestrator · snapshot')).toHaveCount(0);

  expect(await settled(terminal), 'terminal after switching back').toEqual(before);
  // What was actually compared, in the run report: a green assertion on two
  // identical empty readings would say nothing, and this is what makes that
  // visible without opening a trace.
  test.info().annotations.push({ type: 'terminal', description: JSON.stringify(before) });
  // The same emulator, not a new one built in its place at the same size.
  expect(await terminal.evaluate((element, original) => element === original, emulator), 'same xterm element').toBe(true);
  expect(pageErrors.slice(errorsBefore), 'page errors during the round trip').toEqual([]);
});
