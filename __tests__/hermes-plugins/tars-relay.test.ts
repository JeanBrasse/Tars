import { describe, it, expect } from 'vitest';
import { spawnSync } from 'child_process';
import * as path from 'path';

/**
 * The tars-relay Hermes plugin's own tests, in the regression net.
 *
 * The plugin is Python and runs inside Noah's Hermes, never in Tars. Its rules are tested by
 * hermes-plugins/tars-relay/tests (unittest, standard library only), and CI runs nothing but npm test, so this runs
 * them there.
 *
 * How this can fail, written before the code:
 * 1. there is no python3 and the plugin's tests are skipped without a word;
 * 2. the tests do not run at all, and zero tests reads as a success;
 * 3. some of them stop being found, and fewer tests pass than were written;
 * 4. one of them fails.
 */
const PLUGIN = path.resolve(__dirname, '../../hermes-plugins/tars-relay');
const WRITTEN = 21;

describe('the tars-relay Hermes plugin', () => {
  it('passes its own tests, every one of them run', () => {
    const run = spawnSync('python3', ['-m', 'unittest', 'discover', '-s', 'tests', '-v'], {
      cwd: PLUGIN,
      encoding: 'utf-8',
      env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' },
      timeout: 60_000,
    });

    expect(run.error, 'python3 must be on PATH: the plugin\'s tests cannot be skipped').toBeUndefined();
    const ran = /^Ran (\d+) tests? in /m.exec(run.stderr);
    expect(ran, run.stderr.slice(-3000)).not.toBeNull();
    expect(Number(ran![1]), run.stderr.slice(-3000)).toBeGreaterThanOrEqual(WRITTEN);
    expect(run.status, run.stderr.slice(-3000)).toBe(0);
  }, 90_000);
});
