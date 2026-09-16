import { afterAll } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createRequire, syncBuiltinESMExports } from 'node:module';
import { fileURLToPath } from 'node:url';

/**
 * The suite runs in a HOME of its own, and cannot write into the one it started in.
 *
 * Measured on 2026-09-16: Noah's real ~/.claude.json held 171 project entries
 * written by this suite, one per run since 2026-09-02, each for a temp directory
 * that no longer existed. managed-cli-env.test.ts spawns through the real
 * initAgentPty and spawnAgentSession, both call ensureProjectTrusted, and that
 * reads the whole of `os.homedir()/.claude.json` and writes it back with one
 * more project. env-isolation.ts kept HOME on purpose and left each suite to
 * redirect it, and that suite never did. With the guard below and without the
 * redirect, three files write into the home they start in: that one and
 * task-never-started.test.ts into ~/.claude.json, and
 * agent-start-missing-skills.test.ts into ~/.dorothy/amp-settings.json, which
 * Noah's copy shows rewritten at the minute a suite ran. A rule each file has to
 * remember is how the class got three members.
 *
 * So this does it for every file, before the file's imports, which matters for
 * the same reason it does in env-isolation.ts: constants.ts computes DATA_DIR
 * from `os.homedir()` at module load. Children spawned without an explicit HOME
 * inherit the throwaway one too.
 *
 * The redirect removes the cause. The guard below is the witness that it holds:
 * any write, through node:fs, into the HOME the run started with or into the
 * account's home directory fails, and fails the file even when the product
 * swallows the error, as ensureProjectTrusted does. The repository is the one
 * place under that home a test may write. What it cannot see: a native module
 * writing on its own (better-sqlite3), and a child given the real HOME
 * explicitly.
 */

type Violation = { op: string; path: string; stack: string };

type HomeGuard = {
  /** HOME as the run found it, before this file replaced it. */
  originalHome: string | undefined;
  /** The account's home directory, which no environment variable can move. */
  accountHome: string;
  throwawayHome: string;
  protectedRoots: string[];
  allowedRoots: string[];
  violations: Violation[];
  protect(root: string): void;
  unprotect(root: string): void;
};

const KEY = Symbol.for('tars.test.homeGuard');

/** The module object itself: the ESM namespace imported above is frozen, and
 *  syncBuiltinESMExports copies this one into it. */
const nodeFs = createRequire(import.meta.url)('node:fs') as typeof fs;
const globals = globalThis as typeof globalThis & { [KEY]?: HomeGuard };

/** The path as the filesystem resolves it, for a target that may not exist yet. */
function canonical(target: string): string {
  const absolute = path.resolve(target);
  const rest: string[] = [];
  let current = absolute;
  for (;;) {
    try {
      return path.join(fs.realpathSync.native(current), ...rest.reverse());
    } catch {
      const parent = path.dirname(current);
      if (parent === current) return absolute;
      rest.push(path.basename(current));
      current = parent;
    }
  }
}

function inside(target: string, root: string): boolean {
  return target === root || target.startsWith(root + path.sep);
}

function pathOf(value: unknown): string | undefined {
  if (typeof value === 'string') return value;
  if (value instanceof URL) return value.protocol === 'file:' ? fileURLToPath(value) : undefined;
  if (Buffer.isBuffer(value)) return value.toString();
  return undefined;
}

/** A container can run a uid with no passwd entry, and then there is no account home to name. */
function accountHome(): string {
  try {
    return os.userInfo().homedir;
  } catch {
    return '';
  }
}

const firstRun = !globals[KEY];
const guard: HomeGuard = globals[KEY] ?? {
  originalHome: process.env.HOME,
  accountHome: accountHome(),
  throwawayHome: '',
  protectedRoots: [],
  allowedRoots: [],
  violations: [],
  protect(root) { this.protectedRoots.push(canonical(root)); },
  unprotect(root) {
    const at = this.protectedRoots.lastIndexOf(canonical(root));
    if (at >= 0) this.protectedRoots.splice(at, 1);
  },
};
globals[KEY] = guard;

if (firstRun) {
  for (const home of [guard.originalHome, guard.accountHome]) {
    if (home) guard.protect(home);
  }
}

guard.throwawayHome = fs.mkdtempSync(path.join(os.tmpdir(), 'tars-vitest-home-'));
guard.allowedRoots = [canonical(process.cwd()), canonical(guard.throwawayHome)];
process.env.HOME = guard.throwawayHome;

