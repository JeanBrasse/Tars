/**
 * Whether this platform's build may send error reports at all.
 *
 * The reports go to the project's Sentry (electron/services/error-reports),
 * which has not agreed to receive a Windows build's. So on win32 they are
 * off and the Settings row is hidden, whatever `errorReportsEnabled` says: a
 * settings file edited by hand, or copied from a Mac, starts nothing. darwin
 * and linux are unchanged.
 * The renderer holds the same line in src/lib/error-reports.ts
 * (errorReportsOffered), which cannot import this file.
 */
export function errorReportsAvailable(platform: NodeJS.Platform = process.platform): boolean {
  return platform !== 'win32';
}
