import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fakeGh, publishedAssets, sha256, type FakeGh, type FakeGhState } from './fake-gh';
import { main, moveToCanonical, Refusal } from '../../scripts/release.mjs';

/**
 * `npm run release`, the only way a release is published, and every way it
 * refuses to start.
 *
 * Each case builds a real git checkout with a local origin, so HEAD, the fetch
 * and the tree are git's own answers, and puts a fake gh first on the PATH.
 * The first case passes every check: the others break exactly one thing each,
 * so a refusal is that check and not the setup. No test builds, publishes, or
 * reaches the real release/ or GitHub.
 */

const VERSION = '2.0.1';
const REPO = 'acme/tars';
const gitEnv = { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' };
const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, env: gitEnv, stdio: 'pipe', encoding: 'utf8' });

/** What GitHub holds before this release: the version before it, as latest. */
const BEFORE: FakeGhState = { releases: { 'v2.0.0': { assets: publishedAssets('2.0.0') } }, latest: 'v2.0.0' };

let gh: FakeGh;

beforeEach(() => {
  gh = fakeGh(BEFORE);
  gh.install();
});

afterEach(() => {
  gh.uninstall();
});

function changelog(top: string): string {
  return 'export interface Release { id: number; version: string; date: string; updates: string[] }\n\n'
    + 'export const CHANGELOG: Release[] = [\n'
    + `  { id: 2, version: '${top}', date: '2026-09-16', updates: ['An agent\\'s change, said the way the app says it'] },\n`
    + "  { id: 1, version: '2.0.0', date: '2026-09-01', updates: ['The one before'] },\n"
    + '];\n';
}

/** A main checkout of `main`, pushed to a local origin, clean. */
function checkout({ changelogTop = VERSION } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tars-release-'));
  const origin = path.join(root, 'origin.git');
  git(root, 'init', '-q', '--bare', '-b', 'main', origin);
  const dir = path.join(root, 'checkout');
  fs.mkdirSync(path.join(dir, 'src', 'data'), { recursive: true });
  git(dir, 'init', '-q', '-b', 'main');
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({
    name: 'tars',
    version: VERSION,
    // What a build would leave behind, if a dry run ever started one.
    scripts: { 'electron:build': "node -e \"require('fs').writeFileSync('BUILD_RAN', '')\"" },
    build: { publish: { provider: 'github', owner: 'acme', repo: 'tars' } },
  }, null, 2));
  fs.writeFileSync(path.join(dir, 'src', 'data', 'changelog.ts'), changelog(changelogTop));
  fs.writeFileSync(path.join(dir, 'README.md'), 'tars\n');
  fs.writeFileSync(path.join(dir, '.gitignore'), 'release/\n');
  git(dir, 'add', '.');
  git(dir, 'commit', '-q', '-m', 'init');
  git(dir, 'remote', 'add', 'origin', origin);
  git(dir, 'push', '-q', '-u', 'origin', 'main');
  return { root, dir };
}

const base64Sha512 = (content: Buffer | string) => createHash('sha512').update(content).digest('base64');

/** A build of `version` in `releaseDir`, as electron-builder lays it out. */
function artifacts(releaseDir: string, version: string, { wrongSha = false } = {}) {
  fs.mkdirSync(path.join(releaseDir, 'mac-arm64', 'Tars.app', 'Contents'), { recursive: true });
  const dmg = `Tars-${version}-arm64.dmg`;
  const zip = `Tars-${version}-arm64-mac.zip`;
  const dmgBytes = `dmg of ${version}`;
  const zipBytes = `zip of ${version}`;
  fs.writeFileSync(path.join(releaseDir, dmg), dmgBytes);
  fs.writeFileSync(path.join(releaseDir, zip), zipBytes);
  fs.writeFileSync(path.join(releaseDir, `${dmg}.blockmap`), 'b');
  fs.writeFileSync(path.join(releaseDir, `${zip}.blockmap`), 'b');
  fs.writeFileSync(path.join(releaseDir, 'builder-debug.yml'), `debug of ${version}`);
  const zipSha = wrongSha ? base64Sha512('something else') : base64Sha512(zipBytes);
  fs.writeFileSync(path.join(releaseDir, 'latest-mac.yml'), [
    `version: ${version}`,
    'files:',
    `  - url: ${zip}`,
    `    sha512: ${zipSha}`,
    `    size: ${Buffer.byteLength(zipBytes)}`,
    `  - url: ${dmg}`,
    `    sha512: ${base64Sha512(dmgBytes)}`,
    `    size: ${Buffer.byteLength(dmgBytes)}`,
    `path: ${zip}`,
    `sha512: ${zipSha}`,
    "releaseDate: '2026-09-16T16:23:58.466Z'",
    '',
  ].join('\n'));
  fs.writeFileSync(path.join(releaseDir, 'mac-arm64', 'Tars.app', 'Contents', 'Info.plist'),
    '<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n'
    + `<plist version="1.0"><dict><key>CFBundleShortVersionString</key><string>${version}</string></dict></plist>\n`);
  return { dmg, zip, dmgBytes, zipBytes };
}

