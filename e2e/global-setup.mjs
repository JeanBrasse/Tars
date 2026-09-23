import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';

/**
 * Makes the directory this run's surfaces write their tolerated page errors
 * into. See recordPageErrors in surfaces.mjs and e2e/known-errors.spec.ts.
 *
 * Fresh for every run, so nothing an earlier run saw can pass for something this
 * one saw. Not under test-results: Playwright keeps that folder between runs
 * when its UI or an editor drives it. The workers find it through the
 * environment, which they inherit because Playwright starts them after this.
 */
export default function globalSetup(config) {
  // The command that reproduces this run, beside its artefacts: the same
  // arguments, the variables that shape a run, and the commit it ran on.
  const runDir = config.projects[0]?.outputDir ?? process.env.E2E_RUN_DIR;
  if (runDir) {
    fs.mkdirSync(runDir, { recursive: true });
    const shaping = ['E2E_PORT_OFFSET', 'E2E_TRACE', 'E2E_LIVE', 'DOROTHY_DEV_URL'].filter(name => process.env[name]).map(name => `${name}=${process.env[name]}`);
    let commit = 'unknown';
    try { commit = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(); } catch { /* not a checkout */ }
    fs.writeFileSync(path.join(runDir, 'command.txt'), [
      `# commit ${commit}, ${new Date().toISOString()}`,
      'npx tsc -p electron/tsconfig.json',
      [...shaping, 'npx playwright', ...process.argv.slice(2)].join(' '),
      '',
    ].join('\n'));
    console.log(`[e2e] run directory: ${runDir}`);
  }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tars-e2e-page-errors-'));
  process.env.E2E_PAGE_ERRORS_DIR = dir;
  return () => fs.rmSync(dir, { recursive: true, force: true });
}
