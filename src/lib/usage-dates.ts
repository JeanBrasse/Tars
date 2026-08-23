/**
 * `YYYY-MM-DD` in the machine's own timezone.
 *
 * The per-day keys the Usage page looks costs up by are local dates, written by
 * localDateKey() in electron/services/transcript-usage.ts. Building a chart
 * bucket key with toISOString() instead reads the UTC date off a Date that was
 * constructed at local midnight, which east of Greenwich is the day before:
 * every bar carried the previous day's spend under the current day's label, and
 * disagreed with the latest-day card, which looks its own key up directly.
 *
 * The renderer cannot import the main process copy, so the two agree by having
 * the same definition rather than the same code.
 */
export function localDayKey(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}
