/**
 * Who owns a key: the page, the Dashboard panels, the terminal's clipboard or
 * the program in the terminal. Kept apart
 * from terminal.ts, which only calls terminalKeyAction from its key handler.
 */

/** The parts of a KeyboardEvent the key routing reads. */
export interface KeyLike {
  key: string;
  code?: string;
  ctrlKey: boolean;
  metaKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
}

/** The platform the app runs on, from the preload bridge; '' outside Electron. */
export { rendererPlatform } from './display-path';

/**
 * The digit row key, read from its position (`Digit2`) rather than from the
 * character it types: on AZERTY the unshifted row types & é " ' and a
 * shortcut read from `key` never fires. Numpad digits are not the row.
 */
function digitRowKey(e: KeyLike): string | null {
  const m = /^Digit([0-9])$/.exec(e.code ?? '');
  return m ? m[1] : null;
}

/**
 * Who owns a key pressed in a terminal:
 *
 * - `newline`: Shift+Enter, a literal newline instead of a submit.
 * - `copy`: the selection goes to the clipboard.
 * - `paste`: the clipboard goes to the program (win32).
 * - `page` / `panel`: a page or panel shortcut (win32); xterm must not see it,
 *   the window's own listeners act on it.
 * - `program`: everything else, xterm's to encode for the program.
 *
 * darwin/linux: exactly the rules this handler always had (Cmd+C, or
 * Ctrl+Shift+C, with a selection copies). win32, as in Windows Terminal:
 * Ctrl+C copies when there is a selection and interrupts when there is none,
 * Ctrl+V and Ctrl+Shift+V paste, Ctrl+digit is a page and Alt+1..9 a panel
 * when `hasPanel` says one answers that index (the Dashboard's): anywhere
 * else Alt+digit stays the program's, its Meta+digit. Ctrl+Alt is AltGr there
 * and always stays the program's.
 */
export type TerminalKeyAction = 'newline' | 'copy' | 'paste' | 'page' | 'panel' | 'program';

export function terminalKeyAction(
  e: KeyLike,
  platform: string,
  hasSelection: boolean,
  hasPanel: (index: number) => boolean = () => false,
): TerminalKeyAction {
  if (e.key === 'Enter' && e.shiftKey) return 'newline';
  const isC = e.key === 'c' || e.key === 'C';
  if (platform !== 'win32') {
    const copyChord = e.metaKey || (e.ctrlKey && e.shiftKey);
    return copyChord && isC && hasSelection ? 'copy' : 'program';
  }
  const ctrlOnly = e.ctrlKey && !e.altKey && !e.metaKey;
  if (ctrlOnly && isC) return hasSelection ? 'copy' : 'program';
  if (ctrlOnly && (e.key === 'v' || e.key === 'V')) return 'paste';
  if (pageShortcutDigit(e, platform, null) !== null) return 'page';
  const panel = panelShortcutIndex(e, platform);
  if (panel !== null && hasPanel(panel)) return 'panel';
  return 'program';
}

/** What a keydown was aimed at, as far as the page shortcuts care. */
type ShortcutTarget = { tagName: string; isContentEditable?: boolean; className?: string } | null;

function isTextField(target: ShortcutTarget): boolean {
  if (!target) return false;
  if (target.isContentEditable) return true;
  return /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName);
}

function isTerminalInput(target: ShortcutTarget): boolean {
  return !!target && target.tagName === 'TEXTAREA'
    && typeof target.className === 'string' && target.className.split(/\s+/).includes('xterm-helper-textarea');
}

/**
 * The page a Sidebar shortcut opens: the digit, or null when the key is not
 * one. darwin/linux: Cmd or Ctrl plus a digit, no Alt or Shift, never while a
 * field (a terminal included) has the focus, as always. win32: Ctrl plus a
 * digit row key, from anywhere but a real text field: a terminal's input is
 * not one, since Alt+digit now picks its panel.
 */
export function pageShortcutDigit(e: KeyLike, platform: string, target: ShortcutTarget): string | null {
  if (platform !== 'win32') {
    if (!e.metaKey && !e.ctrlKey) return null;
    if (e.altKey || e.shiftKey) return null;
    if (isTextField(target)) return null;
    return /^[0-9]$/.test(e.key) ? e.key : null;
  }
  if (!e.ctrlKey || e.altKey || e.shiftKey || e.metaKey) return null;
  if (isTextField(target) && !isTerminalInput(target)) return null;
  return digitRowKey(e);
}

/**
 * The Dashboard panel a shortcut focuses, as an index, or null. darwin/linux:
 * Ctrl plus 1..9 without Shift, as always. win32: Alt plus 1..9 alone, since
 * Ctrl plus a digit is the page there.
 */
export function panelShortcutIndex(e: KeyLike, platform: string): number | null {
  if (platform !== 'win32') {
    if (!e.ctrlKey || e.shiftKey) return null;
    return e.key >= '1' && e.key <= '9' && e.key.length === 1 ? parseInt(e.key, 10) - 1 : null;
  }
  if (!e.altKey || e.ctrlKey || e.shiftKey || e.metaKey) return null;
  const digit = digitRowKey(e);
  return digit && digit !== '0' ? parseInt(digit, 10) - 1 : null;
}
