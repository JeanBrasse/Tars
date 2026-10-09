import * as path from 'path';
import { realFs, type Env, type FsProbe } from './fs-probe';
import { envValue, getPath, pathEntries, unquoteEntry } from './path-env';

/**
 * Which file to start for a CLI, and what goes before its arguments
 * (audit A5, A18, B/C-02, B/C-03).
 *
 * On win32 neither node-pty nor child_process can start what `claude`,
 * `codex` or `npx` usually are there: node-pty and libuv look a bare name up
 * without PATHEXT, a `.cmd` needs cmd.exe (and node refuses it outright since
 * CVE-2024-27980), and cmd.exe caps the line at 8191 characters, cannot carry
 * a newline in an argument and expands % ^ &. So the lookup is done here,
 * PATH x PATHEXT in Node (no where.exe subprocess), and an npm shim is read
 * rather than run: npm's cmd-shim ends in one line that starts either a
 * native .exe or `node <script>`, and that is what we start instead, with
 * the CLI's arguments intact. A shim we cannot read that way is a typed
 * failure; nothing here guesses.
 *
 * The extensionless file npm writes beside every .cmd is a POSIX sh script.
 * Windows cannot start it and it is never returned, found on the PATH or
 * configured as a path.
 */

export type CliBinary = {
  ok: true;
  /** The executable to start: a .exe/.com on win32, the name as given elsewhere. */
  file: string;
  /** Arguments that go before the CLI's own: the script of a node shim. */
  prefixArgs: string[];
  via: 'as-given' | 'exe' | 'npm-shim-exe' | 'npm-shim-node';
};

export type CliBinaryFailureReason =
  | 'invalid-name'          // empty, a quote or a character Windows refuses, a relative path
  | 'not-found'             // nothing on the PATH / at the path with a PATHEXT extension
  | 'unsupported-extension' // found, but not .exe/.com/.cmd/.bat (a sh shim, a .ps1, a .js)
  | 'unrecognised-shim'     // a .cmd/.bat that is not an npm shim we can read through
  | 'shim-target-missing'   // an npm shim whose .exe or script is not on disk
  | 'node-not-found';       // a node shim, and no node.exe beside it or on the PATH

export type CliBinaryFailure = {
  ok: false;
  reason: CliBinaryFailureReason;
  name: string;
  /** The file the failure is about, when there is one. */
  path?: string;
  detail: string;
};

export const DEFAULT_PATHEXT = '.COM;.EXE;.BAT;.CMD';
const NODE_SCRIPT = /\.(c|m)?js$/i;
const w = path.win32;

/**
 * Bounds on reading a shim. npm's and Node's shims are about 20 lines and
 * under 1 KB; anything past these is not one, and a hostile one must not
 * cost more than a few milliseconds (win-reviewer, 2026-09-25: 60 lines of
 * `SET "_prog=%_prog%"` used to expand to 60^4 values).
 */
const MAX_SHIM_CHARS = 64 * 1024;
const MAX_SHIM_LINES = 256;
/** How many values a shim's program or target may take across its branches. */
const MAX_SHIM_VALUES = 16;
const MAX_DETAIL = 500;

function fail(reason: CliBinaryFailureReason, name: string, detail: string, file?: string): CliBinaryFailure {
  const bounded = detail.length > MAX_DETAIL ? `${detail.slice(0, MAX_DETAIL)}...` : detail;
  return file === undefined ? { ok: false, reason, name, detail: bounded } : { ok: false, reason, name, path: file, detail: bounded };
}

/**
 * A drive-absolute (`C:\...`) or UNC (`\\server\share\...`) path with no
 * other colon. Anything else Windows would resolve against the current
 * directory or drive (`bin`, `.`, `\dir`, `C:dir`), which is a planting hole,
 * or read as an NTFS alternate data stream (`claude.exe:evil`).
 */
export function isPlainAbsolute(p: string): boolean {
  if (/^[a-z]:[\\/]/i.test(p)) return !p.slice(2).includes(':');
  return /^[\\/]{2}[^\\/]/.test(p) && !p.includes(':');
}

/** PATHEXT as lowercase extensions, in order. */
export function pathExts(env: Env): string[] {
  const raw = envValue(env, 'PATHEXT', 'win32') || DEFAULT_PATHEXT;
  const exts = raw.split(';').map((e) => e.trim().toLowerCase()).filter((e) => /^\.[^.\\/]+$/.test(e));
  return exts.length ? exts : DEFAULT_PATHEXT.toLowerCase().split(';');
}

/** The plain absolute directories of the PATH, unquoted (see isPlainAbsolute). */
function pathDirs(env: Env): string[] {
  return pathEntries(getPath(env, 'win32'), 'win32').map(unquoteEntry).filter(isPlainAbsolute);
}

/**
 * The first `<dir>\<file>` that exists, PATH order. For callers that need a
 * known file name (pwsh.exe, node.exe), not a PATHEXT lookup.
 */
export function findOnPath(fileName: string, env: Env, fs: FsProbe = realFs): string | undefined {
  for (const dir of pathDirs(env)) {
    const candidate = w.join(dir, fileName);
    if (fs.isFile(candidate)) return candidate;
  }
  return undefined;
}

