import { describe, it, expect, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import type { Terminal } from 'xterm';
import { suppressMouseTracking, attachShiftEnterHandler, stripTerminalReplies } from '@/lib/terminal';

/**
 * The board's panels could not scroll and could not be selected because the
 * replayed Claude Code transcript is full of `\x1b[?1002h` / `\x1b[?1006h` and
 * carries no matching disables. xterm honours those, disables its selection
 * service and swallows the wheel to encode it as a mouse report.
 *
 * These tests drive the two pieces of the fix through a stub terminal, since
 * vitest runs in a node environment and xterm needs a document.
 */

type CsiId = { prefix?: string; final: string };
type CsiHandler = (params: (number | number[])[]) => boolean | Promise<boolean>;

function stubTerminal() {
  const csi: Array<{ id: CsiId; handler: CsiHandler }> = [];
  let keyHandler: ((e: KeyboardEvent) => boolean) | null = null;
  const term = {
    parser: {
      registerCsiHandler: (id: CsiId, handler: CsiHandler) => {
        csi.push({ id, handler });
        return { dispose: () => {} };
      },
    },
    attachCustomKeyEventHandler: (h: (e: KeyboardEvent) => boolean) => { keyHandler = h; },
    hasSelection: () => true,
    getSelection: () => 'selected text',
  };
  return {
    term: term as unknown as Terminal,
    csi,
    key: (e: Partial<KeyboardEvent>) => keyHandler!({ type: 'keydown', ...e } as KeyboardEvent),
  };
}

describe('suppressMouseTracking', () => {
  it('registers on DEC private mode set', () => {
    const { term, csi } = stubTerminal();
    suppressMouseTracking(term);
    expect(csi).toHaveLength(1);
    expect(csi[0].id).toEqual({ prefix: '?', final: 'h' });
  });

  it('swallows the modes that kill scrollback and selection', () => {
    const { term, csi } = stubTerminal();
    suppressMouseTracking(term);
    const handled = csi[0].handler;

    // Every protocol and encoding Claude Code sets.
    for (const mode of [9, 1000, 1001, 1002, 1003, 1005, 1006, 1015, 1016]) {
      expect(handled([mode])).toBe(true);
    }
    // Combined set, still all mouse modes.
    expect(handled([1002, 1006])).toBe(true);
  });

  it('lets every unrelated private mode through', () => {
    const { term, csi } = stubTerminal();
    suppressMouseTracking(term);
    const handled = csi[0].handler;

    // Cursor visibility, alt screen, bracketed paste, focus reporting,
    // application cursor keys, wraparound.
    for (const mode of [1, 7, 25, 1004, 1049, 2004]) {
      expect(handled([mode])).toBe(false);
    }
    // A mixed set keeps its unrelated mode rather than being dropped wholesale.
    expect(handled([1002, 25])).toBe(false);
    expect(handled([])).toBe(false);
  });
});

describe('terminal key handler', () => {
  it('copies the selection on Cmd+C instead of sending it to the pty', () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal('navigator', { clipboard: { writeText } });

    const { term, key } = stubTerminal();
    const send = vi.fn();
    attachShiftEnterHandler(term, send);

    expect(key({ key: 'c', metaKey: true })).toBe(false);
    expect(writeText).toHaveBeenCalledWith('selected text');
    expect(send).not.toHaveBeenCalled();

    vi.unstubAllGlobals();
  });

  it('leaves Ctrl+C alone so it still interrupts', () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal('navigator', { clipboard: { writeText } });

    const { term, key } = stubTerminal();
    attachShiftEnterHandler(term, vi.fn());

    expect(key({ key: 'c', ctrlKey: true })).toBe(true);
    expect(writeText).not.toHaveBeenCalled();

    vi.unstubAllGlobals();
  });

  it('still inserts a newline on Shift+Enter', () => {
    const { term, key } = stubTerminal();
    const send = vi.fn();
    attachShiftEnterHandler(term, send);

    expect(key({ key: 'Enter', shiftKey: true })).toBe(false);
    expect(send).toHaveBeenCalledWith('\x1b[200~\n\x1b[201~');
  });
});

/**
 * The terminal's own replies, which are not keystrokes.
 *
 * xterm answers the CLI's queries through onData exactly like typing, so every
 * panel that forwards onData has to drop them. What made this worth a shared
 * function is the shape of the old filter rather than a missing pattern: it
 * knew DA1 and not DA2, and its unanchored `\d+;\d+c` rule then matched
 * `276;0c` inside the DA2 reply and left the head behind. A rule that can match
 * part of a sequence manufactures fragments instead of removing them.
 */
const DA1 = '\x1b[?1;2c';
const DA2 = '\x1b[>0;276;0c';
const DSR = '\x1b[0n';
const CPR = '\x1b[24;80R';
const DECRPM = '\x1b[?1;2$y';
const FOCUS_IN = '\x1b[I';
const FOCUS_OUT = '\x1b[O';
const MOUSE_SGR = '\x1b[<35;48;1M';
const MOUSE_X10 = '\x1b[M' + String.fromCharCode(32, 33, 34);
const DCS = '\x1bP>|xterm 5.3\x1b\\';

