/**
 * For `memo`, on a row drawn from data the page rebuilds on every read: the
 * room's agents are joined again on every tick, a thread's items on every
 * delivery. Two props are the same when they are the same value or, for an
 * object, when both serialise alike, so only the rows whose content moved
 * render again (the Audit's early look at #165: ten ticks rendered 330 team
 * rows and 297 messages).
 *
 * Only for props that are data or stable callbacks. A React element would be
 * serialised too, and a callback that is new on every render is never the same.
 */
export function sameProps<P extends object>(a: P, b: P): boolean {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]) as Set<keyof P>;
  for (const key of keys) {
    const x = a[key];
    const y = b[key];
    if (Object.is(x, y)) continue;
    if (typeof x !== 'object' || typeof y !== 'object' || x === null || y === null) return false;
    if (JSON.stringify(x) !== JSON.stringify(y)) return false;
  }
  return true;
}
