import { readClaudeData } from '@/hooks/useClaude';

/**
 * What a page reads, started while the pointer rests on its sidebar entry, so
 * the click finds it on its way or already in. Only what a store keeps is
 * started: Claude Code's data, which Usage, Projects, Extensions, Agents and
 * Settings read from one store (useClaude). A page without a store reads its
 * data again when it mounts, so starting it here would read it twice.
 *
 * readClaudeData reads only when the store holds nothing, or nothing fresher
 * than a poll, and shares a read already in flight: a rest never reads what the
 * store already has.
 */

/** Long enough that passing over an entry on the way to another starts nothing. */
export const HOVER_MS = 120;

const READS: Record<string, () => void> = {
  '/usage': () => { void readClaudeData(); },
  '/projects': () => { void readClaudeData(); },
  '/skills': () => { void readClaudeData(); },
  '/agents': () => { void readClaudeData(); },
  '/settings': () => { void readClaudeData(); },
};

let resting: ReturnType<typeof setTimeout> | null = null;

/** The pointer came onto an entry: its page's read starts once it has rested there. */
export function hoverStart(href: string): void {
  hoverEnd();
  const read = READS[href];
  if (!read) return;
  resting = setTimeout(() => {
    resting = null;
    read();
  }, HOVER_MS);
}

/** The pointer left the entry, or moved to another, before the read started. */
export function hoverEnd(): void {
  if (resting) clearTimeout(resting);
  resting = null;
}
