import { describe, it, expect, vi } from 'vitest';
import type { Terminal } from 'xterm';
import { suppressMouseTracking, suppressAlternateScreen, attachShiftEnterHandler } from '@/lib/terminal';

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
 * The alternate screen buffer, refused.
 *
 * Claude Code sends `\x1b[?1049h` in its first frame and never the matching
 * `l`. That buffer has no scrollback by definition, so a panel that entered it
 * could not scroll at all, and xterm turns the wheel into cursor keys aimed at
 * the pty instead. It read as intermittent only because a panel lands there
 * when the retained output it replays on mount still carries that first frame:
 * a chatty agent has already dropped it out of the ring and mounts into the
 * normal buffer, a quiet one has not.
 *
 * Both directions are refused together. Leaving a buffer that was never
 * entered would restore a cursor nobody saved.
 */
describe('suppressAlternateScreen', () => {
  const set = (csi: Array<{ id: CsiId; handler: CsiHandler }>) => csi.find(c => c.id.final === 'h')!.handler;
  const reset = (csi: Array<{ id: CsiId; handler: CsiHandler }>) => csi.find(c => c.id.final === 'l')!.handler;

  it('registers on both directions of DEC private mode', () => {
    const { term, csi } = stubTerminal();
    suppressAlternateScreen(term);
    expect(csi).toHaveLength(2);
    expect(csi.map(c => c.id)).toEqual([{ prefix: '?', final: 'h' }, { prefix: '?', final: 'l' }]);
  });

  it('swallows the three buffer-swap modes, entering and leaving', () => {
    const { term, csi } = stubTerminal();
    suppressAlternateScreen(term);
    // true = handled here, so xterm never sees it and never swaps the buffer.
    for (const mode of [47, 1047, 1049]) {
      expect(set(csi)([mode]), `?${mode}h`).toBe(true);
      expect(reset(csi)([mode]), `?${mode}l`).toBe(true);
    }
  });

  it('is the sequence Claude Code actually sends', () => {
    const { term, csi } = stubTerminal();
    suppressAlternateScreen(term);
    // 1049 is the one in its first frame: swap buffer and save the cursor.
    expect(set(csi)([1049])).toBe(true);
  });

  it('lets every unrelated private mode through', () => {
    const { term, csi } = stubTerminal();
    suppressAlternateScreen(term);
    // Cursor visibility, bracketed paste, focus reporting, mouse tracking:
    // none of them are ours to refuse here.
    for (const mode of [25, 1000, 1002, 1004, 1006, 2004, 12]) {
      expect(set(csi)([mode]), `?${mode}h`).toBe(false);
      expect(reset(csi)([mode]), `?${mode}l`).toBe(false);
    }
  });

  it('passes a mixed set through rather than dropping it wholesale', () => {
    const { term, csi } = stubTerminal();
    suppressAlternateScreen(term);
    // `\x1b[?25;1049h` also hides the cursor. Swallowing it would swallow
    // that too, so it is handed on and the buffer swap goes with it: refusing
    // whole sequences is only safe when the whole sequence is ours.
    expect(set(csi)([25, 1049])).toBe(false);
    expect(set(csi)([])).toBe(false);
  });

  it('does not disturb the mouse handler registered beside it', () => {
    const { term, csi } = stubTerminal();
    suppressMouseTracking(term);
    suppressAlternateScreen(term);
    expect(csi).toHaveLength(3);
    // The mouse handler still refuses its own modes, and the alternate-screen
    // pair still refuses theirs: the two coexist on the same parser.
    expect(csi[0].handler([1002])).toBe(true);
    expect(csi[1].handler([1049])).toBe(true);
    expect(csi[0].handler([1049])).toBe(false);
    expect(csi[1].handler([1002])).toBe(false);
  });
});
