import * as os from 'os';
import * as path from 'path';
import { app } from 'electron';
import { DATA_DIR } from '../../constants';
import { ReportBudget } from './budget';
import { errorReportOptions } from './options';
import type { ReportFacts } from './report';

/**
 * Error reports to Sentry, off unless the user turns them on in Settings
 * (`errorReportsEnabled`, default false). Step 1 of PLAN-RELAIS-SENTRY.md.
 *
 * Off, the SDK is not even loaded: no handler, no IPC listener, nothing on
 * the network. Turned on, at start or while Tars runs, it is loaded and
 * started once for the run. Turned off again, it stays loaded and sends
 * nothing: options.ts reads the setting at each event and again as each
 * envelope is about to leave. Only what report.ts lists can leave, at most
 * once a day for the same error and 20 a day (budget.ts).
 *
 * Started with none of the SDK's defaults: no native crash dumps (they hold
 * process memory), no screenshots, no breadcrumbs of network requests or
 * console lines, no sessions, no preload injected into windows, no
 * OpenTelemetry, and no offline queue on disk that would send later. The
 * renderer's errors come through Tars's own preload (IPCMode.Classic): the
 * window is sandboxed and cannot load the SDK's preload.
 */

/** Tars's Sentry project (the noah-boisserie organisation, EU). A DSN is public by design: it only lets a client send. */
export const ERROR_REPORTS_DSN = 'https://d3d853ef128291b07daad0c136b0c82d@o4511321063620608.ingest.de.sentry.io/4512140890996816';

const OS_NAMES: Partial<Record<NodeJS.Platform, string>> = { darwin: 'macOS', linux: 'Linux', win32: 'Windows' };

function facts(budget: ReportBudget): ReportFacts {
  return {
    installId: budget.installId,
    release: `tars@${app.getVersion()}`,
    home: os.homedir(),
    os: {
      name: OS_NAMES[process.platform] ?? process.platform,
      version: typeof process.getSystemVersion === 'function' ? process.getSystemVersion() : os.release(),
    },
    electron: process.versions.electron ?? '',
  };
}

/**
 * Where reports go. A development run may point them at a stand-in
 * (DOROTHY_ERROR_REPORTS_DSN), for the proof against a fake Sentry; a packaged
 * Tars never reads it.
 */
function dsn(): string {
  const override = app.isPackaged ? undefined : process.env.DOROTHY_ERROR_REPORTS_DSN;
  return override || ERROR_REPORTS_DSN;
}

export function startErrorReports(isEnabled: () => boolean): { sync(): Promise<void> } {
  let starting: Promise<void> | undefined;
  const sync = (): Promise<void> => {
    if (starting) return starting;
    if (!isEnabled()) return Promise.resolve();
    starting = (async () => {
      try {
        const sentry = await import('@sentry/electron/main');
        const budget = new ReportBudget(path.join(DATA_DIR, 'error-reports.json'));
        sentry.init({
          ...errorReportOptions({
            dsn: dsn(),
            isEnabled,
            facts: () => facts(budget),
            budget,
            makeTransport: sentry.makeElectronTransport as never,
          }),
          defaultIntegrations: false,
          integrations: [
            sentry.onUncaughtExceptionIntegration(),
            sentry.onUnhandledRejectionIntegration(),
            sentry.linkedErrorsIntegration(),
          ],
          ipcMode: sentry.IPCMode.Classic,
          // Chromium would add the system's language to the request.
          transportOptions: { headers: { 'Accept-Language': 'en' } },
          skipOpenTelemetrySetup: true,
        } as never);
      } catch (err) {
        console.warn('[error-reports] could not start:', err instanceof Error ? err.message : err);
      }
    })();
    return starting;
  };
  void sync();
  return { sync };
}
