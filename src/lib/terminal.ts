import type { Terminal } from '@xterm/xterm';

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
 * The DEC private modes that hand the mouse to the application: 9 (X10) and
 * 1000/1001/1002/1003, the tracking protocols. The report encodings
 * (1005/1006/1015/1016) only change the wire format of a report, so they say
 * nothing about who owns the mouse and are deliberately not listed.
 */
const MOUSE_TRACKING_MODES = new Set([9, 1000, 1001, 1002, 1003]);

const DOM_DELTA_LINE = 1;
const DOM_DELTA_PAGE = 2;
/** Only reached before the terminal has been opened and measured. */
const FALLBACK_ROW_HEIGHT_PX = 17;

/** How many rows one wheel event should move, in the units the browser sent. */
function wheelRows(term: Terminal, event: WheelEvent): number {
  if (event.deltaMode === DOM_DELTA_LINE) return event.deltaY;
  if (event.deltaMode === DOM_DELTA_PAGE) return event.deltaY * term.rows;
  const rowHeight = (term.element?.clientHeight ?? 0) / Math.max(term.rows, 1);
  return event.deltaY / (rowHeight > 0 ? rowHeight : FALLBACK_ROW_HEIGHT_PX);
}

/**
 * Let the CLI have the mouse, and keep the wheel and the selection anyway.
 *
 * Claude Code re-arms mouse tracking on nearly every redraw, so its output is
 * riddled with `\x1b[?1002h` and, because only the tail of a transcript
 * survives, never with the matching `l` disables. Honouring that is what a
 * terminal is supposed to do, and it is what makes a click place the cursor in
 * the line you are typing. The cost is that xterm then encodes the wheel as a
 * mouse report and calls `selectionService.disable()`, which is why this used
 * to swallow the modes outright: the board could scroll and select, but a click
 * did nothing and long messages could only be edited with the arrow keys.
 *
 * All three are kept instead:
 *
 * - the modes are observed rather than refused, so the application really does
 *   get the mouse and a click lands where you clicked;
 * - the wheel is taken back while tracking is armed and turned into a scroll of
 *   our own, so the scrollback still moves and no `\x1b[<35;48;1M` goes out;
 * - `macOptionClickForcesSelection` keeps normal selection under Option, which
 *   is xterm's own escape hatch for exactly this (it is how selection works
 *   inside tmux with mouse mode on).
 *
 * A CSI handler returning `false` means "not handled": the sequence carries on
 * to the built-in handler and the mode is set as the application asked. That is
 * also why a mixed set like `\x1b[?25;1002h` needs no special case any more.
 * Nothing here depends on the tracking mode ever being disabled, which matters
 * because Claude Code never disables it.
 */
export function attachMouseHandling(term: Terminal): void {
  let applicationOwnsMouse = false;

  const observe = (final: 'h' | 'l', owned: boolean) => {
    term.parser.registerCsiHandler({ prefix: '?', final }, params => {
      if (params.some(p => typeof p === 'number' && MOUSE_TRACKING_MODES.has(p))) {
        applicationOwnsMouse = owned;
      }
      return false;
    });
  };
  observe('h', true);
  observe('l', false);

  term.options.macOptionClickForcesSelection = true;

  // Fractions are carried rather than dropped: a trackpad sends a few pixels at
  // a time, and truncating each event on its own would ignore a slow scroll
  // entirely.
  let carriedRows = 0;
  term.attachCustomWheelEventHandler(event => {
    if (!applicationOwnsMouse) return true;
    const rows = wheelRows(term, event) + carriedRows;
    const whole = Math.trunc(rows);
    carriedRows = rows - whole;
    if (whole !== 0) term.scrollLines(whole);
    return false;
  });
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
