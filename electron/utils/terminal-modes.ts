/**
 * The terminal modes a replay of kept output has to start in.
 *
 * `agent.output` keeps the last chunks of a PTY stream, and a panel that mounts
 * writes them into a fresh terminal. A full screen CLI sets its modes once and
 * then only repaints: Claude Code 2.1.273 with `"tui": "fullscreen"` asks for
 * the alternate screen and the mouse at start, on a resize and when input
 * reaches it, and never during a turn. After a long turn with no input the
 * chunks that asked were trimmed away, so a panel mounted then replayed a
 * repaint onto the normal screen with no mouse request, and the wheel sent
 * Claude nothing until the next key or resize.
 *
 * So what is trimmed is read for the state it left the terminal in, and that
 * state goes back in front of what is kept. Since core/terminal-mirror.ts a
 * Dashboard panel, the Agents window and the tray are handed the screen
 * itself, and this carry serves the replays that remain: an agent terminal
 * with no mirror, and the quick terminal's own buffer, which imports it. A
 * state and not a list, because
 * xterm 5.3 holds one active screen, one mouse protocol and one mouse encoding:
 * a later request replaces an earlier one, any reset in a group clears it, and
 * a mode set then reset must not come back (InputHandler.setModePrivate and
 * resetModePrivate in xterm's sources).
 */

/** The modes a replay depends on, as xterm 5.3 holds them. 0 is off. */
export interface TerminalModes {
  /** 47, 1047 or 1049, whichever switched to the alternate screen last. */
  screen: number;
  /** 9, 1000, 1002 or 1003. */
  mouse: number;
  /** 1006 or 1016. */
  encoding: number;
  /** 2004: a paste reaches the program wrapped, not as typed lines. */
  bracketedPaste: boolean;
  /** 1004. */
  focusEvents: boolean;
  /** 1: arrow keys as ESC O A rather than ESC [ A. */
  applicationCursor: boolean;
  /** 25, reset. */
  cursorHidden: boolean;
}

export const DEFAULT_TERMINAL_MODES: Readonly<TerminalModes> = Object.freeze({
  screen: 0,
  mouse: 0,
  encoding: 0,
  bracketedPaste: false,
  focusEvents: false,
  applicationCursor: false,
  cursorHidden: false,
});

/** DECSET and DECRST (CSI ? Pm h or l, with a 7 or 8 bit CSI), DECSTR (CSI ! p) and RIS (ESC c). */
const MODE_SEQUENCE = /(?:\x1b\[|\x9b)(?:\?([0-9;]*)([hl])|!p)|\x1bc/g;

/** The modes after `text`, starting from `from`. */
export function terminalModesAfter(text: string, from: Readonly<TerminalModes> = DEFAULT_TERMINAL_MODES): TerminalModes {
  const modes = { ...from };
  for (const [sequence, params, final] of text.matchAll(MODE_SEQUENCE)) {
    if (sequence === '\x1bc') {
      // xterm 5.3 resets everything here except the hidden cursor, which only
      // 25 and DECSTR change: the replay has to match what the panel shows.
      Object.assign(modes, DEFAULT_TERMINAL_MODES, { cursorHidden: modes.cursorHidden });
      continue;
    }
    if (final === undefined) {
      // DECSTR clears the DEC private modes and shows the cursor, and leaves
      // the screen and the mouse as they are.
      Object.assign(modes, { bracketedPaste: false, focusEvents: false, applicationCursor: false, cursorHidden: false });
      continue;
    }
    const set = final === 'h';
    for (const param of params.split(';')) {
      const mode = Number(param);
      switch (mode) {
        case 47: case 1047: case 1049: modes.screen = set ? mode : 0; break;
        case 9: case 1000: case 1002: case 1003: modes.mouse = set ? mode : 0; break;
        case 1006: case 1016: modes.encoding = set ? mode : 0; break;
        case 2004: modes.bracketedPaste = set; break;
        case 1004: modes.focusEvents = set; break;
        case 1: modes.applicationCursor = set; break;
        case 25: modes.cursorHidden = !set; break;
      }
    }
  }
  return modes;
}

/**
 * The sequences that put a fresh terminal in `modes`, and nothing for the
 * defaults. One sequence per mode: the renderer swallows a mouse request only
 * when every mode in it is a mouse mode, so a mixed one would hand the mouse
 * to xterm itself.
 */
export function writeTerminalModes(modes: Readonly<TerminalModes>): string {
  const sequences: string[] = [];
  for (const mode of [modes.screen, modes.mouse, modes.encoding]) {
    if (mode) sequences.push(`\x1b[?${mode}h`);
  }
  if (modes.bracketedPaste) sequences.push('\x1b[?2004h');
  if (modes.focusEvents) sequences.push('\x1b[?1004h');
  if (modes.applicationCursor) sequences.push('\x1b[?1h');
  if (modes.cursorHidden) sequences.push('\x1b[?25l');
  return sequences.join('');
}

/** An escape sequence begun but not finished at the end of a text: its end is in the next chunk. */
const OPEN_SEQUENCE = /(?:\x1b(?:\[[\x30-\x3f]*[\x20-\x2f]*)?|\x9b[\x30-\x3f]*[\x20-\x2f]*)$/;

/**
 * The chunk to put in front of what is kept when `trimmed` is dropped: the
 * modes the trimmed chunks left set, then any sequence they leave unfinished,
 * whose end starts the kept chunks. Empty when there is neither.
 */
export function carriedByTrim(trimmed: readonly string[]): string {
  const text = trimmed.join('');
  const open = OPEN_SEQUENCE.exec(text)?.[0] ?? '';
  return writeTerminalModes(terminalModesAfter(text.slice(0, text.length - open.length))) + open;
}
