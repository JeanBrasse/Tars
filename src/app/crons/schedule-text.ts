/**
 * Turning a Hermes schedule into text.
 *
 * The failure this page shipped with: `{job.schedule_human || job.schedule}`
 * put Hermes' `schedule` field straight into JSX. Hermes does not send a string
 * there - it sends an object, e.g.
 * `{"kind":"cron","expr":"0 2 * * *","display":"0 2 * * *"}` (and
 * `{"kind":"interval",...,"display":"every 30m"}` for interval jobs).
 * Rendering an object as a React child throws React error #31 out of the render
 * pass, and that uncaught throw during hydration of the statically exported
 * page tore the document down before any error boundary existed - so Chromium,
 * not React, painted "This page couldn't load. Reload to try again, or go
 * back." That is why the crash looked like a navigation failure rather than a
 * React error, and why hardening date formatting did not touch it.
 *
 * Rule: JSX only ever gets a string out of here, whatever shape the gateway is
 * in today.
 */

/** What Hermes actually sends for `schedule`. It is not a string. */
export interface CronSchedule {
  kind?: string;
  expr?: string;
  display?: string;
}

export interface ScheduleFields {
  schedule?: string | CronSchedule | null;
  schedule_display?: string | null;
  schedule_human?: string | null;
}

export function formatSchedule(job: ScheduleFields): string {
  const candidates: unknown[] = [job.schedule_human, job.schedule_display, job.schedule];
  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate.trim() !== '') return candidate;
    if (candidate && typeof candidate === 'object') {
      const obj = candidate as Record<string, unknown>;
      for (const key of ['display', 'human', 'expr', 'cron']) {
        const value = obj[key];
        if (typeof value === 'string' && value.trim() !== '') return value;
      }
    }
  }
  return 'no schedule';
}
