/**
 * The parts of `Dropdown` that are not React.
 *
 * Kept in a plain module so they can be unit tested: vitest runs in a node
 * environment here, with no DOM to render a component into.
 */

export interface DropdownItem {
  value: string;
  label: string;
  hint?: string;
  disabled?: boolean;
}

/**
 * Which options survive the filter field.
 *
 * The hint is matched as well as the label, because that is where the useful
 * words live: a model's row reads "claude-opus-5" with "1M context - $5/M in"
 * as its hint, so typing "1M" has to find it.
 */
export function filterOptions<T extends DropdownItem>(options: T[], query: string): T[] {
  const q = query.trim().toLowerCase();
  if (q === '') return options;
  return options.filter(o =>
    o.label.toLowerCase().includes(q) || (o.hint?.toLowerCase().includes(q) ?? false),
  );
}

/**
 * Where the highlight lands after one Up or Down.
 *
 * Wraps at both ends, the way a native select does, and steps over disabled
 * rows rather than parking on one. Returns -1 when there is nothing to land on,
 * which is the case for an empty list and for a list that is entirely disabled:
 * without the second guard the search for the next enabled row would circle the
 * list forever.
 */
export function stepIndex<T extends DropdownItem>(
  options: T[],
  from: number,
  direction: 1 | -1,
): number {
  if (options.length === 0) return -1;
  let next = from;
  for (let i = 0; i < options.length; i++) {
    next = (next + direction + options.length) % options.length;
    if (!options[next].disabled) return next;
  }
  return -1;
}

/**
 * Where the highlight starts when the panel opens: on the current value, so
 * Up and Down move from where the user already is. Falls back to the first row
 * that can be chosen when the value is absent from the list, which happens
 * while a filter is narrowing it.
 */
export function initialIndex<T extends DropdownItem>(options: T[], value: string): number {
  const onValue = options.findIndex(o => o.value === value);
  if (onValue >= 0) return onValue;
  return options.findIndex(o => !o.disabled);
}