async function release(cwd: string, ...argv: string[]): Promise<{ code: number; out: string }> {
  const lines: string[] = [];
  const code = await main(argv, { cwd, log: (line: string) => lines.push(line) });
  return { code, out: lines.join('\n') };
}

describe('npm run release, before anything is built', () => {
  it('passes every check on a clean checkout of main, so each refusal below is the check it names', async () => {
    const { dir } = checkout();

    const { code, out } = await release(dir, '--dry-run');

    expect(out).toContain('1. checks passed');
    expect(code).toBe(0);
  });

  it('refuses a HEAD that is not origin/main', async () => {
    const { dir } = checkout();
    fs.writeFileSync(path.join(dir, 'README.md'), 'a commit nobody pushed\n');
    git(dir, 'commit', '-q', '-am', 'local only');

    const { code, out } = await release(dir, '--dry-run');

    expect(code).toBe(1);
    expect(out).toContain('is not origin/main');
  });

  it('refuses a tracked file that differs from HEAD', async () => {
    const { dir } = checkout();
    fs.writeFileSync(path.join(dir, 'README.md'), 'edited, not committed\n');

    const { code, out } = await release(dir, '--dry-run');

    expect(code).toBe(1);
    expect(out).toContain('tracked files differ from HEAD');
  });

  it('refuses a version already published', async () => {
    const { dir } = checkout();
    gh.setState({ ...BEFORE, releases: { ...BEFORE.releases, [`v${VERSION}`]: { assets: publishedAssets(VERSION) } } });

    const { code, out } = await release(dir, '--dry-run');

    expect(code).toBe(1);
    expect(out).toContain(`v${VERSION} is already published on ${REPO}`);
  });

  it('refuses a tag that already exists without a release', async () => {
    const { dir } = checkout();
    gh.setState({ ...BEFORE, tags: [`v${VERSION}`] });

    const { code, out } = await release(dir, '--dry-run');

    expect(code).toBe(1);
    expect(out).toContain(`the tag v${VERSION} already exists on ${REPO}`);
  });

  it('refuses a changelog whose top entry is another version', async () => {
    const { dir } = checkout({ changelogTop: '2.0.2' });

    const { code, out } = await release(dir, '--dry-run');

    expect(code).toBe(1);
    expect(out).toContain(`the top entry of src/data/changelog.ts is 2.0.2, and package.json says ${VERSION}`);
  });

  it('refuses when a newer version is already published', async () => {
    const { dir } = checkout();
    gh.setState({ ...BEFORE, releases: { ...BEFORE.releases, 'v2.1.0': { assets: publishedAssets('2.1.0') } } });

    const { code, out } = await release(dir, '--dry-run');

    expect(code).toBe(1);
    expect(out).toContain(`a newer version is already published on ${REPO}: v2.1.0`);
  });

  it('refuses rather than guesses when GitHub cannot be asked', async () => {
    // The first question to fail is whether the release exists. Read as "not
    // found", the next check would refuse anyway, on the tag: the message is
    // what says which check held.
    const { dir } = checkout();
    gh.setState({ ...BEFORE, offline: true });

    const { code, out } = await release(dir, '--dry-run');

    expect(code).toBe(1);
    expect(out).toContain(`could not check whether v${VERSION} is published on ${REPO}`);
  });
});

