/**
 * When a project or a session was last active, as the Projects page writes it:
 * Today, Yesterday, so many days ago within a week, then the month and day.
 * Null when the date is not known: a custom project Claude Code has not run in
 * has none (projects.json keeps bare paths, and fs:list-projects sends no
 * date), and the page printed `new Date('')` as "Invalid Date" on its card.
 * Its failures are listed, and pinned, in __tests__/lib/last-active.test.ts.
 */
export function lastActiveLabel(date: Date | string | number | null | undefined, now = new Date()): string | null {
  // new Date(null) is the epoch, a date nobody meant.
  if (date === null || date === undefined || date === '') return null;
  const at = new Date(date);
  if (Number.isNaN(at.getTime())) return null;
  const days = Math.floor((now.getTime() - at.getTime()) / 86_400_000);
  if (days === 0) return 'Today';
  if (days === 1) return 'Yesterday';
  if (days < 7) return `${days}d ago`;
  return at.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}
