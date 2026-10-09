/**
 * The renderer's half of error reports. Main's half (#221,
 * electron/services/error-reports) loads @sentry/electron only while
 * `errorReportsEnabled` is on, rebuilds every report from a list of fields,
 * and sends nothing once the setting is off. This one starts the window's SDK
 * the same way: loaded only when the setting is on, at start or when the
 * switch turns it on, once per run, for errors alone. What it catches goes
 * through Tars's preload bridge to main, which decides whether it leaves.
 *
 * Turned off again, it stays loaded until the app restarts: the SDK starts
 * once per window, and main drops whatever it is handed.
 */

import { rendererPlatform } from '@/lib/display-path';

/**
 * Whether this window offers error reports at all: not on a Windows build,
 * whose reports would go to a Sentry project that has not agreed to receive
 * them (main holds the same line in electron/platform/error-reports.ts).
 * There the row is hidden and the SDK
 * never loads.
 */
export function errorReportsOffered(platform: string = rendererPlatform()): boolean {
  return platform !== 'win32';
}

let started: Promise<boolean> | null = null;

/** Starts the window's SDK when `enabled`, once; never loads it otherwise. Resolves to whether it runs. */
export function followErrorReports(enabled: boolean): Promise<boolean> {
  if (!enabled || !errorReportsOffered()) return started ?? Promise.resolve(false);
  started ??= import('@sentry/electron/renderer')
    .then((sentry) => {
      sentry.init({
        // Errors alone, as main's side takes them: no breadcrumbs of clicks or
        // console lines, no page URL or user agent, no wrapped timers or
        // listeners, and no sessions, traces or replays.
        defaultIntegrations: false,
        integrations: [sentry.globalHandlersIntegration(), sentry.linkedErrorsIntegration()],
        sendDefaultPii: false,
      });
      return true;
    })
    .catch((error: unknown) => {
      // Nothing is lost by not starting: main sends nothing it was not handed.
      // A later turn of the switch tries again.
      started = null;
      console.warn('Error reports could not start in this window:', error);
      return false;
    });
  return started;
}

/** At start: the setting as main has it. No bridge, no answer or no key leaves it off, as it is by default. */
export async function followErrorReportsSetting(api: { appSettings?: { get(): Promise<unknown> } } | undefined): Promise<boolean> {
  let settings: unknown;
  try {
    settings = await api?.appSettings?.get();
  } catch {
    return false;
  }
  return followErrorReports((settings as { errorReportsEnabled?: unknown } | null | undefined)?.errorReportsEnabled === true);
}
