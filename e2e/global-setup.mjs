import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

/**
 * Makes the directory this run's surfaces write their tolerated page errors
 * into. See recordPageErrors in surfaces.mjs and e2e/known-errors.spec.ts.
 *
 * Fresh for every run, so nothing an earlier run saw can pass for something this
 * one saw. Not under test-results: Playwright keeps that folder between runs
 * when its UI or an editor drives it. The workers find it through the
 * environment, which they inherit because Playwright starts them after this.
 */
export default function globalSetup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tars-e2e-page-errors-'));
  process.env.E2E_PAGE_ERRORS_DIR = dir;
  return () => fs.rmSync(dir, { recursive: true, force: true });
}
