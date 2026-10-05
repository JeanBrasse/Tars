import { describe, it, expect } from 'vitest';
import { lastPlainLines } from '../../src/lib/plain-lines';

/**
 * The last lines of an agent's terminal as plain text: what a completed Kanban
 * task keeps as its summary, and shows in a <pre> (KanbanDoneSummary). It is
 * made from what agent:get hands back, which is the terminal's screen
 * serialized by the mirror (escape codes included, scrollback with it) when
 * the terminal is there, and the kept tail of the raw stream otherwise. The
 * Audit's Low at #319's gate: `output.slice(-50).join('')` kept the whole
 * serialized screen, about 170 KB in each completed task, 900 KB once the
 * mirror keeps 5,000 lines. Written before the code. How it can fail:
 * 1. escape codes kept: the screen opens with RIS and carries colours, mode
 *    sets and the cursor put back at the end; a raw chunk carries erase and
 *    cursor moves;
 * 2. a word drawn after a cursor move is glued to the word before it: the
 *    serialize addon writes a run of empty cells as `ESC [ n C`, which is a
 *    space on screen;
 * 3. an OSC or a DCS string leaks its text: a window title, a hyperlink's
 *    address, xterm's version;
 * 4. a control or a format character reaches the <pre>: a BEL, a backspace, a
 *    NUL, DEL, a C1 control, a zero width space, or a U+202E that turns the
 *    lines after it around;
 * 5. a line redrawn after a carriage return (a spinner, a progress bar) gives
 *    every frame, or the first, where the screen shows the last;
 * 6. the count: more than the last lines asked for; or counted with the blank
 *    rows the screen ends on under the prompt, which leaves nothing; or a
 *    sequence cut between two chunks leaves its halves in the text;
 * 7. a line that never ends (a minified file printed, a progress bar redrawn
 *    with no carriage return) keeps the summary as large as before;
 * 8. nothing printable gives a blank summary, where the caller keeps its own
 *    sentence.
 */

const ESC = '\x1b';

describe('what is kept is what the screen shows', () => {
  it('drops the escape codes of a serialized screen and keeps its text (1)', () => {
    const screen = `${ESC}c${ESC}[0m${ESC}[32m✓ 42 tests passed${ESC}[0m\r\n${ESC}[1mDone${ESC}[22m in 3.1 s\r\n\r\n${ESC}[?1006h${ESC}[?25h${ESC}[3;1H`;
    expect(lastPlainLines([screen])).toBe('✓ 42 tests passed\nDone in 3.1 s');
  });

  it('drops a raw stream\'s erase and cursor moves (1)', () => {
    const out = lastPlainLines([`${ESC}[2K${ESC}[1G${ESC}[?2004hready${ESC}[K\r\n${ESC}7${ESC}(Bdone${ESC}8\r\n`]);
    expect(out).toBe('ready\ndone');
  });

  it('a run of empty cells is the spaces the screen shows (2)', () => {
    expect(lastPlainLines([`Read${ESC}[3Cfile${ESC}[1Cdone`])).toBe('Read   file done');
    expect(lastPlainLines([`a${ESC}[Cb`])).toBe('a b');
  });

  it('a title, a link\'s address and a device string say nothing (3)', () => {
    const out = lastPlainLines([
      `${ESC}]0;claude: working\x07see ${ESC}]8;;https://example.com/x${ESC}\\the docs${ESC}]8;;${ESC}\\\r\n`,
      `${ESC}P>|xterm.js(5.3.0)${ESC}\\ok\r\n`,
    ]);
    expect(out).toBe('see the docs\nok');
  });

  it('no control and no character that hides or turns text reaches the summary (4)', () => {
    const out = lastPlainLines([`ding\x07 back\b\bspace\x00 del\x7f c1\x9b end\r\nab\u202Ecd\u200Bef\u2028gh\r\n\tindented`]);
    expect(out).not.toMatch(/[\x00-\x08\x0b-\x1f\x7f-\x9f\u200B\u202E\u2028]/);
    expect(out.split('\n')).toEqual(['ding  back  space  del  c1  end', 'ab cd ef gh', '\tindented']);
  });

  it('a line redrawn after a carriage return is its last drawing (5)', () => {
    expect(lastPlainLines(['Building 10%\rBuilding 55%\rBuilding 100%\r\n'])).toBe('Building 100%');
    expect(lastPlainLines(['abcdef\rXY'])).toBe('XYcdef');
    expect(lastPlainLines(['⠋ Working\r⠙ Working\r\nnext'])).toBe('⠙ Working\nnext');
  });
});

describe('how much is kept', () => {
  const numbered = (n: number) => Array.from({ length: n }, (_, i) => `line ${i + 1}`).join('\r\n');

  it('the last 50 lines, counted from the last one with something on it (6)', () => {
    const out = lastPlainLines([`${numbered(120)}\r\n${'\r\n'.repeat(30)}${ESC}[?25h${ESC}[40;1H`]).split('\n');
    expect(out).toHaveLength(50);
    expect(out[0]).toBe('line 71');
    expect(out[49]).toBe('line 120');
    expect(lastPlainLines([numbered(10)], 3)).toBe('line 8\nline 9\nline 10');
  });

  it('a sequence cut between two chunks goes whole (6)', () => {
    expect(lastPlainLines([`abc${ESC}[3`, `2mdef${ESC}`, `[0m`])).toBe('abcdef');
  });

  it('a line that never ends is cut, so the summary stays small (7)', () => {
    const out = lastPlainLines([`${'x'.repeat(100_000)}\r\nshort`]);
    const [long, short] = out.split('\n');
    expect([...long].length).toBeLessThanOrEqual(500);
    expect(long.endsWith('…')).toBe(true);
    expect(short).toBe('short');
  });

  it('a whole screen with its scrollback comes down to a few kilobytes (1, 7)', () => {
    const row = (i: number) => `${ESC}[38;5;${i % 255}m${'█'.repeat(40)}${ESC}[3Cline ${i}${ESC}[0m`;
    const screen = `${ESC}c${Array.from({ length: 5000 }, (_, i) => row(i)).join('\r\n')}${ESC}[?25h${ESC}[24;1H`;
    expect(screen.length).toBeGreaterThan(250_000);
    const out = lastPlainLines([screen]);
    expect(out.split('\n')).toHaveLength(50);
    expect(out.length).toBeLessThan(5_000);
    expect(out.split('\n')[49]).toBe(`${'█'.repeat(40)}   line 4999`);
  });

  it('nothing printable is an empty summary (8)', () => {
    expect(lastPlainLines([`${ESC}c${ESC}[?25h\r\n  \r\n${ESC}[1;1H`])).toBe('');
    expect(lastPlainLines([])).toBe('');
  });
});