/**
 * `name` (a bare command or a configured path) as the file to start.
 * darwin/linux: the name as given, untouched, no disk access (today's behaviour).
 */
export function resolveCliBinary(
  name: string, env: Env, platform: NodeJS.Platform, fs: FsProbe = realFs,
): CliBinary | CliBinaryFailure {
  if (platform !== 'win32') return { ok: true, file: name, prefixArgs: [], via: 'as-given' };

  const trimmed = name.trim();
  const given = trimmed.length >= 2 && trimmed.startsWith('"') && trimmed.endsWith('"') ? trimmed.slice(1, -1) : trimmed;
  if (!given || /["<>|?*\0]/.test(given) || /[\x00-\x1f]/.test(given)) {
    return fail('invalid-name', name, 'Empty, or holds a character Windows does not allow in a file name.');
  }
  const exts = pathExts(env);
  const hasSeparator = /[\\/]/.test(given);
  if (!hasSeparator && given.includes(':')) {
    return fail('invalid-name', name, 'A colon in a bare name: a drive-relative path or an NTFS stream, not a command.');
  }
  if (hasSeparator && !isPlainAbsolute(given)) {
    return fail('invalid-name', name, 'Not a plain absolute path (a relative path, or a colon past the drive letter): give the CLI as a bare name or an absolute path.');
  }

  const dirs = hasSeparator ? [w.dirname(given)] : pathDirs(env);
  const base = hasSeparator ? w.basename(given) : given;
  const ownExt = w.extname(base).toLowerCase();
  const candidates = ownExt && exts.includes(ownExt) ? [base] : exts.map((e) => base + e);

  let unrunnable: string | undefined;
  for (const dir of dirs) {
    for (const file of candidates) {
      const full = w.join(dir, file);
      if (fs.isFile(full)) return classify(full, name, env, fs);
    }
    // What cmd.exe would never run: the sh shim, a .ps1, a .js given by path.
    const bare = w.join(dir, base);
    if (!unrunnable && !candidates.includes(base) && fs.isFile(bare)) unrunnable = bare;
  }
  if (unrunnable) {
    return fail('unsupported-extension', name,
      `${unrunnable} is not a Windows executable (no ${exts.join('/')} extension): an npm sh shim or a script. Point to the .exe or the .cmd beside it.`,
      unrunnable);
  }
  return fail('not-found', name, hasSeparator
    ? `No ${given} with an extension from PATHEXT (${exts.join(';')}).`
    : `${given} is not on the PATH with an extension from PATHEXT (${exts.join(';')}).`);
}

function classify(file: string, name: string, env: Env, fs: FsProbe): CliBinary | CliBinaryFailure {
  const ext = w.extname(file).toLowerCase();
  if (ext === '.exe' || ext === '.com') return { ok: true, file, prefixArgs: [], via: 'exe' };
  if (ext === '.cmd' || ext === '.bat') return readShim(file, name, env, fs);
  return fail('unsupported-extension', name, `${file}: Tars starts .exe, .com and npm .cmd shims, not ${ext} files.`, file);
}

/** `SET "X=v"` / `SET X=v`, every assignment of each variable, in file order (lowercase names). */
function assignments(lines: string[]): Map<string, string[]> {
  const sets = new Map<string, string[]>();
  for (const line of lines) {
    const m = /^\s*@?set\s+(?:"([A-Za-z_][\w]*)=([^"]*)"|([A-Za-z_][\w]*)=(.*?))\s*$/i.exec(line);
    if (!m) continue;
    const key = (m[1] ?? m[3]).toLowerCase();
    sets.set(key, [...(sets.get(key) ?? []), m[1] ? m[2] : m[4]]);
  }
  return sets;
}

/** Whitespace-separated tokens, double quotes grouping and removed. */
function batchTokens(text: string): string[] | undefined {
  const tokens: string[] = [];
  const re = /"([^"]*)"|([^\s"]+)/g;
  let m: RegExpExecArray | null;
  let consumed = '';
  while ((m = re.exec(text))) {
    tokens.push(m[1] ?? m[2]);
    consumed += m[0];
  }
  // An odd quote leaves text the regex skipped.
  return consumed.replace(/\s/g, '') === text.replace(/\s/g, '') ? tokens : undefined;
}

/**
 * Read an npm shim through to what it starts. Three formats are known, all
 * ending in the one line that carries `%*`:
 * - cmd-shim 5+ (npm 7+), node target:
 *   `endLocal & ... & "%_prog%"  "%dp0%\node_modules\pkg\cli.js" %*`
 * - cmd-shim 5+, native target (claude's package):
 *   `"%dp0%\node_modules\pkg\bin\claude.exe"   %*`
 * - Node's own npm.cmd / npx.cmd: `"%NODE_EXE%" "%NPX_CLI_JS%" %*`, both set above
 * and cmd-shim before 5, whose last `%*` line is `node  "%~dp0\...\cli.js" %*`.
 */
