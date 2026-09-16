import { test, expect, _electron as electron, ElectronApplication, Page } from '@playwright/test';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { CHAT_ROOMS } from './surfaces.mjs';
import { seedSandbox } from './fixture.mjs';

/**
 * The Chat room, one frame per state, in a sandbox of its own.
 *
 * A room is derived from a project rather than stored, and its state comes
 * from the bus journal, so five states means five rooms and a seeded journal.
 * That sandbox cannot be the sweep's: three more projects and six more agents
 * would move every baseline in it, and autostart would run each of those
 * agents as a real CLI, which makes `all stopped` impossible to photograph.
 *
 * What this pins that nothing else did: `delivered`, `dropped`, `bounded` and
 * `superseded` are rendered here for the first time. They were states the page
 * had code for and no data had ever produced, which is not the same as a state
 * that works.
 */

const DEV_URL = process.env.DOROTHY_DEV_URL || 'http://localhost:3100';

let app: ElectronApplication;
let page: Page;
let sandboxHome: string;
const pageErrors: string[] = [];

type ChatSurface = { name: string; route: string; clickText?: string; shows: string; placeholder?: string };

test.beforeAll(async () => {
  sandboxHome = fs.mkdtempSync(path.join(os.tmpdir(), 'dorothy-e2e-chat-'));
  seedSandbox(sandboxHome, { chatRooms: true });
  app = await electron.launch({
    args: ['.'],
    timezoneId: 'UTC',
    env: {
      ...process.env,
      HOME: sandboxHome,
      NODE_ENV: 'development',
      DOROTHY_DEV_URL: DEV_URL,
      // Its own port: the other suites may still be holding 31498 and 31496.
      DOROTHY_API_PORT: '31495',
      DOROTHY_E2E: '1',
      // Every row carries a time, so the clock is pinned here rather than left
      // to whichever machine records the baseline.
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

for (const surface of CHAT_ROOMS as ChatSurface[]) {
  test(`surface: ${surface.name}`, async () => {
    const errorsBefore = pageErrors.length;

    await page.goto(DEV_URL + surface.route, { waitUntil: 'domcontentloaded' });

    if (surface.clickText) {
      // The room is chosen in the conversation list, which is the only way in:
      // the page holds the selection in state rather than in the URL.
      const entry = page.getByRole('button', { name: surface.clickText, exact: false })
        .filter({ hasText: surface.clickText }).first();
      await entry.waitFor({ state: 'visible', timeout: 20_000 });
      await entry.click();
    }

    // The state itself, in the words the page uses for it. Waiting on the room
    // title instead would photograph the log before the journal arrived.
    await expect(page.getByText(surface.shows, { exact: false }).first()).toBeVisible({ timeout: 20_000 });
    // Some of what a room says about itself is said in the composer rather than
    // in the log, and a placeholder is not text this would otherwise find.
    if (surface.placeholder) {
      await expect(page.getByPlaceholder(surface.placeholder, { exact: false })).toBeVisible({ timeout: 20_000 });
    }
    await page.waitForTimeout(900);

    // The same carve-out the main sweep makes, and for the same reason: Next
    // hydration mismatches are a known pre-existing class across this app,
    // annotated so each page's redesign pass clears its own, while any other
    // uncaught error still fails the surface. Splitting them here rather than
    // failing on them keeps one rule for the whole suite.
    const newErrors = pageErrors.slice(errorsBefore);
    const hydration = newErrors.filter(e => /Hydration|hydration/.test(e));
    const fatal = newErrors.filter(e => !/Hydration|hydration/.test(e));
    if (hydration.length > 0) {
      test.info().annotations.push({ type: 'known-issue', description: `${hydration.length} hydration error(s) on ${surface.name}` });
    }
    expect(fatal, `uncaught page errors on ${surface.name}`).toEqual([]);

    await expect(page).toHaveScreenshot(`${surface.name}.png`, {
      // The main sweep's tolerance, for the reasons written beside it there.
      maxDiffPixelRatio: 0.002,
      animations: 'disabled',
      mask: [page.locator('.xterm-screen'), page.locator('[data-volatile]')],
    });
  });
}
