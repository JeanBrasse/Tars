/**
 * An agent's mark: a 4x4 grid of squares drawn from its name, the Tars mark
 * one size down. The left two columns come from the name, the right two
 * mirror them. Frame: `Agent mark` in design/tars-redesign.pen, whose marks
 * the pen CLI drew with this same arithmetic, so a name lights the same
 * squares in the design and in the app. Its failures are listed, and pinned,
 * in __tests__/lib/agent-mark.test.ts.
 */

/** What a name gets when twelve stirs of its hash never land on 3 to 6 lit squares. */
const FALLBACK = [1, 0, 0, 1, 1, 1, 0, 1];

/** djb2 with xor, over code points: a character beyond the BMP is one step, not two halves. */
function hash(name: string): number {
  let h = 5381;
  for (const ch of name) h = (Math.imul(h, 33) ^ (ch.codePointAt(0) ?? 0)) >>> 0;
  return h;
}

/**
 * The 8 squares of the left half, two per row, top row first: 1 lit, 0 not.
 * Between 3 and 6 are lit, so no mark reads as nothing or as a block.
 */
export function agentMarkBits(name: string): number[] {
  let h = hash(name);
  for (let k = 0; k < 12; k++) {
    const bits = Array.from({ length: 8 }, (_, i) => (h >>> i) & 1);
    const lit = bits.reduce((sum, bit) => sum + bit, 0);
    if (lit >= 3 && lit <= 6) return bits;
    h = Math.imul(h ^ (h >>> 15), 2654435761) >>> 0;
  }
  return [...FALLBACK];
}

/** All 16 squares, row by row: each row is its two left squares, then the same two turned over. */
export function agentMarkCells(name: string): boolean[] {
  const bits = agentMarkBits(name);
  const cells: boolean[] = [];
  for (let row = 0; row < 4; row++) {
    const outer = bits[row * 2] === 1;
    const inner = bits[row * 2 + 1] === 1;
    cells.push(outer, inner, inner, outer);
  }
  return cells;
}
