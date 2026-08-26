import type { Terminal } from 'xterm';

/**
 * Strip Ink/ANSI cursor movement sequences that break during output replay.
 */
export function stripCursorSequences(data: string): string {
  return data
    .replace(/\x1b\[\d*[ABCDEFGH]/g, '')
    .replace(/\x1b\[\d*;\d*[Hf]/g, '')
    .replace(/\x1b\[\d*K/g, '')
    .replace(/\x1b\[\d*J/g, '')
    .replace(/\x1b\[?[su78]/g, '')
    .replace(/\x1b\[\?25[lh]/g, '')
    .replace(/\x1b\[\?1049[hl]/g, '');
}

/**
 * DEC private modes a full-screen app sets to take the mouse over: 9 (X10),
 * 1000/1001/1002/1003 (tracking protocols) and 1005/1006/1015/1016 (report
 * encodings).
 */
const MOUSE_TRACKING_MODES = new Set([9, 1000, 1001, 1002, 1003, 1005, 1006, 1015, 1016]);

/**
 * DEC private modes that swap the alternate screen buffer in: 47, 1047, and
 * 1049, which also saves and restores the cursor.
 */
const ALTERNATE_SCREEN_MODES = new Set([47, 1047, 1049]);

/**
 * A CSI handler that swallows the sequence when every mode in it is one of
 * `modes`. Mixed sets that also carry an unrelated mode are passed through
 * rather than dropped wholesale.
 */
function refuse(modes: Set<number>) {
  return (params: (number | number[])[]): boolean =>
    params.length > 0 && params.every(p => typeof p === 'number' && modes.has(p));
}

/**
 * Refuse the mouse-tracking DEC private modes.
 *
 * The failure: no panel in the board could scroll and no text could be
 * selected. Claude Code re-arms mouse tracking on nearly every redraw, so its
 * output is riddled with `\x1b[?1002h` / `\x1b[?1006h` and (because the tail is
 * all that survives) never with the matching `l` disables. Two ways in:
 * live output, and the stored transcript replayed when a panel mounts, which
 * armed mouse tracking on sessions that had exited long ago.
 *
 * Once xterm honours those, it calls `selectionService.disable()` and takes the
 * wheel over to encode it as a mouse report - so the viewport never scrolls,
 * nothing is selectable, and the reports go out to the pty as stray
 * `\x1b[<35;48;1M` text. These panels are a monitoring board, not a full
 * emulator: scrollback and selection are worth more here than app-side mouse
 * support, so the modes are swallowed in the parser.
 *
 * Registered handlers run before the built-in one and `true` stops the
 * sequence, so the mode is never set. Mixed sets that also carry an unrelated
 * mode are passed through rather than dropped wholesale.
 */
export function suppressMouseTracking(term: Terminal): void {
  term.parser.registerCsiHandler({ prefix: '?', final: 'h' }, refuse(MOUSE_TRACKING_MODES));
}

/**
 * Refuse the alternate screen buffer.
 *
 * Claude Code sends `\x1b[?1049h` in its first frame and never sends the
 * matching `l` for the life of the session. The alternate buffer has no
 * scrollback by definition, and xterm reads that as licence to turn the wheel
 * into cursor keys aimed at the pty, so a panel sitting in it does not scroll
 * at all: the wheel goes to the CLI as arrow presses instead.
 *
 * It read as intermittent because a panel only lands there when the retained
 * output it replays on mount still carries that first frame. The store keeps
 * the last few hundred chunks, so a chatty agent has already dropped it and
 * mounts into the normal buffer, where the wheel works; a quiet or freshly
 * started one has not. Going fullscreen appeared to repair it because it
 * rebuilds the panel around a newer tail, and a second toggle was sometimes
 * needed because the first tail still had the sequence in it. The state is the
 * emulator's, never the pty's, which is why the pty never had to be restarted.
 *
 * The `l` is refused with the `h`, or leaving a buffer that was never entered
 * would restore a cursor nobody saved.
 */
export function suppressAlternateScreen(term: Terminal): void {
  term.parser.registerCsiHandler({ prefix: '?', final: 'h' }, refuse(ALTERNATE_SCREEN_MODES));
  term.parser.registerCsiHandler({ prefix: '?', final: 'l' }, refuse(ALTERNATE_SCREEN_MODES));
}

/**
 * Install the terminal's custom key handler. xterm keeps exactly one, so every
 * key this app claims has to live here:
 *
 * - Shift+Enter inserts a literal newline (bracketed paste) instead of
 *   submitting the current line.
 * - Cmd/Ctrl+C copies the selection. There was no copy path at all: xterm
 *   paints its selection itself rather than making a DOM Selection, so the
 *   native copy had nothing to take and Cmd+C left the clipboard untouched.
 *   With no selection it falls through, which keeps Ctrl+C as interrupt.
 *
 * @param term     - The xterm Terminal instance
 * @param sendFn   - Callback that forwards the escape sequence to the PTY/agent
 */
export function attachShiftEnterHandler(
  term: Terminal,
  sendFn: (data: string) => void,
): void {
  term.attachCustomKeyEventHandler((event) => {
    if (event.type !== 'keydown') return true;

    if (event.key === 'Enter' && event.shiftKey) {
      // Use bracket paste mode to insert a literal newline without submitting
      sendFn('\x1b[200~\n\x1b[201~');
      return false;
    }

    const copyChord = event.metaKey || (event.ctrlKey && event.shiftKey);
    if (copyChord && (event.key === 'c' || event.key === 'C') && term.hasSelection()) {
      navigator.clipboard?.writeText(term.getSelection()).catch(() => {});
      return false;
    }

    return true;
  });
}
