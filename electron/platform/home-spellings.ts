/**
 * How a home folder is written where it has to be found again: an error
 * report takes it out of every path and message it carries (the scrub of
 * electron/services/error-reports/report.ts).
 *
 * A macOS or Linux home has one spelling, `/Users/somebody`. A Windows home,
 * `C:\Users\somebody`, reaches an error in several: with forward slashes (a
 * file URL, an ES module's stack frame), with its backslashes doubled (a path
 * quoted in JSON), URL-encoded. And its user name is what follows its last
 * backslash, where the scrub took what follows the last `/`, which on Windows
 * was the whole path. Held by error-report-windows-home.test.ts.
 */

/** The other spellings of a Windows home; none for a POSIX one, whose scrub stays as it was. */
export function windowsHomeSpellings(home: string): string[] {
  if (!home.includes('\\')) return [];
  const forward = home.replace(/\\/g, '/');
  return [forward, home.replace(/\\/g, '\\\\'), encodeURIComponent(home), encodeURIComponent(forward)];
}

/** The user name a home ends with: its last part, after a `/` or, on Windows, a `\`. */
export function homeUserName(home: string): string {
  return home.split(home.includes('\\') ? /[\\/]/ : '/').filter(Boolean).pop() ?? '';
}
