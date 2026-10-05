import { test, expect, _electron as electron } from '@playwright/test';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { launchSandboxed, recordValues, seedSandbox } from './fixture.mjs';
import { DEV_URL, apiPort } from './ports.mjs';

/**
 * The Sentry token leaves ~/.dorothy, which every agent is handed, for
 * ~/.tars-private, which none is (the Audit's gates of #242 and #292), in the
 * real app: a token saved by an older Tars in app-settings.json moves at the
 * first start, the settings the app hands its pages still carry it, and a
 * save, of that token or of anything else, never writes it back.
 */

type Api = { electronAPI: { appSettings: {
  get(): Promise<Record<string, unknown>>;
  save(s: Record<string, unknown>): Promise<unknown>;
} } };

const OLD = 'sntryu_e2e-token-saved-by-an-older-tars';
const NEW = 'sntryu_e2e-token-typed-in-settings';

test('the Sentry token moves out of ~/.dorothy at the first start, and a save never writes it back', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dorothy-e2e-sentry-token-'));
  seedSandbox(home);
  const settingsFile = path.join(home, '.dorothy', 'app-settings.json');
  const seeded = JSON.parse(fs.readFileSync(settingsFile, 'utf8'));
  fs.writeFileSync(settingsFile, JSON.stringify({ ...seeded, sentryAuthToken: OLD, sentryTriageProject: '/work/tars' }, null, 2));
  const privateFile = path.join(home, '.tars-private', 'sentry-token');

  const app = await launchSandboxed(electron, home, {
    env: { NODE_ENV: 'development', DOROTHY_DEV_URL: DEV_URL, DOROTHY_API_PORT: apiPort(31469), DOROTHY_E2E: '1' },
  });
  try {
    const page = await app.firstWindow();
    await page.goto(`${DEV_URL}/settings`, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => !!(window as unknown as Partial<Api>).electronAPI);
    const get = () => page.evaluate(() => (window as unknown as Api).electronAPI.appSettings.get());
    const save = (s: Record<string, unknown>) => page.evaluate((x) => (window as unknown as Api).electronAPI.appSettings.save(x), s);
    const onDisk = () => fs.readFileSync(settingsFile, 'utf8');

    // Moved at the first start, and still handed to the pages.
    const moved = { inSettings: onDisk().includes(OLD), private: fs.readFileSync(privateFile, 'utf8'), mode: (fs.statSync(privateFile).mode & 0o777).toString(8) };
    expect(moved).toEqual({ inSettings: false, private: OLD, mode: '600' });
    expect((await get()).sentryAuthToken).toBe(OLD);

    // A save of something else does not write it back.
    await save({ sentryTriageProject: '/work/other' });
    const afterOther = { inSettings: onDisk().includes(OLD), project: JSON.parse(onDisk()).sentryTriageProject, private: fs.readFileSync(privateFile, 'utf8') };
    expect(afterOther).toEqual({ inSettings: false, project: '/work/other', private: OLD });

    // A new token goes to the private file only.
    await save({ sentryAuthToken: NEW });
    const afterNew = { inSettings: /sntryu_/.test(onDisk()), private: fs.readFileSync(privateFile, 'utf8'), handed: (await get()).sentryAuthToken };
    expect(afterNew).toEqual({ inSettings: false, private: NEW, handed: NEW });

    // Cleared, it is gone.
    await save({ sentryAuthToken: '' });
    const cleared = { privateExists: fs.existsSync(privateFile), handed: (await get()).sentryAuthToken };
    expect(cleared).toEqual({ privateExists: false, handed: '' });

    recordValues({ moved, afterOther, afterNew, cleared, keysOnDisk: Object.keys(JSON.parse(onDisk())).sort() });
  } finally {
    await app.close();
  }
});