function readShim(shim: string, name: string, env: Env, fs: FsProbe): CliBinary | CliBinaryFailure {
  const unrecognised = (why: string) => fail('unrecognised-shim', name, `${shim} is not an npm shim Tars can read through: ${why}.`, shim);

  let text: string;
  try {
    text = fs.readFile(shim);
  } catch (err) {
    return unrecognised(`it could not be read (${err instanceof Error ? err.message : String(err)})`);
  }
  if (text.length > MAX_SHIM_CHARS) return unrecognised(`it is ${text.length} characters, larger than any npm shim`);
  const lines = text.split(/\r?\n/);
  if (lines.length > MAX_SHIM_LINES) return unrecognised(`it has ${lines.length} lines, more than any npm shim`);
  const invocation = [...lines].reverse().find((l) => l.includes('%*'));
  if (!invocation) return unrecognised('no line passes the arguments on (%*)');

  // The command is the last `&`-separated part; `%*` ends it.
  const command = invocation.split('&').pop()!.replace(/^\s*@/, '').trim();
  if (!command.endsWith('%*')) return unrecognised('something follows %* on its command line');
  const tokens = batchTokens(command.slice(0, -2).trim());
  if (!tokens || tokens.length < 1 || tokens.length > 2) return unrecognised('its command is not `<exe>` or `<node> <script>`');

  const dir = w.dirname(shim);
  const sets = assignments(lines);
  /**
   * Every value a token can take: %VAR% through its assignments (four levels
   * deep), %~dp0 and %dp0% as the shim's folder. Deduplicated and memoised per
   * token and depth, so self- or mutually-referencing variables cost a few
   * steps; null once more than MAX_SHIM_VALUES distinct values appear.
   */
  const memo = new Map<string, string[] | null>();
  const expand = (token: string, depth = 0): string[] | null => {
    const key = `${depth}\0${token}`;
    const known = memo.get(key);
    if (known !== undefined) return known;
    const whole = /^%([A-Za-z_][\w]*)%$/.exec(token);
    const values = whole && whole[1].toLowerCase() !== 'dp0' && depth < 4 ? sets.get(whole[1].toLowerCase()) : undefined;
    let result: string[] | null;
    if (values) {
      const acc = new Set<string>();
      result = [];
      for (const value of new Set(values)) {
        const sub = expand(value, depth + 1);
        if (sub) for (const s of sub) acc.add(s);
        if (!sub || acc.size > MAX_SHIM_VALUES) { result = null; break; }
      }
      if (result) result = [...acc];
    } else {
      // A function, not a replacement string: a folder named `x$&y` or `x$'y`
      // would otherwise be read as a pattern and resolve somewhere else.
      const out = token.replace(/%~dp0|%dp0%/gi, () => `${dir}\\`);
      result = [/%/.test(out) ? out : w.normalize(out)];
    }
    memo.set(key, result);
    return result;
  };
  const tooMany = () => unrecognised(`its variables take more than ${MAX_SHIM_VALUES} values`);

  // A program must be node whichever branch of the shim set it; a target is
  // its first assignment, the shim's default. Node's npx.cmd later switches to
  // a globally installed npm's npx-cli.js when one exists; that override is
  // not followed: `npx` then runs the npx-cli.js bundled with that Node.
  if (tokens.length === 1) {
    const targets = expand(tokens[0]);
    if (!targets) return tooMany();
    const [target] = targets;
    const ext = w.extname(target).toLowerCase();
    if (/%/.test(target) || !isPlainAbsolute(target) || (ext !== '.exe' && ext !== '.com')) {
      return unrecognised(`it starts ${tokens[0]}, not a native .exe beside it`);
    }
    if (!fs.isFile(target)) return fail('shim-target-missing', name, `${shim} starts ${target}, which is not there.`, shim);
    return { ok: true, file: target, prefixArgs: [], via: 'npm-shim-exe' };
  }

  const [program, scriptToken] = tokens;
  const programs = expand(program);
  if (!programs) return tooMany();
  const isNode = (p: string) => ['node', 'node.exe'].includes(w.basename(p).toLowerCase());
  if (!programs.every(isNode)) return unrecognised(`it runs ${programs.join(' or ')}, not node`);
  const scripts = expand(scriptToken);
  if (!scripts) return tooMany();
  const [script] = scripts;
  if (/%/.test(script) || !isPlainAbsolute(script) || !NODE_SCRIPT.test(script)) {
    return unrecognised(`its script ${scriptToken} is not a .js file beside it`);
  }
  if (!fs.isFile(script)) return fail('shim-target-missing', name, `${shim} runs ${script}, which is not there.`, shim);

  // The shim's own rule: node.exe beside it, else `node` from the PATH.
  const sibling = w.join(dir, 'node.exe');
  const node = fs.isFile(sibling) ? sibling : resolveCliBinary('node', env, 'win32', fs);
  if (typeof node !== 'string' && (!node.ok || node.via !== 'exe')) {
    return fail('node-not-found', name, `${shim} needs node, and there is no node.exe beside it or on the PATH.`, shim);
  }
  return { ok: true, file: typeof node === 'string' ? node : node.file, prefixArgs: [script], via: 'npm-shim-node' };
}
