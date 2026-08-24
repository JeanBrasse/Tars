import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execFileSync } from 'child_process';

/**
 * Keeping the last three builds and deleting the rest.
 *
 * electron-builder never cleans up, so release/ reached 6.3GB across thirteen
 * versions. The part that has to be right is the ordering: a string sort puts
 * 1.6.9 above 1.6.10 and would delete the newest build in the directory.
 */

const script = path.resolve('scripts/prune-releases.mjs');

function run(versions: string[]): string[] {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tars-prune-'));
  const release = path.join(dir, 'release');
  fs.mkdirSync(release);
  for (const v of versions) {
    for (const suffix of ['-arm64.dmg', '-arm64.dmg.blockmap', '-arm64-mac.zip', '-arm64-mac.zip.blockmap']) {
      fs.writeFileSync(path.join(release, `Tars-${v}${suffix}`), 'x');
    }
  }
  // Things that are not versioned artifacts and must survive.
  fs.writeFileSync(path.join(release, 'latest-mac.yml'), 'version: x');
  fs.writeFileSync(path.join(release, 'builder-debug.yml'), 'x');
  fs.mkdirSync(path.join(release, 'mac-arm64'));

  execFileSync(process.execPath, [script], { cwd: dir, stdio: 'pipe' });

  const left = new Set<string>();
  for (const name of fs.readdirSync(release)) {
    const m = name.match(/^Tars-(\d+\.\d+\.\d+)-/);
    if (m) left.add(m[1]);
  }
  const survivors = fs.readdirSync(release);
  fs.rmSync(dir, { recursive: true, force: true });
  expect(survivors).toContain('latest-mac.yml');
  expect(survivors).toContain('builder-debug.yml');
  expect(survivors).toContain('mac-arm64');
  return [...left];
}

describe('pruning old builds', () => {
  it('keeps the three newest', () => {
    const kept = run(['1.6.5', '1.6.6', '1.6.7', '1.6.8']);
    expect(kept.sort()).toEqual(['1.6.6', '1.6.7', '1.6.8']);
  });

  it('sorts numerically, so 1.6.10 outranks 1.6.9', () => {
    // A string sort would delete the newest build in the directory.
    const kept = run(['1.6.8', '1.6.9', '1.6.10', '1.6.11']);
    expect(kept.sort()).toEqual(['1.6.10', '1.6.11', '1.6.9']);
  });

  it('crosses a minor version correctly', () => {
    const kept = run(['1.5.9', '1.6.0', '1.6.1', '1.7.0']);
    expect(kept.sort()).toEqual(['1.6.0', '1.6.1', '1.7.0']);
  });

  it('leaves three or fewer alone', () => {
    expect(run(['1.6.10', '1.6.11']).sort()).toEqual(['1.6.10', '1.6.11']);
  });

  it('deletes every file of a pruned version, not just the dmg', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tars-prune-'));
    const release = path.join(dir, 'release');
    fs.mkdirSync(release);
    for (const v of ['1.6.1', '1.6.2', '1.6.3', '1.6.4']) {
      for (const suffix of ['-arm64.dmg', '-arm64.dmg.blockmap', '-arm64-mac.zip', '-arm64-mac.zip.blockmap']) {
        fs.writeFileSync(path.join(release, `Tars-${v}${suffix}`), 'x');
      }
    }
    execFileSync(process.execPath, [script], { cwd: dir, stdio: 'pipe' });
    const left = fs.readdirSync(release);
    expect(left.filter(n => n.includes('1.6.1-'))).toEqual([]);
    expect(left.filter(n => n.includes('1.6.4-'))).toHaveLength(4);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('does not fail when there is nothing built', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tars-prune-'));
    expect(() => execFileSync(process.execPath, [script], { cwd: dir, stdio: 'pipe' })).not.toThrow();
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
