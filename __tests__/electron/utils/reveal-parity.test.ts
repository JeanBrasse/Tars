import { describe, it, expect } from 'vitest';
import { reveal as revealInMain } from '../../../electron/utils/reveal';
import { reveal as revealInReview } from '../../../src/lib/template-review';

/**
 * The main process writes out what does not show as the import review does
 * (the Audit's gate of #208). The review's reveal() lives in the renderer,
 * which main cannot import, so main has its own; this holds the two to the
 * same answer, character for character, so a refusal and the review never
 * disagree about what a name holds.
 *
 * How it fails: main's copy drifts from the review's, on a bidi control, a
 * zero width or tag character, a control, a variation selector or joiner that
 * belongs to an emoji and one that does not, a Windows line end, or a tab.
 */
const CORPUS = [
  'plain', 'Helper‮gnp.exe', 'a​b‌c‍d⁠e', 'tag\u{E0041}\u{E007F}', 'bell\u0007 c1\u0085',
  'line para ', 'fillㅤerᅟ', 'var️sel', '❤️ ok', '#️⃣', '👩‍💻 dev', 'x‍💻',
  'win\r\nline', 'tab\there\nnewline', 'soft­hyphen', 'bom﻿', 'mongol᠎', '👍🏽‍🔥', '',
];

describe('reveal, in main and in the review', () => {
  it.each(CORPUS.map(s => [JSON.stringify(s), s]))('gives the same answer for %s', (_shown, input) => {
    expect(revealInMain(input)).toEqual(revealInReview(input));
  });
});
