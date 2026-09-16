import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import { writeFileSync as namedWriteFileSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

/**
 * The witness for __tests__/setup/home-isolation.ts.
 *
 * What leaked was ensureProjectTrusted writing a project into the real
 * ~/.claude.json on every run of managed-cli-env.test.ts, 171 entries by
 * 2026-09-16. These hold the fix to that path: the write lands in the throwaway
 * HOME, and pointed at a protected home it is refused before it happens, even
 * though that function swallows the error.
 *
 * The refusals are exercised on a directory protected for the test, never on
 * the real home: a guard that failed here would otherwise write into it.
 */

// As stop-failure.test.ts: agent-manager is real, what reaches outside is stubbed.
vi.mock('node-pty', () => ({ spawn: vi.fn() }));
vi.mock('uuid', () => ({ v4: vi.fn(() => 'pty-1') }));
vi.mock('electron', () => ({
  app: { getPath: () => os.tmpdir(), getAppPath: () => process.cwd() },
  BrowserWindow: { getAllWindows: vi.fn(() => []) },
}));
vi.mock('../../electron/utils/broadcast', () => ({ broadcastToAllWindows: vi.fn() }));
vi.mock('../../electron/core/pty-manager', () => ({ ptyProcesses: new Map(), writeProgrammaticInput: vi.fn() }));
vi.mock('../../electron/utils/path-builder', () => ({ buildFullPath: vi.fn(() => '/usr/bin') }));

import { ensureProjectTrusted } from '../../electron/core/agent-manager';

type HomeGuard = {
  originalHome: string | undefined;
  accountHome: string;
  throwawayHome: string;
  protectedRoots: string[];
  violations: { op: string; path: string }[];
  protect(root: string): void;
  unprotect(root: string): void;
};

const guard = (globalThis as Record<symbol, unknown>)[Symbol.for('tars.test.homeGuard')] as HomeGuard;

function project(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'tars-home-isolation-project-'));
}

describe('the suite runs in a HOME of its own', () => {
  it('points HOME at a fresh directory under the temp dir, not the one the run started with', () => {
    expect(guard, 'home-isolation.ts is not among the setup files').toBeDefined();
    expect(os.homedir()).toBe(guard.throwawayHome);
    expect(process.env.HOME).toBe(guard.throwawayHome);
    expect(guard.originalHome, 'the run started without a HOME, so there is nothing to protect').toBeTruthy();
    expect(os.homedir()).not.toBe(guard.originalHome);
    expect(fs.realpathSync.native(os.homedir()).startsWith(fs.realpathSync.native(os.tmpdir()) + path.sep)).toBe(true);
  });

  it('protects the home the run started in, and the account home', () => {
    expect(guard.protectedRoots).toContain(fs.realpathSync.native(guard.originalHome as string));
    if (guard.accountHome) expect(guard.protectedRoots).toContain(fs.realpathSync.native(guard.accountHome));
  });

  it('sends the trust write that leaked into ~/.claude.json to the throwaway HOME', () => {
    const trusted = project();
    ensureProjectTrusted(trusted);

    const written = JSON.parse(fs.readFileSync(path.join(os.homedir(), '.claude.json'), 'utf-8'));
    expect(written.projects[trusted]).toMatchObject({ hasTrustDialogAccepted: true });
    expect(guard.violations).toEqual([]);
  });

  it('still lets a test write into the repository, which sits under the same home', () => {
    const scratch = fs.mkdtempSync(path.join(process.cwd(), 'node_modules', '.tars-home-isolation-'));
    fs.writeFileSync(path.join(scratch, 'ok'), 'ok');
    fs.rmSync(scratch, { recursive: true, force: true });
    expect(guard.violations).toEqual([]);
  });
});

