import { test, expect, _electron as electron } from '@playwright/test';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { launchSandboxed, seedSandbox, stubSkillsSh, markWhatsNewSeen, listenForErrors, recordValues, stepShot } from './fixture.mjs';
import { splitPageErrors } from './surfaces.mjs';
import { DEV_URL, apiPort } from './ports.mjs';
import { LATEST_RELEASE, WHATS_NEW_STORAGE_KEY } from '@/data/changelog';

/**
 * Two overlays that no surface photographs: the Dashboard's broadcast toast
 * and the dialog that installs a skill. Both drew a backdrop blur until #139,
 * which removed it with the app's other decorative effects, and the sweep
 * opens neither, so a blur put back would go unseen. This opens both, reads
 * what the browser computes for them, and checks they open without a page
 * error. Measured on main 8e35c89 before #139: `blur(8px)` for both.
 *
 * The install dialog starts an install the moment it opens. Its two handlers
 * are removed from the main process first, so it opens and installs nothing.
 */
test('the broadcast toast and the install dialog draw no backdrop blur, and open without a page error', async () => {
  test.setTimeout(300_000);
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dorothy-e2e-overlays-'));
  seedSandbox(home);
  const app = await launchSandboxed(electron, home, {
    env: { NODE_ENV: 'development', DOROTHY_DEV_URL: DEV_URL, DOROTHY_API_PORT: apiPort(31478), DOROTHY_E2E: '1' },
  });
  const errors: string[] = [];
  try {
    const page = await app.firstWindow();
    listenForErrors(page, errors);
    await markWhatsNewSeen(page, WHATS_NEW_STORAGE_KEY, String(LATEST_RELEASE.id));
    await stubSkillsSh(app);
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(DEV_URL + '/', { waitUntil: 'domcontentloaded' });

    // Ctrl+Shift+B is the terminal grid's own shortcut: wait for a terminal,
    // and press a second time only if the first found no handler yet.
    await expect(page.locator('.xterm').first()).toBeVisible({ timeout: 90_000 });
    await page.locator('body').click({ position: { x: 700, y: 20 } });
    const toast = page.locator('div.fixed', { hasText: 'Broadcast Mode Active' }).first();
    await page.keyboard.press('Control+Shift+B');
    if (!(await toast.isVisible().catch(() => false))) {
      await page.waitForTimeout(3000);
      if (!(await toast.isVisible().catch(() => false))) await page.keyboard.press('Control+Shift+B');
    }
    await expect(toast).toBeVisible({ timeout: 15_000 });
    const toastBlur = await toast.evaluate(el => getComputedStyle(el).backdropFilter);
    await stepShot(page, 'broadcast-toast');
    await page.keyboard.press('Control+Shift+B');

    await app.evaluate(({ ipcMain }) => {
      ipcMain.removeHandler('skill:install-start');
      ipcMain.removeHandler('plugin:install-start');
    });
    await page.goto(DEV_URL + '/skills', { waitUntil: 'domcontentloaded' });
    const install = page.getByRole('button', { name: /^\s*Install\s*$/ }).first();
    await expect(install).toBeVisible({ timeout: 90_000 });
    await install.click();
    const scrim = page.locator('div.fixed.inset-0.bg-scrim').first();
    await expect(scrim).toBeVisible({ timeout: 15_000 });
    const scrimBlur = await scrim.evaluate(el => getComputedStyle(el).backdropFilter);
    await stepShot(page, 'install-dialog');

    const { fatal } = splitPageErrors(errors);
    recordValues({ toastBlur, scrimBlur, errors });
    expect.soft(toastBlur, 'the broadcast toast').toBe('none');
    expect.soft(scrimBlur, 'the install dialog scrim').toBe('none');
    expect(fatal, 'page errors while opening them').toEqual([]);
  } finally {
    await app.close();
    fs.rmSync(home, { recursive: true, force: true });
  }
});
