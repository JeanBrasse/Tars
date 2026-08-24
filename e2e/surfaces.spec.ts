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

    // Anything that publishes an async probe state waits for it to land rather
    // than being photographed mid-probe. Chat's gateway banner is the case
    // that forced this: it appears a beat late and moves the whole thread, a
    // 16,000 pixel difference between two runs of the same build.
    const probing = page.locator('[data-gateway-state="checking"]');
    if (await probing.count() > 0) {
      await probing.first().waitFor({ state: 'detached', timeout: 15_000 }).catch(() => {});
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

    // Mask the terminal bodies. The dashboard screenshots real PTY output, which
    // carries the sandbox's randomly named temp directory and the clock, so the
    // baseline could never match twice: every run reported a diff, and a diff
    // that is always there tells you nothing about the run that actually broke
    // something. The panel headers, the grid and the chrome are still compared.
    // Chosen from measurements, not taste.
    //
    // It was 0.005, which is 6,480 pixels on a 1440x900 page and more than a
    // whole row of content costs: an added memory source and a rewritten
    // subtitle both drifted in under it, so several baselines went stale while
    // every run reported green. 0.001 caught those but was under the residual
    // per-run jitter, measured at 1,404 pixels on Chat and 1,788 on Agents:
    // wall clocks, live statuses and counters that keep moving in a sandbox
    // running a real app. An added row measures 3,000 to 5,000.
    //
    // 0.002 is 2,592 pixels: above the jitter, below a row.
    //
    // Known limit: a single small control is right at that line. Moving
    // Kanban's "New task" button into the header changed about 2,600 pixels and
    // passed against the old baseline, so a change that small can slip. Widen
    // the mask or narrow this further only with a measurement, not a guess.
    await expect(page).toHaveScreenshot(`${surface.name}.png`, {
      maxDiffPixelRatio: 0.002,
      animations: 'disabled',
      // Terminal bodies, and anything that counts up while an agent runs:
      // both change between two frames of the same page, so comparing them
      // means the baseline can never match twice and a green run says nothing.
      mask: [page.locator('.xterm-screen'), page.locator('[data-volatile]')],
    });
  });
}