describe('a write into a protected home', () => {
  let protectedHome: string;
  let outside: string;
  let homeBefore: string | undefined;

  beforeEach(() => {
    protectedHome = fs.mkdtempSync(path.join(os.tmpdir(), 'tars-home-isolation-protected-'));
    fs.writeFileSync(path.join(protectedHome, 'existing'), 'kept');
    outside = fs.mkdtempSync(path.join(os.tmpdir(), 'tars-home-isolation-outside-'));
    fs.writeFileSync(path.join(outside, 'source'), 'source');
    guard.protect(protectedHome);
    homeBefore = process.env.HOME;
  });

  afterEach(() => {
    process.env.HOME = homeBefore;
    guard.unprotect(protectedHome);
    fs.rmSync(protectedHome, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
  });

  it('is refused on the product path that leaked, and recorded although the product swallows it', () => {
    process.env.HOME = protectedHome;
    ensureProjectTrusted(project());

    expect(fs.existsSync(path.join(protectedHome, '.claude.json'))).toBe(false);
    // Consumed here, because the setup file fails the whole file on any record
    // left at its end: that is what catches a swallowed refusal.
    expect(guard.violations.splice(0).map(v => [v.op, v.path])).toEqual([
      ['fs.writeFileSync', path.join(fs.realpathSync.native(protectedHome), '.claude.json')],
    ]);
  });

  it('is refused through every way node:fs writes, while reading stays allowed', async () => {
    const at = (name: string) => path.join(protectedHome, name);
    const source = path.join(outside, 'source');
    const refusedSync: Array<[string, () => unknown]> = [
      ['writeFileSync', () => fs.writeFileSync(at('a'), 'x')],
      ['named import', () => namedWriteFileSync(at('b'), 'x')],
      ['appendFileSync', () => fs.appendFileSync(at('existing'), 'x')],
      ['mkdirSync', () => fs.mkdirSync(at('c'))],
      ['mkdtempSync', () => fs.mkdtempSync(at('d-'))],
      ['renameSync into', () => fs.renameSync(source, at('e'))],
      ['renameSync out of', () => fs.renameSync(at('existing'), path.join(outside, 'moved'))],
      ['copyFileSync', () => fs.copyFileSync(source, at('f'))],
      ['cpSync', () => fs.cpSync(source, at('g'))],
      ['rmSync', () => fs.rmSync(at('existing'))],
      ['unlinkSync', () => fs.unlinkSync(at('existing'))],
      ['symlinkSync', () => fs.symlinkSync(source, at('h'))],
      ['truncateSync', () => fs.truncateSync(at('existing'))],
      ['chmodSync', () => fs.chmodSync(at('existing'), 0o600)],
      ['openSync for writing', () => fs.openSync(at('i'), 'w')],
      ['createWriteStream', () => fs.createWriteStream(at('j'))],
    ];
    for (const [how, write] of refusedSync) {
      let thrown: unknown;
      try {
        write();
      } catch (error) {
        thrown = error;
      }
      expect((thrown as NodeJS.ErrnoException | undefined)?.code, how).toBe('E_TARS_HOME_GUARD');
    }
    await expect(fs.promises.writeFile(at('k'), 'x')).rejects.toMatchObject({ code: 'E_TARS_HOME_GUARD' });
    await expect(fs.promises.mkdir(at('l'))).rejects.toMatchObject({ code: 'E_TARS_HOME_GUARD' });
    await expect(fs.promises.open(at('m'), 'a')).rejects.toMatchObject({ code: 'E_TARS_HOME_GUARD' });
    const callbackError = await new Promise<NodeJS.ErrnoException | null>(resolve => fs.writeFile(at('n'), 'x', resolve));
    expect(callbackError).toMatchObject({ code: 'E_TARS_HOME_GUARD' });

    // Reading the real home is not what leaked, and stays possible.
    expect(fs.readFileSync(at('existing'), 'utf-8')).toBe('kept');
    fs.closeSync(fs.openSync(at('existing'), 'r'));

    const refusals = refusedSync.length + 4;
    expect(guard.violations.splice(0)).toHaveLength(refusals);
    expect(fs.readdirSync(protectedHome)).toEqual(['existing']);
    expect(fs.readFileSync(at('existing'), 'utf-8')).toBe('kept');
    expect(fs.existsSync(source)).toBe(true);
  });
});
