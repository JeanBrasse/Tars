import * as os from 'os';
import * as path from 'path';
import type { Env } from './fs-probe';

/**
 * PATH in an environment block, per platform (audit A16, A17).
 *
 * Windows spells the variable `Path` (what Electron inherits from Explorer),
 * `PATH` (from Git Bash or a script) or anything else: names are
 * case-insensitive there, but a plain object is not, and node-pty copies an
 * env object into the child's block without merging spellings. With both
 * present the child reads the first one Windows finds, which is not the one
 * Tars set. Everything here reads and writes it through one key.
 */

const isWin = (platform: NodeJS.Platform) => platform === 'win32';

/** The keys of `env` that name `name`: exact on darwin/linux, any case on win32. */
function keysFor(env: Env, name: string, platform: NodeJS.Platform): string[] {
  if (!isWin(platform)) return name in env ? [name] : [];
  const upper = name.toUpperCase();
  return Object.keys(env).filter((k) => k.toUpperCase() === upper);
}

/**
 * A variable's value. On win32 any spelling of the name, and with several the
 * key added last to the object: `{ ...process.env, PATH: x }` means x when
 * process.env spells it `Path`, since PATH is then a new key after it. (A key
 * that is overwritten keeps its place; with a single spelling there is
 * nothing to choose.)
 */
export function envValue(env: Env, name: string, platform: NodeJS.Platform): string | undefined {
  const keys = keysFor(env, name, platform);
  return keys.length ? env[keys[keys.length - 1]] : undefined;
}

export function getPath(env: Env, platform: NodeJS.Platform): string | undefined {
  return envValue(env, 'PATH', platform);
}

/**
 * A copy of `env` with PATH set to `value`. On win32 under the spelling the
 * env already uses (the first one found, `Path` when there is none), every
 * other spelling removed. On darwin/linux, `PATH` alone: `Path` is another
 * variable there.
 */
export function withPath(env: Env, value: string, platform: NodeJS.Platform): Env {
  if (!isWin(platform)) return { ...env, PATH: value };
  const keys = keysFor(env, 'PATH', platform);
  const out: Env = {};
  for (const [k, v] of Object.entries(env)) if (!keys.includes(k)) out[k] = v;
  out[keys[0] ?? 'Path'] = value;
  return out;
}

/**
 * A PATH value as its entries. darwin/linux: String.split(':') exactly, an
 * empty entry kept (it means the current directory there). win32: split on
 * `;` outside double quotes, quotes kept so the entry joins back unchanged,
 * empty entries dropped (they name nothing). Unset or empty: no entry.
 */
export function pathEntries(value: string | undefined, platform: NodeJS.Platform): string[] {
  if (!value) return [];
  if (!isWin(platform)) return value.split(':');
  const entries: string[] = [];
  let current = '';
  let quoted = false;
  for (const ch of value) {
    if (ch === '"') quoted = !quoted;
    if (ch === ';' && !quoted) {
      if (current) entries.push(current);
      current = '';
    } else {
      current += ch;
    }
  }
  if (current) entries.push(current);
  return entries;
}

export function joinPathEntries(entries: string[], platform: NodeJS.Platform): string {
  return entries.join(isWin(platform) ? ';' : ':');
}

/** A win32 PATH entry as a directory: its quotes removed. */
export function unquoteEntry(entry: string): string {
  return entry.length >= 2 && entry.startsWith('"') && entry.endsWith('"') ? entry.slice(1, -1) : entry;
}

/** What makes two win32 entries the same directory: case, quotes and trailing separators aside. */
function windowsEntryKey(entry: string): string {
  const dir = unquoteEntry(entry).replace(/\//g, '\\');
  return (/^[a-z]:\\+$/i.test(dir) ? dir.slice(0, 3) : dir.replace(/\\+$/, '')).toLowerCase();
}

/**
 * buildFullPath's win32 branch: the user's CLI dirs first (their explicit
 * choice, as on macOS), then the existing Path, then
 * %USERPROFILE%\.local\bin (the native claude.exe) and %APPDATA%\npm (npm's
 * global shims). Those two go last so that nothing dropped in them shadows a
 * System32 tool (the orchestrator's decision at win-reviewer's gate,
 * 2026-09-25). Each directory once, compared without case, first spelling
 * kept. None of the macOS entries.
 */
export function buildWindowsFullPath(extraPaths: string[], env: Env): string {
  const home = envValue(env, 'USERPROFILE', 'win32') || os.homedir();
  const appData = envValue(env, 'APPDATA', 'win32') || path.win32.join(home, 'AppData', 'Roaming');
  const candidates = [
    ...extraPaths,
    ...pathEntries(getPath(env, 'win32'), 'win32'),
    path.win32.join(home, '.local', 'bin'),
    path.win32.join(appData, 'npm'),
  ];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const entry of candidates) {
    if (!entry) continue;
    const key = windowsEntryKey(entry);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(entry);
  }
  return joinPathEntries(out, 'win32');
}
