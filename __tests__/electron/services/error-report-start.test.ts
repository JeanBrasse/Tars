import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

/**
 * When the Sentry SDK is loaded and started in the main process, from the one
 * setting the Frontend's toggle writes (`errorReportsEnabled`, default false,
 * saved through app:saveSettings like every other setting).
 *
 * How it fails, written before the code (2026-09-28):
 * 1. With the setting off, the SDK is loaded or started anyway: its handlers,
 *    its IPC listeners and OpenTelemetry would be in the process of a user
 *    who never asked for reports, and its load costs every start.
 * 2. Turned on while Tars runs, nothing starts until a restart.
 * 3. Turned off and on again, the SDK is started a second time: a second
 *    client, and a second `ipcMain.handle` on the same channel, which throws.
 * 4. It is started with the SDK's defaults: native crash dumps (process
 *    memory), screenshots, breadcrumbs of network requests and console lines,
 *    sessions, the renderer preload injection, OpenTelemetry, the offline
 *    queue on disk that sends later; or with another address than Tars's DSN.
 * 4b. The request to Sentry carries the system's language: Chromium adds an
 *    Accept-Language header to every request the net module makes.
 * 5. The SDK failing to load or to start throws out of the main process.
 *    (It is loaded with import(), resolved by the time sync()'s promise is.)
 * 6. The setting's default is not false, in the settings main starts with.
 * 7. A settings change is not followed: main.ts never tells the reports
 *    that the settings were replaced.
 */

const loaded = vi.hoisted(() => ({ count: 0, fail: false }));
const init = vi.hoisted(() => vi.fn());
vi.mock('@sentry/electron/main', () => {
  loaded.count++;
  if (loaded.fail) throw new Error('cannot load');
  const integration = (name: string) => () => ({ name });
  return {
    init,
    IPCMode: { Classic: 1, Protocol: 2, Both: 3 },
    onUncaughtExceptionIntegration: integration('OnUncaughtException'),
    onUnhandledRejectionIntegration: integration('OnUnhandledRejection'),
    linkedErrorsIntegration: integration('LinkedErrors'),
    makeElectronTransport: vi.fn(() => ({ send: vi.fn(), flush: vi.fn() })),
    makeElectronOfflineTransport: vi.fn(),
  };
});
vi.mock('electron', () => ({
  app: { getVersion: () => '1.9.1', isReady: () => false, getPath: () => '/tmp' },
}));

import { startErrorReports, ERROR_REPORTS_DSN } from '../../../electron/services/error-reports';

beforeEach(() => {
  loaded.count = 0;
  loaded.fail = false;
  init.mockReset();
  vi.resetModules();
});

async function fresh() {
  return (await import('../../../electron/services/error-reports')).startErrorReports;
}

describe('the SDK in the main process', () => {
  it('1. is neither loaded nor started while the setting is off', async () => {
    const start = await fresh();
    const reports = start(() => false);
    await reports.sync();
    await reports.sync();
    expect(loaded.count).toBe(0);
    expect(init).not.toHaveBeenCalled();
  });

  it('2, 3. starts when the setting is turned on while running, once for the run', async () => {
    let on = false;
    const start = await fresh();
    const reports = start(() => on);
    on = true;
    await reports.sync();
    on = false;
    await reports.sync();
    on = true;
    await reports.sync();
    expect(init).toHaveBeenCalledTimes(1);
  });

  it('4. with Tars\'s DSN, errors only, and none of the SDK\'s defaults', async () => {
    const start = await fresh();
    await start(() => true).sync();
    const options = init.mock.calls[0][0];

    expect(options.dsn).toBe(ERROR_REPORTS_DSN);
    expect(options.dsn).toBe('https://d3d853ef128291b07daad0c136b0c82d@o4511321063620608.ingest.de.sentry.io/4512140890996816');
    expect(options.defaultIntegrations).toBe(false);
    expect(options.integrations.map((i: { name: string }) => i.name))
      .toEqual(['OnUncaughtException', 'OnUnhandledRejection', 'LinkedErrors']);
    expect(options.ipcMode).toBe(1);
    expect(options.skipOpenTelemetrySetup).toBe(true);
    expect(options.attachScreenshot).toBeFalsy();
    expect(options.enableRendererProfiling).toBeFalsy();
    expect(typeof options.beforeSend).toBe('function');
    expect(typeof options.transport).toBe('function');
    expect(options.transportOptions).toEqual({ headers: { 'Accept-Language': 'en' } });
  });

  it('5. never throws when the SDK cannot be loaded or started', async () => {
    loaded.fail = true;
    let start = await fresh();
    await expect(start(() => true).sync()).resolves.toBeUndefined();

    vi.resetModules();
    loaded.fail = false;
    init.mockImplementation(() => { throw new Error('init failed'); });
    start = await fresh();
    await expect(start(() => true).sync()).resolves.toBeUndefined();
  });
});

describe('main.ts', () => {
  const main = fs.readFileSync(path.join(__dirname, '../../../electron/main.ts'), 'utf-8');

  it('6. starts with errorReportsEnabled false', () => {
    expect(main).toMatch(/errorReportsEnabled: false,/);
  });

  it('7. starts the reports before the app is ready, and tells them each time the settings are replaced', () => {
    expect(main).toMatch(/startErrorReports\(\(\) => appSettings\.errorReportsEnabled === true\)/);
    expect(main.indexOf('startErrorReports(')).toBeLessThan(main.indexOf('app.whenReady()'));
    const setters = main.match(/setAppSettings: \([^)]*\)[^\n]*=> \{[^}]*\}/g) ?? [];
    expect(setters.length).toBeGreaterThanOrEqual(2);
    for (const setter of setters) expect(setter, setter).toContain('errorReports.sync()');
  });
});

void startErrorReports;
