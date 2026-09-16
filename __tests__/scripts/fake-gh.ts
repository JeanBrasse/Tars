import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createHash } from 'node:crypto';

/**
 * A stand-in for gh, first on the PATH, so the release scripts can be driven
 * without the network and without ever reaching the real repository.
 *
 * It answers the calls the scripts make the way gh 2.88 does, measured on
 * 16/09: a missing release is `release not found` with exit 1, an outage is
 * `error connecting to ...` with the same exit 1, and a missing tag through
 * `gh api` is `gh: Not Found (HTTP 404)`. Anything else, `release create` first
 * of all, is refused with exit 99 and written to the log like every call.
 */

export type FakeAsset = { name: string; size: number; digest: string | null };
export type FakeGhState = {
  /** Every call fails as gh does with no network. */
  offline?: boolean;
  /** Per tag, a failure that is neither "not found" nor an outage. */
  failFor?: Record<string, string>;
  releases?: Record<string, { assets: FakeAsset[] }>;
  /** Tags that exist with no release. */
  tags?: string[];
  latest?: string;
};

const SCRIPT = `
const fs = require('fs');
const args = process.argv.slice(2);
fs.appendFileSync(process.env.FAKE_GH_LOG, JSON.stringify(args) + '\\n');
const state = JSON.parse(fs.readFileSync(process.env.FAKE_GH_STATE, 'utf8'));
const fail = (text, code) => { process.stderr.write(text + '\\n'); process.exit(code); };
const outage = () => fail('error connecting to api.github.com\\ncheck your internet connection or https://githubstatus.com', 1);
const [cmd, sub] = args;
if (cmd === 'release' && sub === 'view') {
  const tag = args[2];
  if (state.offline) outage();
  if (state.failFor && state.failFor[tag]) fail(state.failFor[tag], 1);
  const release = state.releases && state.releases[tag];
  if (!release) fail('release not found', 1);
  process.stdout.write(JSON.stringify({ tagName: tag, assets: release.assets.map(a => Object.assign({ state: 'uploaded' }, a)) }));
  process.exit(0);
}
if (cmd === 'release' && sub === 'list') {
  if (state.offline) outage();
  process.stdout.write(JSON.stringify(Object.keys(state.releases || {}).map(tagName => ({ tagName }))));
  process.exit(0);
}
if (cmd === 'api') {
  if (state.offline) outage();
  const ref = /^repos\\/[^/]+\\/[^/]+\\/git\\/ref\\/tags\\/(.+)$/.exec(args[1] || '');
  if (ref) {
    if ((state.tags || []).includes(ref[1]) || (state.releases && state.releases[ref[1]])) {
      process.stdout.write(JSON.stringify({ object: { type: 'commit', sha: '0'.repeat(40) } }));
      process.exit(0);
    }
    fail('gh: Not Found (HTTP 404)', 1);
  }
  if (/^repos\\/[^/]+\\/[^/]+\\/releases\\/latest$/.test(args[1] || '')) {
    process.stdout.write(JSON.stringify({ tag_name: state.latest }));
    process.exit(0);
  }
}
fail('fake gh: not a call these scripts may make here: ' + args.join(' '), 99);
`;

export type FakeGh = {
  /** Put the fake first on the PATH for everything this process starts. */
  install(): void;
  /** Put the PATH back as it was. */
  uninstall(): void;
  setState(state: FakeGhState): void;
  /** Every argv gh was called with, in order. */
  calls(): string[][];
};

export function fakeGh(state: FakeGhState = {}): FakeGh {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tars-fake-gh-'));
  const bin = path.join(dir, 'bin');
  fs.mkdirSync(bin);
  const gh = path.join(bin, 'gh');
  fs.writeFileSync(gh, `#!${process.execPath}\n${SCRIPT}`, { mode: 0o755 });
  const stateFile = path.join(dir, 'state.json');
  const logFile = path.join(dir, 'calls.log');
  fs.writeFileSync(stateFile, JSON.stringify(state));
  fs.writeFileSync(logFile, '');

  const saved: Record<string, string | undefined> = {};
  return {
    install() {
      for (const key of ['PATH', 'FAKE_GH_STATE', 'FAKE_GH_LOG']) saved[key] = process.env[key];
      process.env.PATH = `${bin}${path.delimiter}${process.env.PATH ?? ''}`;
      process.env.FAKE_GH_STATE = stateFile;
      process.env.FAKE_GH_LOG = logFile;
    },
    uninstall() {
      for (const [key, value] of Object.entries(saved)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    },
    setState(next) {
      fs.writeFileSync(stateFile, JSON.stringify(next));
    },
    calls() {
      return fs.readFileSync(logFile, 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line));
    },
  };
}

export const sha256 = (content: string | Buffer) => `sha256:${createHash('sha256').update(content).digest('hex')}`;

/** The assets GitHub would list for a version whose dmg and zip hold `content`. */
export function publishedAssets(version: string, content = 'x', extra: FakeAsset[] = []): FakeAsset[] {
  return [
    { name: `Tars-${version}-arm64.dmg`, size: Buffer.byteLength(content), digest: sha256(content) },
    { name: `Tars-${version}-arm64-mac.zip`, size: Buffer.byteLength(content), digest: sha256(content) },
    ...extra,
  ];
}
