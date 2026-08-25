import { describe, it, expect, vi } from 'vitest';
import type { Terminal } from '@xterm/xterm';
import { attachMouseHandling, attachShiftEnterHandler } from '@/lib/terminal';

/**
 * The board's panels let the CLI have the mouse, so a click places the cursor
 * in the line being typed. What that costs by default is the wheel (xterm
 * encodes it as a mouse report) and the selection (xterm disables it), so both
 * are taken back: the wheel by hand, the selection through xterm's own Option
 * escape hatch.
 *
 * Driven through a stub terminal, since vitest runs in a node environment and
 * xterm needs a document.
 */

type CsiId = { prefix?: string; final: string };
type CsiHandler = (params: (number | number[])[]) => boolean | Promise<boolean>;

function stub(rows = 24, clientHeight = 480) {
  const csi: Array<{ id: CsiId; handler: CsiHandler }> = [];
  let wheel: ((e: WheelEvent) => boolean) | null = null;
  let keyHandler: ((e: KeyboardEvent) => boolean) | null = null;
  const scrolled: number[] = [];
  const options: Record<string, unknown> = {};
  const term = {
    rows,
    element: { clientHeight },
    options,
    parser: { registerCsiHandler: (id: CsiId, handler: CsiHandler) => { csi.push({ id, handler }); return { dispose() {} }; } },
    attachCustomWheelEventHandler: (h: (e: WheelEvent) => boolean) => { wheel = h; },
    scrollLines: (n: number) => { scrolled.push(n); },
    attachCustomKeyEventHandler: (h: (e: KeyboardEvent) => boolean) => { keyHandler = h; },
    hasSelection: () => true,
    getSelection: () => 'selected text',
  };
  attachMouseHandling(term as unknown as Terminal);
  const set = csi.find(c => c.id.final === 'h')!.handler;
  const reset = csi.find(c => c.id.final === 'l')!.handler;
  return {
    csi, options, scrolled, set, reset,
    spin: (deltaY: number, deltaMode = 0) => wheel!({ deltaY, deltaMode } as WheelEvent),
    term: term as unknown as Terminal,
    key: (e: Partial<KeyboardEvent>) => keyHandler!({ type: 'keydown', ...e } as KeyboardEvent),
  };
}

describe('attachMouseHandling', () => {
  it('observes the modes instead of swallowing them, so the CLI gets the mouse', () => {
    const t = stub();
    // false = "not handled": xterm still applies the mode, so a click reaches the CLI.
    for (const mode of [9, 1000, 1001, 1002, 1003, 1005, 1006, 25, 1049, 2004]) {
      expect(t.set([mode])).toBe(false);
      expect(t.reset([mode])).toBe(false);
    }
  });

  it('leaves the wheel to xterm until an application arms tracking', () => {
    const t = stub();
    expect(t.spin(100)).toBe(true);
    expect(t.scrolled).toEqual([]);
  });

  it('takes the wheel over once tracking is armed and scrolls instead', () => {
    const t = stub(24, 480); // 20px rows
    t.set([1002]);
    expect(t.spin(100)).toBe(false);      // 100px / 20px = 5 rows
    expect(t.scrolled).toEqual([5]);
    expect(t.spin(-60)).toBe(false);
    expect(t.scrolled).toEqual([5, -3]);
  });

  it('is armed by a mixed set too, which is the sequence that used to slip through', () => {
    const t = stub(24, 480);
    expect(t.set([25, 1002])).toBe(false);
    expect(t.spin(40)).toBe(false);
    expect(t.scrolled).toEqual([2]);
  });

  it('hands the wheel back when an application disarms tracking', () => {
    const t = stub();
    t.set([1002]);
    t.reset([1002]);
    expect(t.spin(100)).toBe(true);
    expect(t.scrolled).toEqual([]);
  });

  it('accumulates trackpad fractions instead of dropping them', () => {
    const t = stub(24, 480); // 20px rows
    t.set([1002]);
    for (let i = 0; i < 4; i++) t.spin(5);  // 0.25 row each
    expect(t.scrolled).toEqual([1]);        // four nudges make one row, none lost
  });

  it('handles line and page wheel units', () => {
    const t = stub(24, 480);
    t.set([1002]);
    t.spin(3, 1);                            // DOM_DELTA_LINE
    t.spin(1, 2);                            // DOM_DELTA_PAGE
    expect(t.scrolled).toEqual([3, 24]);
  });

  it('keeps text selection reachable under Option', () => {
    const t = stub();
    expect(t.options.macOptionClickForcesSelection).toBe(true);
  });
});

describe('terminal key handler', () => {
  it('copies the selection on Cmd+C instead of sending it to the pty', () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal('navigator', { clipboard: { writeText } });

    const { term, key } = stub();
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

    const { term, key } = stub();
    attachShiftEnterHandler(term, vi.fn());

    expect(key({ key: 'c', ctrlKey: true })).toBe(true);
    expect(writeText).not.toHaveBeenCalled();

    vi.unstubAllGlobals();
  });

  it('still inserts a newline on Shift+Enter', () => {
    const { term, key } = stub();
    const send = vi.fn();
    attachShiftEnterHandler(term, send);

    expect(key({ key: 'Enter', shiftKey: true })).toBe(false);
    expect(send).toHaveBeenCalledWith('\x1b[200~\n\x1b[201~');
  });
});

/**
 * QA additions. The suggested file covers the contract; these are the edges
 * where a loss would be silent: a sub-row nudge that scrolls nothing, a
 * reversal that must not lose the carried fraction, a terminal measured before
 * it has been opened, and the selection flag surviving the mode traffic that
 * arrives on every redraw.
 */
describe('attachMouseHandling, edges', () => {
  it('never asks for a scroll of zero rows', () => {
    const t = stub(24, 480);            // 20px rows
    t.set([1002]);
    expect(t.spin(5)).toBe(false);      // a quarter of a row
    expect(t.scrolled).toEqual([]);     // consumed, carried, nothing dispatched
  });

  it('keeps the carried fraction across a change of direction', () => {
    const t = stub(24, 480);
    t.set([1002]);
    t.spin(10);                          // +0.5
    t.spin(10);                          // +1.0 -> one row
    t.spin(-10);                         // -0.5
    t.spin(-10);                         // -1.0 -> one row back
    expect(t.scrolled).toEqual([1, -1]); // symmetric, nothing lost either way
  });

  it('still measures a terminal that has not been opened yet', () => {
    const t = stub(24, 480);
    (t.term as unknown as { element: null }).element = null;
    t.set([1002]);
    expect(t.spin(17)).toBe(false);      // the 17px fallback row height
    expect(t.scrolled).toEqual([1]);
  });

  it('does not divide by zero on a terminal with no rows', () => {
    const t = stub(0, 0);
    t.set([1002]);
    expect(() => t.spin(100)).not.toThrow();
    expect(t.scrolled.every(n => Number.isFinite(n))).toBe(true);
  });

  it('keeps selection reachable through the mode traffic of a redraw', () => {
    const t = stub();
    // Claude Code re-arms on nearly every redraw; none of it may clear the flag.
    for (let i = 0; i < 5; i++) { t.set([1002]); t.set([25, 1006]); t.reset([1002]); }
    expect(t.options.macOptionClickForcesSelection).toBe(true);
  });

  it('leaves the wheel alone for a mode that is not about mouse ownership', () => {
    const t = stub();
    // 1006 only changes how a report is encoded, so it must not arm anything.
    t.set([1006]);
    expect(t.spin(100)).toBe(true);
    expect(t.scrolled).toEqual([]);
  });
});