describe('stripTerminalReplies', () => {
  it('removes the DA2 reply whole, which is the one that used to be cut in half', () => {
    expect(stripTerminalReplies(DA2)).toBe('');
  });

  it.each([
    ['DA1', DA1], ['DA2', DA2], ['DSR', DSR], ['CPR', CPR], ['DECRPM', DECRPM],
    ['focus in', FOCUS_IN], ['focus out', FOCUS_OUT],
    ['SGR mouse report', MOUSE_SGR], ['X10 mouse report', MOUSE_X10], ['DCS reply', DCS],
  ])('leaves nothing behind for a %s reply', (_name, reply) => {
    expect(stripTerminalReplies(reply)).toBe('');
  });

  it('removes a burst of replies that arrived in one chunk', () => {
    // What a panel really receives when a CLI queries everything at startup.
    expect(stripTerminalReplies(DA1 + DA2 + DSR + FOCUS_IN)).toBe('');
  });

  it('keeps the keystroke that shared a chunk with a reply', () => {
    // The reply and the first thing typed after it can arrive together, and
    // dropping the whole chunk would swallow real input.
    expect(stripTerminalReplies(DA2 + 'ls -la\r')).toBe('ls -la\r');
    expect(stripTerminalReplies('ls' + DSR + ' -la\r')).toBe('ls -la\r');
  });
});

/**
 * The control. Without it this file would only describe the code as it is now,
 * and a filter that never loses a prompt proves nothing about one that did.
 */
describe('the filter as it was written before, kept here as the control', () => {
  /** Verbatim from the four copies that 0652c15 replaced. */
  function oldFilter(data: string): string {
    if (/^(\x1b\[\?[\d;]*c|\d+;\d+c)+$/.test(data)) return '';
    return data
      .replace(/\x1b\[\?[\d;]*c/g, '')
      .replace(/\x1b\[\d+;\d+R/g, '')
      .replace(/\x1b\[(?:I|O)/g, '')
      .replace(/\d+;\d+c/g, '');
  }

  it('cut the DA2 reply in half and typed the head into the pty', () => {
    // The defect, exactly: `276;0c` matched in the middle, `\x1b[>0;` left over.
    expect(oldFilter(DA2)).toBe('\x1b[>0;');
    expect(stripTerminalReplies(DA2)).toBe('');
  });

  it('sent the DSR reply through whole, which nobody had noticed', () => {
    expect(oldFilter(DSR)).toBe(DSR);
    expect(stripTerminalReplies(DSR)).toBe('');
  });

  it('ate a number pair out of something a person typed', () => {
    // The other half of an unanchored rule: it also bites real text.
    const typed = 'grep -n "276;0c" notes.txt\r';
    expect(oldFilter(typed)).not.toBe(typed);
    expect(stripTerminalReplies(typed)).toBe(typed);
  });
});

describe('what a person types reaches the pty untouched', () => {
  it.each([
    ['a command and its newline', 'ls -la\r'],
    ['quotes, colons and semicolons', 'git commit -m "fix: drop 1;2c from the notes"\r'],
    ['an arrow key', '\x1b[A'],
    ['control C', '\x03'],
    ['a bracketed paste over two lines', '\x1b[200~first line\nsecond line\x1b[201~'],
    ['accents and an emoji', 'echo "resume termine, 100% ok"\r'],
    ['a tab completion request', 'npm run e\t'],
    ['a backspace', '\x7f'],
  ])('%s', (_name, typed) => {
    expect(stripTerminalReplies(typed)).toBe(typed);
  });
});

/**
 * The class, not the site.
 *
 * The filter was copied into four terminals and every copy carried the same
 * defect, so the fix is only finished if no copy is left to drift. These read
 * the shipped sources rather than a fixture.
 */
describe('no terminal keeps a filter of its own', () => {
  const FORWARDERS = [
    'src/components/TerminalsView/hooks/useMultiTerminal.ts',
    'src/components/AgentWorld/useQuickTerminal.ts',
    'src/components/AgentWorld/useAgentDialogTerminal.ts',
    'src/components/TrayPanel/useTrayTerminal.ts',
  ];

  it.each(FORWARDERS)('%s forwards through the shared filter', (file) => {
    const source = fs.readFileSync(path.join(process.cwd(), file), 'utf-8');
    expect(source).toContain('stripTerminalReplies(data)');
    // The rule that manufactured the fragment, in any copy, anywhere.
    expect(source).not.toContain(String.raw`\d+;\d+c`);
  });

  it('and the unanchored rule exists nowhere in src but the note explaining it', () => {
    const offenders: string[] = [];
    const walk = (dir: string) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) { walk(full); continue; }
        if (!/\.(ts|tsx)$/.test(entry.name)) continue;
        if (fs.readFileSync(full, 'utf-8').includes(String.raw`\d+;\d+c`)) offenders.push(full);
      }
    };
    walk(path.join(process.cwd(), 'src'));

    // terminal.ts names the old rule in the comment that explains why it went.
    expect(offenders.map(f => path.basename(f))).toEqual(['terminal.ts']);
  });
});
