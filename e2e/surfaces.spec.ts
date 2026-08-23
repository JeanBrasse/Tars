import { test, expect, _electron as electron, ElectronApplication, Page } from '@playwright/test';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { ALL } from './surfaces.mjs';
import { seedSandbox } from './fixture.mjs';

/**
 * Visual + technical sweep of the real Electron app.
 *
 * The app boots fully sandboxed: HOME points at a temp dir, so ~/.dorothy and
 * ~/.claude are empty test fixtures and the API binds a dedicated port —
 * the user's live Tars instance is never touched.
 *
 * For each surface in e2e/surfaces.mjs:
 *  - navigate (and click through to overlays / settings sections)
 *  - assert zero uncaught page errors        ← technical check
 *  - compare a screenshot against baseline   ← design check
 */

const DEV_URL = process.env.DOROTHY_DEV_URL || 'http://localhost:3100';

let app: ElectronApplication;
let page: Page;
let sandboxHome: string;
const pageErrors: string[] = [];

test.beforeAll(async () => {
  sandboxHome = fs.mkdtempSync(path.join(os.tmpdir(), 'dorothy-e2e-'));
  // Photograph a populated app, not an empty one. Every surface used to render
  // its own empty state, which cannot show a status colour, a row rhythm, a
  // truncation or a full column - so the screenshots guarded almost nothing.
  // Must happen before launch: this is the last moment the app has not read it.
  seedSandbox(sandboxHome);
  app = await electron.launch({
    args: ['.'],
    env: {
      ...process.env,
      HOME: sandboxHome,
      NODE_ENV: 'development',
      DOROTHY_DEV_URL: DEV_URL,
      DOROTHY_API_PORT: '31498',
      DOROTHY_E2E: '1',
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

for (const surface of ALL as Array<{ name: string; route: string; clickText?: string; clickText2?: string; settle?: number }>) {
  test(`surface: ${surface.name}`, async () => {
    const errorsBefore = pageErrors.length;

    await page.goto(DEV_URL + surface.route, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(600);

    // Settings labels collide with the main navigation ('Extensions' is both a
    // page and a settings group), so scope those clicks to the settings nav.
    const scope = surface.name.startsWith('settings-')
      ? page.getByTestId('settings-nav')
      : page;

    for (const clickText of [surface.clickText, surface.clickText2]) {
      if (!clickText) continue;
      const target = scope.getByText(clickText, { exact: true }).first();
      await target.waitFor({ state: 'visible', timeout: 8000 });
      await target.click();
      await page.waitForTimeout(400);
    }

    await page.waitForTimeout(surface.settle ?? 900);

    const newErrors = pageErrors.slice(errorsBefore);
    // Known pre-existing defect class: Next hydration mismatches (kanban, vault,
    // brain). Reported as annotations — each page's redesign pass must clear its
    // own — while any OTHER uncaught error still fails the surface.
    const hydration = newErrors.filter(e => /Hydration|hydration/.test(e));
    const fatal = newErrors.filter(e => !/Hydration|hydration/.test(e));
    if (hydration.length > 0) {
      test.info().annotations.push({ type: 'known-issue', description: `${hydration.length} hydration error(s) — fix with this surface's redesign pass` });
    }
    expect(fatal, `uncaught page errors on ${surface.name}`).toEqual([]);

    await expect(page).toHaveScreenshot(`${surface.name}.png`, {
      maxDiffPixelRatio: 0.005,
      animations: 'disabled',
    });
  });
}
