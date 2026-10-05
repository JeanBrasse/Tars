/**
 * Where the state mod is handed from (electron/services/state-mod.ts,
 * installStateMod and stateModDir).
 *
 * From the Audit's delta gate of #308 (measured on claude 2.1.289): Claude
 * Code writes `.claude-plugin/types/` and a tsconfig into a mod's folder every
 * time it loads it, not only on `claude plugin validate`. Handed from
 * `process.resourcesPath`, every agent's claude would write into Tars.app,
 * inside the signed bundle. With the folder read-only the mod loads, works,
 * and nothing is written.
 *
 * How it fails, written before the code (2026-10-05):
 * 1. The folder handed to claude can be written to: a file or a folder in it
 *    keeps a write bit, and Claude Code's load writes beside the mod.
 * 2. The copy is not the shipped mod: a file missing, or another content.
 * 3. A copy left by an earlier launch, read-only, is kept or merged: a file
 *    the shipped mod no longer has stays, or a changed one is not updated,
 *    or the read-only copy cannot be replaced at all.
 * 4. The shipped folder itself is handed, or a folder every agent is handed
 *    (~/.dorothy), from which an agent could change the code that runs inside
 *    every other agent's claude.
 * 5. A copy that fails hands a half folder, or throws into the launch: the
 *    launch must go on without the mod, on the shell hooks.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const { userData } = vi.hoisted(() => ({
  userData: `${process.env.TMPDIR?.replace(/\/$/, '') || '/tmp'}/tars-mod-userdata-${process.pid}-${Date.now()}`,
}));
vi.mock('electron', () => ({
  app: { isPackaged: false, getAppPath: () => process.cwd(), getPath: (name: string) => (name === 'userData' ? userData : os.tmpdir()) },
}));

import { installStateMod, stateModDir } from '../../../electron/services/state-mod';

let root: string;
let source: string;
let target: string;

function writable(p: string): boolean {
  return (fs.statSync(p).mode & 0o222) !== 0;
}
function walk(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap(e => {
    const p = path.join(dir, e.name);
    return e.isDirectory() ? [p, ...walk(p)] : [p];
  });
}
/** A read-only tree cannot be removed until it is writable again. */
function unlock(dir: string): void {
  if (!fs.existsSync(dir)) return;
  fs.chmodSync(dir, 0o755);
  for (const p of walk(dir)) fs.chmodSync(p, fs.statSync(p).isDirectory() ? 0o755 : 0o644);
}

beforeEach(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'tars-mod-install-')));
  source = path.join(root, 'shipped', 'tars-state');
  target = path.join(root, 'own', 'mods', 'tars-state');
  fs.mkdirSync(path.join(source, '.claude-plugin'), { recursive: true });
  fs.mkdirSync(path.join(source, 'hooks'), { recursive: true });
  fs.writeFileSync(path.join(source, '.claude-plugin', 'plugin.json'), '{"name":"tars-state"}');
  fs.writeFileSync(path.join(source, 'hooks', 'hooks.json'), '{"modules":["./register.ts"]}');
  fs.writeFileSync(path.join(source, 'hooks', 'register.ts'), 'export function register() {}\n');
});

afterEach(() => {
  unlock(root);
  fs.rmSync(root, { recursive: true, force: true });
  unlock(userData);
  fs.rmSync(userData, { recursive: true, force: true });
});

describe('the mod Tars hands to claude', () => {
  it('1, 2. is a read-only copy of the shipped mod: every file and folder, the same content, no write bit', () => {
    expect(installStateMod(source, target)).toBe(target);
    const rel = (p: string, base: string) => path.relative(base, p);
    expect(walk(target).map(p => rel(p, target)).sort()).toEqual(walk(source).map(p => rel(p, source)).sort());
    expect(fs.readFileSync(path.join(target, 'hooks', 'register.ts'), 'utf8')).toBe('export function register() {}\n');
    for (const p of [target, ...walk(target)]) expect(writable(p), p).toBe(false);
    if (process.getuid?.() !== 0) {
      expect(() => fs.mkdirSync(path.join(target, '.claude-plugin', 'types'))).toThrow();
      expect(() => fs.writeFileSync(path.join(target, 'tsconfig.json'), '{}')).toThrow();
    }
  });

  it('3. replaces the copy an earlier launch left, read-only, with the shipped mod as it is now', () => {
    installStateMod(source, target);
    fs.writeFileSync(path.join(source, 'hooks', 'register.ts'), 'export function register() { /* v2 */ }\n');
    fs.mkdirSync(path.join(source, 'extra'));
    fs.writeFileSync(path.join(source, 'extra', 'new.ts'), 'x');
    fs.rmSync(path.join(source, 'hooks', 'hooks.json'));
    fs.writeFileSync(path.join(source, 'hooks', 'hooks.json'), '{"modules":["./register.ts"],"v":2}');
    unlock(path.join(root, 'shipped'));
    expect(installStateMod(source, target)).toBe(target);
    expect(fs.readFileSync(path.join(target, 'hooks', 'register.ts'), 'utf8')).toContain('v2');
    expect(fs.existsSync(path.join(target, 'extra', 'new.ts'))).toBe(true);
    expect(writable(path.join(target, 'extra', 'new.ts'))).toBe(false);
  });

  it('3. leaves nothing of an older copy the shipped mod no longer has', () => {
    fs.mkdirSync(path.join(source, 'old'));
    fs.writeFileSync(path.join(source, 'old', 'gone.ts'), 'x');
    installStateMod(source, target);
    unlock(path.join(root, 'shipped'));
    fs.rmSync(path.join(source, 'old'), { recursive: true });
    installStateMod(source, target);
    expect(fs.existsSync(path.join(target, 'old'))).toBe(false);
  });

  it('5. a copy that fails hands nothing and throws nothing', () => {
    expect(installStateMod(path.join(root, 'missing'), target)).toBeNull();
    expect(fs.existsSync(target)).toBe(false);
  });

  it("4. is Tars's own folder, neither the shipped one nor one an agent is handed", () => {
    const dir = stateModDir();
    expect(dir).toBe(path.join(userData, 'mods', 'tars-state'));
    expect(dir.startsWith(path.join(process.cwd(), 'mods'))).toBe(false);
    expect(dir.includes(`${path.sep}.dorothy${path.sep}`)).toBe(false);
    expect(writable(dir)).toBe(false);
    expect(fs.existsSync(path.join(dir, 'hooks', 'register.ts'))).toBe(true);
  });
});
