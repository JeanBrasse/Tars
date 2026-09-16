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
 * Replies xterm sends to the PTY on its own, in answer to a query from the
 * program running there. They reach `onData` exactly like a keystroke, so every
 * terminal that forwards `onData` has to drop them.
 *
 * Every alternative matches a COMPLETE sequence, from the ESC to its final
 * byte. That is the whole point: the previous filter knew `\x1b[?...c` (DA1)
 * but not `\x1b[>...c` (DA2), and carried an unanchored `\d+;\d+c` rule meant
 * to mop up stray fragments. On xterm's DA2 reply `\x1b[>0;276;0c` that rule
 * matched `276;0c` in the middle and left the head `\x1b[>0;` behind, which was
 * then typed into the PTY as a truncated escape sequence. A rule that can match
 * part of a sequence manufactures fragments instead of removing them.
 *
 * Mouse reports are here too. `suppressMouseTracking` refuses the tracking
 * modes in the parser, but it passes mixed mode sets through on purpose, so a
 * report can still be produced; these panels never forward one.
 */
const TERMINAL_REPLIES = new RegExp([
  '\\x1b\\[\\?[0-9;]*c',        // DA1: \x1b[?1;2c
  '\\x1b\\[>[0-9;]*c',          // DA2: \x1b[>0;276;0c
  '\\x1b\\[\\?[0-9;]*\\$y',     // DECRPM: \x1b[?1;2$y
  '\\x1b\\[[0-9;]*R',           // CPR: \x1b[24;80R
  '\\x1b\\[[0-9;]*n',           // DSR: \x1b[0n
  '\\x1b\\[[IO]',               // focus in / focus out
  '\\x1b\\[<[0-9;]*[Mm]',       // SGR mouse report: \x1b[<35;48;1M
  '\\x1b\\[M[\\s\\S]{3}',       // X10 mouse report: \x1b[M + 3 bytes
  '\\x1bP[\\s\\S]*?\\x1b\\\\',  // DCS reply (XTVERSION, DECRQSS)
].join('|'), 'g');

/**
 * Remove the terminal's own replies from a chunk of `onData`, leaving whatever
 * the user actually typed. Returns '' when the chunk was nothing but replies.
 */
export function stripTerminalReplies(data: string): string {
  return data.replace(TERMINAL_REPLIES, '');
}

/**
 * DEC private modes a full-screen app sets to take the mouse over: 9 (X10),
 * 1000/1001/1002/1003 (tracking protocols) and 1005/1006/1015/1016 (report
 * encodings).
 */
const MOUSE_TRACKING_MODES = new Set([9, 1000, 1001, 1002, 1003, 1005, 1006, 1015, 1016]);

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
  term.parser.registerCsiHandler({ prefix: '?', final: 'h' }, params =>
    params.length > 0 &&
    params.every(p => typeof p === 'number' && MOUSE_TRACKING_MODES.has(p)),
  );
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