describe('npm run release --dry-run', () => {
  /** Every path under these roots with its size, the .git internals aside: a fetch writes there. */
  function inventory(...roots: string[]): string[] {
    const found: string[] = [];
    const walk = (dir: string) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (entry.name === '.git') continue;
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else found.push(`${full} ${fs.statSync(full).size}`);
      }
    };
    for (const root of roots) walk(root);
    return found.sort();
  }

  it('builds, publishes, moves and deletes nothing, from a worktree with a build ready', async () => {
    const { root, dir } = checkout();
    // The folder that is kept holds five older published versions: a real run
    // would prune two of them.
    const kept = path.join(dir, 'release');
    fs.mkdirSync(kept);
    const older = ['1.9.6', '1.9.7', '1.9.8', '1.9.9', '2.0.0'];
    for (const v of older) {
      for (const suffix of ['-arm64.dmg', '-arm64-mac.zip']) fs.writeFileSync(path.join(kept, `Tars-${v}${suffix}`), 'x');
    }
    gh.setState({ ...BEFORE, releases: Object.fromEntries(older.map(v => [`v${v}`, { assets: publishedAssets(v) }])) });
    const worktree = path.join(root, 'worktree');
    git(dir, 'worktree', 'add', '-q', '--detach', worktree, 'origin/main');
    artifacts(path.join(worktree, 'release'), VERSION);
    const before = inventory(dir, worktree);

    const { code, out } = await release(worktree, '--dry-run');

    expect(out).toContain('1. checks passed');
    expect(out).toContain('3. artifacts checked');
    expect(out).toContain("- An agent's change, said the way the app says it");
    expect(code).toBe(0);
    expect(inventory(dir, worktree)).toEqual(before);
    expect(fs.existsSync(path.join(worktree, 'BUILD_RAN'))).toBe(false);
    const writes = gh.calls().filter(args => !['view', 'list'].includes(args[1]) && args[0] !== 'api');
    expect(writes, 'the dry run called gh for more than reading').toEqual([]);
  });

  it('stops on artifacts that do not match their manifest', async () => {
    const { dir } = checkout();
    artifacts(path.join(dir, 'release'), VERSION, { wrongSha: true });

    const { code, out } = await release(dir, '--dry-run');

    expect(code).toBe(1);
    expect(out).toContain(`the sha512 in latest-mac.yml is not that of Tars-${VERSION}-arm64-mac.zip`);
  });
});

describe('moving a build into the release/ that is kept', () => {
  function folders() {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tars-release-move-'));
    const fromDir = path.join(root, 'worktree-release');
    const toDir = path.join(root, 'kept-release');
    fs.mkdirSync(fromDir);
    fs.mkdirSync(toDir);
    return { fromDir, toDir };
  }

  const listing = (dir: string) => fs.readdirSync(dir).sort();

  it('will not overwrite a file of this version that has other bytes', async () => {
    const { fromDir, toDir } = folders();
    const { dmg } = artifacts(fromDir, VERSION);
    fs.writeFileSync(path.join(toDir, dmg), 'another build of the same version');
    const before = [listing(fromDir), listing(toDir)];

    await expect(moveToCanonical({ fromDir, toDir, version: VERSION, repo: REPO })).rejects.toThrow(Refusal);

    expect([listing(fromDir), listing(toDir)]).toEqual(before);
    expect(fs.readFileSync(path.join(toDir, dmg), 'utf8')).toBe('another build of the same version');
  });

  it('will not overwrite the build of an older version GitHub does not prove published', async () => {
    const { fromDir, toDir } = folders();
    artifacts(fromDir, VERSION);
    artifacts(toDir, '2.0.0');
    gh.setState({ latest: 'v1.9.9' });
    const before = [listing(fromDir), listing(toDir)];

    await expect(moveToCanonical({ fromDir, toDir, version: VERSION, repo: REPO }))
      .rejects.toThrow('holds 2.0.0, which is not proven published');

    expect([listing(fromDir), listing(toDir)]).toEqual(before);
    expect(fs.readFileSync(path.join(toDir, 'latest-mac.yml'), 'utf8')).toContain('version: 2.0.0');
  });

  it("replaces an older published build's manifest and app, and moves rather than copies", async () => {
    const { fromDir, toDir } = folders();
    artifacts(fromDir, VERSION);
    const old = artifacts(toDir, '2.0.0');
    gh.setState({
      releases: {
        'v2.0.0': {
          assets: [
            { name: old.dmg, size: Buffer.byteLength(old.dmgBytes), digest: sha256(old.dmgBytes) },
            { name: old.zip, size: Buffer.byteLength(old.zipBytes), digest: sha256(old.zipBytes) },
            { name: 'latest-mac.yml', size: 1, digest: sha256(fs.readFileSync(path.join(toDir, 'latest-mac.yml'))) },
          ],
        },
      },
    });

    const { moved } = await moveToCanonical({ fromDir, toDir, version: VERSION, repo: REPO });

    expect(moved).toContain(`Tars-${VERSION}-arm64.dmg`);
    expect(listing(fromDir)).toEqual([]);
    expect(fs.readFileSync(path.join(toDir, 'latest-mac.yml'), 'utf8')).toContain(`version: ${VERSION}`);
    expect(fs.readFileSync(path.join(toDir, 'mac-arm64', 'Tars.app', 'Contents', 'Info.plist'), 'utf8')).toContain(VERSION);
    // The older version's own files are the purge's business, not the move's.
    expect(listing(toDir)).toContain(old.dmg);
  });
});
