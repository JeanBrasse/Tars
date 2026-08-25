'use client';

import { useEffect, useState } from 'react';
import type { ITheme } from '@xterm/xterm';

/**
 * Single source of truth for every xterm surface in the app.
 *
 * xterm needs literal colours (it cannot read `var(--token)`), so this module
 * resolves the design tokens off `document.documentElement` at call time and
 * hands back a plain `ITheme`. Nothing else in the codebase may hardcode a
 * terminal colour or font (R9).
 */

export type TerminalMode = 'dark' | 'light';

/**
 * Class for the wrapper `<div>` sitting behind an xterm canvas. Those wrappers
 * are painted separately from the canvas; without this they letterbox the
 * terminal in a mismatched colour.
 */
export const TERMINAL_SURFACE_CLASS = 'bg-term-bg';

/** Fallback stack when `--font-mono` cannot be read (SSR, first paint). */
export const TERMINAL_FONT_FAMILY =
  "'Roboto Mono', ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace";

/** The token values this module needs, resolved for one theme. */
interface TerminalTokens {
  termBg: string;
  foreground: string;
  card: string;
  primary: string;
  success: string;
  warning: string;
  danger: string;
  statusIdle: string;
  textMuted: string;
  textSecondary: string;
}

/**
 * Mirrors `globals.css`. Used on the server, before hydration, and whenever a
 * theme other than the one currently mounted is requested (the computed values
 * on `documentElement` only ever describe the live theme).
 */
const FALLBACK_TOKENS: Record<TerminalMode, TerminalTokens> = {
  light: {
    termBg: '#F3F1EE',
    foreground: '#1E1E1E',
    card: '#FFFFFF',
    primary: '#C77012',
    success: '#1A7F37',
    warning: '#9A6700',
    danger: '#CF222E',
    statusIdle: '#9B9B9B',
    textMuted: '#6B6B6B',
    textSecondary: '#4A4A4A',
  },
  dark: {
    termBg: '#0F0F0F',
    foreground: '#F5F4F2',
    card: '#1A1A1A',
    primary: '#FF9E42',
    success: '#4CC38A',
    warning: '#E8C547',
    danger: '#E5534B',
    statusIdle: '#727272',
    textMuted: '#898989',
    textSecondary: '#9B9B9B',
  },
};

/** The theme the document is wearing right now. */
export function getTerminalMode(): TerminalMode {
  if (typeof document === 'undefined') return 'dark';
  return document.documentElement.classList.contains('dark') ? 'dark' : 'light';
}

function readTokens(mode: TerminalMode): TerminalTokens {
  const fallback = FALLBACK_TOKENS[mode];
  // Computed values only describe the mounted theme; anything else is a guess.
  if (typeof document === 'undefined' || getTerminalMode() !== mode) return fallback;

  const style = getComputedStyle(document.documentElement);
  const read = (name: string, or: string) => style.getPropertyValue(name).trim() || or;

  return {
    termBg: read('--term-bg', fallback.termBg),
    foreground: read('--foreground', fallback.foreground),
    card: read('--card', fallback.card),
    primary: read('--primary', fallback.primary),
    success: read('--success', fallback.success),
    warning: read('--warning', fallback.warning),
    danger: read('--danger', fallback.danger),
    statusIdle: read('--status-idle', fallback.statusIdle),
    textMuted: read('--text-muted', fallback.textMuted),
    textSecondary: read('--text-secondary', fallback.textSecondary),
  };
}

/** Append an 8-bit alpha to a 6-digit hex; leave any other notation alone. */
function withAlpha(color: string, alpha: string): string {
  return /^#[0-9a-f]{6}$/i.test(color) ? `${color}${alpha}` : color;
}

/**
 * Build the xterm theme for one mode.
 *
 * @param mode - defaults to the theme the document is currently wearing.
 */
export function createXtermTheme(mode: TerminalMode = getTerminalMode()): ITheme {
  const t = readTokens(mode);
  const isDark = mode === 'dark';

  return {
    background: t.termBg,
    foreground: t.foreground,
    // Cursor is the brand accent, never the retired teal.
    cursor: t.primary,
    cursorAccent: t.termBg,
    selectionBackground: withAlpha(t.primary, '33'),

    // The palette carries four hues (accent + three statuses), so the 16-colour
    // ANSI ramp folds onto them rather than onto Tailwind stock colours.
    black: isDark ? t.termBg : t.foreground,
    red: t.danger,
    green: t.success,
    yellow: t.warning,
    blue: t.primary,
    magenta: t.primary,
    cyan: t.success,
    white: isDark ? t.foreground : t.termBg,

    brightBlack: t.textMuted,
    brightRed: t.danger,
    brightGreen: t.success,
    brightYellow: t.warning,
    brightBlue: t.primary,
    brightMagenta: t.primary,
    brightCyan: t.success,
    brightWhite: isDark ? t.foreground : t.card,
  };
}

/**
 * Resolved `--font-mono` (Roboto Mono, self-hosted in `layout.tsx`). xterm
 * writes this straight into an inline style, so it must be literal.
 */
export function getTerminalFontFamily(): string {
  if (typeof document === 'undefined') return TERMINAL_FONT_FAMILY;
  const value = getComputedStyle(document.documentElement).getPropertyValue('--font-mono').trim();
  return value || TERMINAL_FONT_FAMILY;
}

/** Theme + font in the shape the `new Terminal({...})` call sites need. */
export function createXtermOptions(mode: TerminalMode = getTerminalMode()): {
  theme: ITheme;
  fontFamily: string;
} {
  return { theme: createXtermTheme(mode), fontFamily: getTerminalFontFamily() };
}

/**
 * The app theme, as an xterm theme, kept in sync with the `dark` class on
 * `documentElement`. Terminals follow light mode instead of staying four black
 * rectangles on a light page.
 */
export function useTerminalTheme(): ITheme {
  const [theme, setTheme] = useState<ITheme>(() => createXtermTheme());

  useEffect(() => {
    // Re-read after mount: the first render may have run without a document.
    setTheme(createXtermTheme());

    const observer = new MutationObserver(() => setTheme(createXtermTheme()));
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] });
    return () => observer.disconnect();
  }, []);

  return theme;
}
