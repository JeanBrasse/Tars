/**
 * A value written into one of Tars's own lines: quoted, and with nothing left
 * in it that can end the line or hide text.
 *
 * Every value a note interpolates outside a fence goes through here, because a
 * name is free text and so is a room, which is a project path. So does the
 * sender a message is typed under (core/pty-manager.ts). JSON.stringify
 * escapes the quote, the backslash and C0, a line feed included. It leaves
 * U+2028 and U+2029 raw, being legal in a JSON string, and asTypedText strips
 * only C0 and C1, so a name holding one broke Tars's own line in the terminal
 * and carried a forged note after it. Found by the QA on #95. The class is
 * wider than those two, and it is the class that is escaped: what a terminal or
 * a reader can take for a line break (separators, controls such as NEL), and
 * what shows as nothing or rearranges what is shown (format characters, so
 * zero-width characters, direction marks and overrides, tags, and every other
 * default-ignorable code point, such as variation selectors). Each comes out as
 * a visible \uXXXX, so what is hidden is shown instead of removed.
 */
const HIDDEN_OR_LINE_BREAKING = /[\p{Zl}\p{Zp}\p{Cc}\p{Cf}\p{Default_Ignorable_Code_Point}]/gu;

export function envelopeValue(value: string): string {
  return JSON.stringify(value).replace(HIDDEN_OR_LINE_BREAKING, found =>
    // Every UTF-16 unit, so an astral code point such as a tag comes out whole.
    Array.from({ length: found.length }, (_, i) => `\\u${found.charCodeAt(i).toString(16).padStart(4, '0')}`).join(''));
}
