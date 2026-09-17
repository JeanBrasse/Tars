import { test, expect, _electron as electron, ElectronApplication, Page } from '@playwright/test';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { ALL, recordPageErrors, SCREENSHOT_TOLERANCE, volatileMasks } from './surfaces.mjs';
import { LATEST_RELEASE, WHATS_NEW_STORAGE_KEY } from '@/data/changelog';
import { launchSandboxed, listenForErrors, markWhatsNewSeen, seedSandbox, stubSkillsSh } from './fixture.mjs';

/**
 * Visual + technical sweep of the real Electron app.
 *
 * The app boots sandboxed through launchSandboxed in fixture.mjs: HOME points
 * at a temp dir, so ~/.dorothy and ~/.claude are test fixtures, its Chromium
 * profile is moved there too, which HOME alone does not do, and the API binds
 * a dedicated port.
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
  app = await launchSandboxed(electron, sandboxHome, {
    env: {
      NODE_ENV: 'development',
      DOROTHY_DEV_URL: DEV_URL,
      DOROTHY_API_PORT: '31498',
      DOROTHY_E2E: '1',
    },
  });
  page = await app.firstWindow();
  listenForErrors(page, pageErrors);
  await markWhatsNewSeen(page, WHATS_NEW_STORAGE_KEY, String(LATEST_RELEASE.id));
  await stubSkillsSh(app);

  await page.setViewportSize({ width: 1440, height: 900 });
  await page.waitForLoadState('domcontentloaded');
});

test.afterAll(async () => {
  await app?.close();
  fs.rmSync(sandboxHome, { recursive: true, force: true });
});

for (const surface of ALL as Array<{ name: string; route: string; clickText?: string; clickText2?: string; clickRole?: 'radio'; settle?: number }>) {
  test(`surface: ${surface.name}`, async () => {
    const errorsBefore = pageErrors.length;

    await page.goto(DEV_URL + surface.route, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(600);

    // Settings labels collide with the main navigation ('Extensions' is both a
    // page and a settings group), so scope those clicks to the settings nav.
    const scope = surface.name.startsWith('settings-')
      ? page.getByTestId('settings-nav')
      : page;

    for (const [index, clickText] of [surface.clickText, surface.clickText2].entries()) {
      if (!clickText) continue;
      // By role when the surface says so: a tab and a sidebar entry can carry
      // the same word, and the sidebar is the one the DOM offers first.
      const target = index === 0 && surface.clickRole
        ? scope.getByRole(surface.clickRole, { name: clickText, exact: true })
        : scope.getByText(clickText, { exact: true }).first();
      await target.waitFor({ state: 'visible', timeout: 8000 });
      await target.click();
      await page.waitForTimeout(400);
    }

    // Anything that publishes an async probe state waits for it to land rather
    // than being photographed mid-probe. Chat's gateway banner is the case
    // that forced this: it appears a beat late and moves the whole thread, a
    // 16,000 pixel difference between two runs of the same build.
    const probing = page.locator('[data-gateway-state="checking"]');
    if (await probing.count() > 0) {
      await probing.first().waitFor({ state: 'detached', timeout: 15_000 }).catch(() => {});
    }

    await page.waitForTimeout(surface.settle ?? 900);

    // Known pre-existing defects are recorded rather than failed. Each one is
    // declared in surfaces.mjs, and e2e/known-errors.spec.ts fails when a
    // declared one stops happening, so an allowance cannot outlive its defect.
    // Recorded before the screenshot, so a surface that fails on its picture
    // still counts for what it saw. Any OTHER error fails the surface.
    const { masks, used } = await volatileMasks(page, surface.name);
    const fatal = recordPageErrors(test.info(), 'surfaces', surface.name, pageErrors.slice(errorsBefore), used);
    // Soft, so the picture below is still taken and compared: a surface that
    // logs an error is exactly the one whose look is worth seeing, and a hard
    // failure here left no screenshot and no diff to look at. The test fails
    // all the same, at its end.
    expect.soft(fatal, `errors on ${surface.name}`).toEqual([]);

    // Everything that moves on its own is masked by locator rather than
    // tolerated by the number below: which locators, and why each one, is in
    // VOLATILE in surfaces.mjs, and a locator that stops matching fails the run
    // in e2e/known-errors.spec.ts. The tolerance is the same in every spec and
    // is measured, not chosen: see SCREENSHOT_TOLERANCE.
    await expect(page).toHaveScreenshot(`${surface.name}.png`, {
      ...SCREENSHOT_TOLERANCE,
      animations: 'disabled',
      mask: masks,
    });
  });
}