function violationAt(value: unknown): string | undefined {
  const target = pathOf(value);
  if (target === undefined) return undefined;
  const resolved = canonical(target);
  if (!guard.protectedRoots.some(root => inside(resolved, root))) return undefined;
  if (guard.allowedRoots.some(root => inside(resolved, root))) return undefined;
  return resolved;
}

function refuse(op: string, target: string): Error {
  const error = new Error(
    `home-isolation: ${op} into ${target}, outside the throwaway HOME the suite runs in. `
    + 'A test reached the real home directory; see __tests__/setup/home-isolation.ts.',
  ) as Error & { code: string };
  error.code = 'E_TARS_HOME_GUARD';
  guard.violations.push({ op, path: target, stack: new Error().stack ?? '' });
  return error;
}

const O_WRITE = fs.constants.O_WRONLY | fs.constants.O_RDWR | fs.constants.O_CREAT
  | fs.constants.O_TRUNC | fs.constants.O_APPEND;

/** open() writes only with a writing flag; reading the real home stays allowed. */
function opensForWriting(flags: unknown): boolean {
  if (typeof flags === 'number') return (flags & O_WRITE) !== 0;
  return typeof flags === 'string' && /[wa+]/.test(flags);
}

type Style = 'sync' | 'callback' | 'promise';

/**
 * Replace `holder[name]` with a version that refuses a write into a protected
 * root. `paths` lists which arguments are write targets; `when` narrows it, for
 * open(), to the calls that write.
 */
function wrap(holder: any, name: string, style: Style, paths: number[], when?: (args: unknown[]) => boolean): void {
  const original = holder?.[name];
  if (typeof original !== 'function' || original.__homeGuarded) return;
  const op = holder === nodeFs.promises ? `fs.promises.${name}` : `fs.${name}`;
  const wrapped = function (this: unknown, ...args: unknown[]) {
    if (!when || when(args)) {
      for (const index of paths) {
        const target = violationAt(args[index]);
        if (target === undefined) continue;
        const error = refuse(op, target);
        if (style === 'promise') return Promise.reject(error);
        const callback = args[args.length - 1];
        if (style === 'callback' && typeof callback === 'function') {
          process.nextTick(() => callback(error));
          return undefined;
        }
        throw error;
      }
    }
    return original.apply(this, args);
  };
  // Whatever a caller may read off the function, such as a promisify hook,
  // but not what every function already has of its own.
  const own = Object.getOwnPropertyDescriptors(original) as Record<string, PropertyDescriptor>;
  for (const intrinsic of ['length', 'name', 'prototype', 'arguments', 'caller']) delete own[intrinsic];
  Object.defineProperties(wrapped, own);
  Object.defineProperty(wrapped, '__homeGuarded', { value: true });
  holder[name] = wrapped;
}

if (firstRun) {
  const first = [0];
  const second = [1];
  const both = [0, 1];
  const writing = (args: unknown[]) => opensForWriting(args[1]);
  for (const [name, targets] of [
    ['writeFile', first], ['appendFile', first], ['mkdir', first], ['mkdtemp', first],
    ['rename', both], ['copyFile', second], ['cp', second], ['rm', first], ['rmdir', first],
    ['unlink', first], ['symlink', second], ['link', second], ['truncate', first],
    ['utimes', first], ['lutimes', first], ['chmod', first], ['lchmod', first],
    ['chown', first], ['lchown', first],
  ] as const) {
    wrap(nodeFs, `${name}Sync`, 'sync', [...targets]);
    wrap(nodeFs, name, 'callback', [...targets]);
    wrap(nodeFs.promises, name, 'promise', [...targets]);
  }
  wrap(nodeFs, 'openSync', 'sync', first, writing);
  wrap(nodeFs, 'open', 'callback', first, writing);
  wrap(nodeFs.promises, 'open', 'promise', first, writing);
  wrap(nodeFs, 'createWriteStream', 'sync', first);
  // `import * as fs` and named imports of node:fs are ESM bindings copied from
  // the module object; without this they would keep the unguarded functions.
  syncBuiltinESMExports();
}

afterAll(() => {
  const found = guard.violations.splice(0);
  fs.rmSync(guard.throwawayHome, { recursive: true, force: true });
  if (guard.originalHome === undefined) delete process.env.HOME;
  else process.env.HOME = guard.originalHome;
  if (found.length > 0) {
    const lines = found.map(v => {
      const where = v.stack.split('\n').find(line => line.includes(process.cwd()) && !line.includes('home-isolation.ts'));
      return `  ${v.op} ${v.path}${where ? `\n    ${where.trim()}` : ''}`;
    });
    throw new Error(`home-isolation: this file wrote outside its throwaway HOME, into the home it started in:\n${lines.join('\n')}`);
  }
});
