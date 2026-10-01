import { test, expect, _electron as electron, type ElectronApplication, type Page } from '@playwright/test';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execFileSync } from 'child_process';
import { LATEST_RELEASE, WHATS_NEW_STORAGE_KEY } from '@/data/changelog';
import { launchSandboxed, listenForErrors, markWhatsNewSeen, recordValues, seedSandbox, stepShot } from './fixture.mjs';
import { DEV_URL, apiPort } from './ports.mjs';

/**
 * The Review page's own side of Noah's "the Review page only half works"
 * (01/10), from the Audit's DIAG-REVIEW.md, in the real app on throwaway git
 * repositories in the sandbox. Frames: Review · dark, Review · light and
 * Review · states. In order:
 * - a project added in Tars that no agent works in is listed under its name,
 *   saying no agent, and its changes can be read;
 * - with no file picked, a patch past 4000 lines says where it stops and how
 *   to read one file whole; a file's own patch shows when picked;
 * - Refresh reads the list again: a project added since shows;
 * - a file whose patch main can no longer read says why, where the page said
 *   there was no textual change.
 * A late answer for a tree or a file no longer picked is the page test's
 * (__tests__/components/review-page.test.tsx): its timing is not reproducible
 * here.
 */

let app: ElectronApplication;
let page: Page;
let home: string;
const errors: string[] = [];

/** A git repository with one commit of `files`, then `changes` written over it, uncommitted. */
function repo(dir: string, files: Record<string, string>, changes: Record<string, string>): void {
  fs.mkdirSync(dir, { recursive: true });
  const git = (...args: string[]) => execFileSync('git', ['-c', 'user.email=e2e@example.com', '-c', 'user.name=e2e', ...args], { cwd: dir, stdio: 'pipe' });
  git('init', '-q', '-b', 'main');
  for (const [file, text] of Object.entries(files)) fs.writeFileSync(path.join(dir, file), text);
  git('add', '-A');
  git('commit', '-q', '-m', 'first');
  for (const [file, text] of Object.entries(changes)) fs.writeFileSync(path.join(dir, file), text);
}

/** Adds a project as Settings or the Projects page would: a path in projects.json. */
function addProject(dir: string): void {
  const file = path.join(home, '.dorothy', 'projects.json');
  const list = JSON.parse(fs.readFileSync(file, 'utf8')) as string[];
  fs.writeFileSync(file, JSON.stringify([...list, dir], null, 2));
}

const lines = (n: number, word: string) => Array.from({ length: n }, (_, i) => `${word} ${i}`).join('\n') + '\n';

test.beforeAll(async () => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'dorothy-e2e-review-'));
  seedSandbox(home);
  const docs = path.join(home, 'projects', 'docs');
  repo(docs, { 'big.txt': lines(5000, 'old'), 'notes.md': 'notes\n' }, { 'big.txt': lines(5000, 'new'), 'notes.md': 'notes\na new line\n' });
  addProject(docs);
  app = await launchSandboxed(electron, home, {
    env: { NODE_ENV: 'development', DOROTHY_DEV_URL: DEV_URL, DOROTHY_API_PORT: apiPort(31482), DOROTHY_E2E: '1' },
  });
  page = await app.firstWindow();
  listenForErrors(page, errors);
  await markWhatsNewSeen(page, WHATS_NEW_STORAGE_KEY, String(LATEST_RELEASE.id));
  await page.setViewportSize({ width: 1440, height: 900 });
});

test.afterAll(async () => {
  await app?.close();
  fs.rmSync(home, { recursive: true, force: true });
});

test('review: a project with no agent, a patch cut short, refresh, and a patch that cannot be read', async () => {
  test.setTimeout(180_000);
  await page.goto(`${DEV_URL}/review`, { waitUntil: 'domcontentloaded' });

  // The project no agent works in, under its name.
  await expect(page.getByText('DOCS', { exact: true })).toBeVisible({ timeout: 60_000 });
  const docsRow = page.getByRole('button').filter({ hasText: 'no agent' }).filter({ hasText: 'docs' });
  await expect(docsRow).toHaveCount(1);
  await docsRow.click();
  await expect(page.getByRole('button').filter({ hasText: 'big.txt' })).toBeVisible({ timeout: 30_000 });
  await expect(page.getByRole('button').filter({ hasText: 'notes.md' })).toBeVisible();

  // The whole patch, past 4000 lines, says where it stops.
  const wholeCut = page.getByText(/^4000 of \d+ lines shown\. Pick a file to read its own patch\.$/);
  await expect(wholeCut).toBeVisible();
  const wholeNote = await wholeCut.textContent();
  await stepShot(page, '01-no-agent-project-patch-cut');

  // A file's own patch, short: no note.
  await page.getByRole('button').filter({ hasText: 'notes.md' }).click();
  await expect(page.getByText('+a new line', { exact: true })).toBeVisible({ timeout: 30_000 });
  await expect(page.getByText(/lines shown\./)).toHaveCount(0);
  await stepShot(page, '02-a-file-patch');

  // Refresh reads the list again: a project added since shows.
  const more = path.join(home, 'projects', 'more');
  repo(more, { 'a.txt': 'a\n' }, { 'a.txt': 'a\nb\n' });
  addProject(more);
  await expect(page.getByText('MORE', { exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: 'Refresh', exact: true }).click();
  await expect(page.getByText('MORE', { exact: true })).toBeVisible({ timeout: 30_000 });
  await stepShot(page, '03-refresh-reads-the-list');

  // A file whose patch main can no longer read says why.
  fs.renameSync(path.join(home, 'projects', 'docs', '.git'), path.join(home, 'projects', 'docs', '.git-gone'));
  await page.getByRole('button').filter({ hasText: 'big.txt' }).click();
  const failed = page.getByText(/^Could not read this file's patch: /);
  await expect(failed).toBeVisible({ timeout: 30_000 });
  await expect(page.getByText('No textual change to show for this file.')).toHaveCount(0);
  const failedText = await failed.textContent();
  await stepShot(page, '04-a-patch-that-cannot-be-read');

  expect(errors, errors.join('\n')).toEqual([]);
  recordValues({ wholeNote, failedText, pageErrors: errors });
});
