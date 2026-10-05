/**
 * The last lines of a terminal as plain text, as a person reads them on its
 * screen: what a completed Kanban task keeps as its summary. agent:get hands
 * back the terminal's screen serialized by the main process's mirror (escape
 * codes and scrollback included, core/terminal-mirror.ts) while the terminal
 * is there, and the kept tail of the raw stream otherwise; either way the text
 * is in between escape codes. Its failures are listed, and pinned, in
 * __tests__/lib/plain-lines.test.ts.
 */

/** Longest line kept, in code points: a line that never ends would keep the summary as large as the screen. */
const MAX_LINE = 500;

/** OSC, DCS, SOS, PM and APC strings, ended by BEL or ST: a title, a link's address, a device's answer. */
const STRING_SEQUENCE = /\x1b[\]P^_X][\s\S]*?(?:\x07|\x1b\\)/g;
/** A control sequence: parameters, intermediates, final byte. */
const CONTROL_SEQUENCE = /\x1b\[([0-?]*)[ -/]*[@-~]/g;
/** Any other escape: a charset, a cursor saved or restored, a reset. */
const ESCAPE = /\x1b[ -/]*[0-~]/g;
/** A sequence the text ends in the middle of. */
const CUT_AT_THE_END = /\x1b(?:\[[0-?]*[ -/]*|[\]P^_X][\s\S]*)?$/;
/** Controls but tab (line feed and carriage return are read before), and what hides, turns or breaks text. */
const FLATTENED = /[\x00-\x08\x0b-\x1f\x7f-\x9f\p{Cf}\p{Zl}\p{Zp}]/gu;

/** What a line redrawn after carriage returns shows: each drawing over the one before, from the left. */
function lastDrawing(line: string): string {
  if (!line.includes('\r')) return line;
  let shown: string[] = [];
  for (const part of line.split('\r')) {
    const drawn = [...part];
    shown = drawn.concat(shown.slice(drawn.length));
  }
  return shown.join('');
}

function capped(line: string): string {
  const points = [...line];
  return points.length > MAX_LINE ? `${points.slice(0, MAX_LINE - 1).join('')}…` : line;
}

/**
 * The last `count` lines with something on them, joined by line feeds; ''
 * when nothing on the screen can be read. The serialize addon writes a run of
 * empty cells as a cursor move forward (`ESC [ n C`), which is a run of spaces
 * on screen and is kept as one; every other sequence goes.
 */
export function lastPlainLines(chunks: string[], count = 50): string {
  const text = chunks.join('')
    .replace(STRING_SEQUENCE, '')
    .replace(CONTROL_SEQUENCE, (sequence, params: string) => (
      sequence.endsWith('C') ? ' '.repeat(Math.min(Math.max(parseInt(params, 10) || 1, 1), MAX_LINE)) : ''
    ))
    // Before the escapes, which would take its first two characters and leave the rest as text.
    .replace(CUT_AT_THE_END, '')
    .replace(ESCAPE, '');
  const lines = text.replace(/\r\n/g, '\n').split('\n')
    .map(line => capped(lastDrawing(line).replace(FLATTENED, ' ').trimEnd()));
  while (lines.length > 0 && lines[lines.length - 1].trim() === '') lines.pop();
  return lines.slice(-count).join('\n');
}
