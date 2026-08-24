#!/usr/bin/env node
/**
 * Keep the current build and the two before it; delete the rest.
 *
 * `electron-builder` never cleans up after itself, so every build left another
 * 430MB in release/ and the directory reached 6.3GB across thirteen versions.
 * Deleting is safe because every one of them is published on GitHub, which is
 * where anyone would get an old version from anyway.
 *
 * Three are kept rather than one so a bad release can be compared against, or
 * handed to someone, without a rebuild.
 *
 * Only the packaged artifacts are touched. `latest-mac.yml` is the updater's
 * manifest for the current version, `mac-arm64/` is the unpacked app, and
 * neither accumulates.
 */
import { readdirSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';

const DIR = 'release';
const KEEP = 3;

/** `Tars-1.6.11-arm64.dmg` → `1.6.11`, and null for anything else. */
function versionOf(name) {
  const m = name.match(/^Tars-(\d+\.\d+\.\d+)-/);
  return m ? m[1] : null;
}

/** Newest first. Numeric per part, so 1.6.10 sorts above 1.6.9. */
function compareVersions(a, b) {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    if (pa[i] !== pb[i]) return pb[i] - pa[i];
  }
  return 0;
}

function humanSize(bytes) {
  return bytes >= 1024 ** 3
    ? `${(bytes / 1024 ** 3).toFixed(1)}GB`
    : `${Math.round(bytes / 1024 ** 2)}MB`;
}

let entries;
try {
  entries = readdirSync(DIR);
} catch {
  // Nothing built yet. Not an error: this runs as part of every build.
  process.exit(0);
}

const byVersion = new Map();
for (const name of entries) {
  const version = versionOf(name);
  if (!version) continue;
  const list = byVersion.get(version);
  if (list) list.push(name);
  else byVersion.set(version, [name]);
}

const versions = [...byVersion.keys()].sort(compareVersions);
const doomed = versions.slice(KEEP);

if (doomed.length === 0) {
  console.log(`release: ${versions.length} version(s), nothing to prune`);
  process.exit(0);
}

let freed = 0;
for (const version of doomed) {
  for (const name of byVersion.get(version)) {
    const path = join(DIR, name);
    try {
      freed += statSync(path).size;
      rmSync(path, { force: true });
    } catch {
      // Already gone, or unreadable. Neither is worth failing a build over.
    }
  }
}

console.log(
  `release: kept ${versions.slice(0, KEEP).join(', ')}; `
  + `pruned ${doomed.join(', ')} (${humanSize(freed)} freed)`,
);
