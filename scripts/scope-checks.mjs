#!/usr/bin/env node
/**
 * Decide whether this change can have moved a rendered surface, and run the
 * end to end suite only when it can.
 *
 * The suite starts a Next server, launches Electron and walks thirty five
 * surfaces: about three minutes, against a few seconds for both tsc passes and
 * forty five for the unit tests. Running it after a change that could not
 * possibly have altered a pixel is most of the cost of a review round for
 * nothing.
 *
 * The rule is an allowlist, not a denylist, and that direction is the whole
 * point: a path this file has never heard of runs the suite. Missing a visual
 * regression costs incomparably more than three minutes, so every doubt,
 * including a brand new directory nobody has classified yet, resolves towards
 * running.
 *
 * Note what is deliberately NOT on the allowlist. `electron/` is not, even
 * though its files are not the renderer: the suite boots the real application
 * against a seeded home directory, so what a surface displays comes through
 * real main process code. window-manager.ts decides how the window is created,
 * preload.ts is the renderer's whole contract, and the services behind Chat and
 * Usage decide what those pages have to show. An electron change absolutely
 * can move a screenshot, and has.
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

const run = promisify(execFile);

/**
 * Paths that cannot reach a rendered surface, whatever they contain.
 *
 * Each entry has to be defensible on its own: not "probably fine", but "there
 * is no path from this file to a pixel in the running app".
 */
const CANNOT_REACH_THE_RENDERER = [
  // Test code. Runs beside the app, never inside it.
  { prefix: '__tests__/', why: 'unit tests, not shipped into the app' },
  // Separate bundles, spawned as their own processes by the CLIs.
  { match: /^mcp-[^/]+\//, why: 'an MCP server bundle, a separate process' },
  // Shell hooks installed into the coding CLIs.
  { prefix: 'hooks/', why: 'shell hooks for the CLIs, outside the app' },
  // Build and development tooling, including this file.
  { prefix: 'scripts/', why: 'build and development tooling' },
  { prefix: '.github/', why: 'CI configuration' },
  // The marketing site is its own Next app.
  { prefix: 'landing/', why: 'the landing site, a separate app' },
  // Prompt text handed to agents. Read by CLIs, never rendered.
  { match: /^electron\/resources\/.*\.md$/, why: 'agent prompt text, never rendered' },
  // Documentation.
  { match: /^[^/]+\.md$/, why: 'documentation' },
  { match: /^\.[^/]+$/, why: 'a repository dotfile' },
];

/** Where the suite lives, so a change to it always runs it. */
const ALWAYS_RUNS = ['e2e/', 'playwright.config.ts'];

/**
 * Why each changed file does or does not force the suite.
 * @param {string[]} files
 */
export function decide(files) {
  const unique = [...new Set(files.filter(Boolean))].sort();
  if (unique.length === 0) {
    return {
      runE2E: true,
      reason: 'nothing to compare against, so nothing can be ruled out',
      forcing: [],
      skipped: [],
    };
  }

  const forcing = [];
  const skipped = [];

  for (const file of unique) {
    if (ALWAYS_RUNS.some(p => file === p || file.startsWith(p))) {
      forcing.push({ file, why: 'the suite itself' });
      continue;
    }
    const safe = CANNOT_REACH_THE_RENDERER.find(rule =>
      rule.prefix ? file.startsWith(rule.prefix) : rule.match.test(file));
    if (safe) skipped.push({ file, why: safe.why });
    else forcing.push({ file, why: 'can reach the renderer, or is unclassified' });
  }

  return {
    runE2E: forcing.length > 0,
    reason: forcing.length > 0
      ? `${forcing.length} changed file(s) can reach a rendered surface`
      : `all ${skipped.length} changed file(s) are outside the running app`,
    forcing,
    skipped,
  };
}

/** Everything this branch changed, committed or not. */
async function changedFiles(base) {
  const out = [];
  const git = async (args) => {
    try {
      const { stdout } = await run('git', args, { cwd: process.cwd() });
      return stdout;
    } catch {
      return '';
    }
  };

  // Committed on this branch, against the trunk it will merge into.
  const merged = await git(['diff', '--name-only', `${base}...HEAD`]);
  out.push(...merged.split('\n'));
  // Plus anything still in the working tree, staged or not.
  const dirty = await git(['status', '--porcelain']);
  for (const line of dirty.split('\n')) {
    if (!line.trim()) continue;
    // "XY path" and "XY old -> new": take what the file is now.
    const pathPart = line.slice(3);
    out.push(pathPart.includes(' -> ') ? pathPart.split(' -> ')[1] : pathPart);
  }
  return out.map(f => f.trim()).filter(Boolean);
}

async function main() {
  const base = process.env.SCOPE_BASE || 'main';
  const files = await changedFiles(base);
  const decision = decide(files);

  console.log(`[scope] ${files.length} changed file(s) against ${base}`);

  if (!decision.runE2E) {
    // Said out loud, at length, and naming every file. A run that quietly
    // skipped its slowest check reads afterwards as a run that passed it.
    console.log('[scope] SKIPPING the end to end suite.');
    console.log(`[scope] Why: ${decision.reason}.`);
    for (const { file, why } of decision.skipped) {
      console.log(`[scope]   ${file}: ${why}`);
    }
    console.log('[scope] No rendered surface was checked. Run `npm run e2e` to check them anyway.');
    return 0;
  }

  console.log(`[scope] Running the end to end suite: ${decision.reason}.`);
  for (const { file, why } of decision.forcing.slice(0, 12)) {
    console.log(`[scope]   ${file}: ${why}`);
  }
  if (decision.forcing.length > 12) {
    console.log(`[scope]   and ${decision.forcing.length - 12} more`);
  }

  const child = execFile('npx', ['playwright', 'test'], { cwd: process.cwd() });
  child.stdout?.pipe(process.stdout);
  child.stderr?.pipe(process.stderr);
  return new Promise(resolve => child.on('close', code => resolve(code ?? 1)));
}

// Only when run as a command, so the decision above can be imported and tested.
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().then(code => process.exit(code)).catch(err => {
    console.error('[scope] could not decide, running everything:', err);
    process.exit(1);
  });
}
