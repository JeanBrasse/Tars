import { test, expect, _electron as electron } from '@playwright/test';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execFileSync, spawn } from 'child_process';
import { launchSandboxed, recordValues, stepShot } from './fixture.mjs';
import { DEV_URL, apiPort } from './ports.mjs';

/**
 * The folders no agent owns, in Settings, System, as a person meets them
 * (#334's contract, the frames of #315: `Settings · System · folders no agent
 * owns` and its states).
 *
 * The real app, a sandbox HOME whose project holds a worktree git knows, an
 * agent's worktree, a worktree git forgot, a folder with no .git, and one a
 * real process works in. The person reads the list (the three, each with why,
 * its size and when it last changed) and the disk above it; remove asks first
 * and removes nothing; cancel takes the question away; remove again, then
 * remove in the question, and the end says two were removed and one kept,
 * which stays listed as in use, with remove 1 folder. The two idle folders are
 * gone from the disk, the busy one, the live worktree and the agent's are not.
 *
 * The artefact: a screenshot per state and values.json with what each one read.
 */

const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

test('the folders no agent owns are listed, asked about first, kept on cancel, and removed but the one in use, which the list keeps', async () => {
  test.setTimeout(300_000);
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dorothy-e2e-orphans-ui-'));
  const project = path.join(fs.realpathSync(home), 'projects', 'tars-hermes');
  const dir = path.join(home, '.dorothy');
  fs.mkdirSync(project, { recursive: true });
  fs.mkdirSync(dir, { recursive: true });
  git(project, 'init', '-q', '-b', 'main');
  git(project, 'config', 'user.email', 't@t.example');
  git(project, 'config', 'user.name', 'T');
  fs.writeFileSync(path.join(project, 'a.txt'), 'a\n');
  git(project, 'add', '-A');
  git(project, 'commit', '-qm', 'init');
  const wt = (...p: string[]) => path.join(project, '.worktrees', ...p);
  git(project, 'worktree', 'add', '-q', wt('feat', 'live'), '-b', 'feat/live');
  git(project, 'worktree', 'add', '-q', wt('agent-wt'), '-b', 'agent-wt');
  // Git forgot it: its .git names a gitdir that is gone.
  fs.mkdirSync(wt('feat-relay-retry', 'node_modules', 'x'), { recursive: true });
  fs.writeFileSync(wt('feat-relay-retry', '.git'), `gitdir: ${path.join(project, '.git', 'worktrees', 'feat-relay-retry')}\n`);
  fs.writeFileSync(wt('feat-relay-retry', 'node_modules', 'x', 'index.js'), Buffer.alloc(200_000, 120));
  // No .git at all.
  fs.mkdirSync(wt('agent-7f3c1a'), { recursive: true });
  fs.writeFileSync(wt('agent-7f3c1a', 'notes.md'), Buffer.alloc(50_000, 120));
  // A process works in this one.
  fs.mkdirSync(wt('busy'), { recursive: true });
  fs.writeFileSync(wt('busy', 'x.txt'), 'x');
  fs.writeFileSync(path.join(dir, 'agents.json'), JSON.stringify([{
    id: 'a1', name: 'Agent', character: 'robot', provider: 'claude', status: 'idle', role: 'worker',
    projectPath: project, worktreePath: wt('agent-wt'), branchName: 'agent-wt', skills: [],
    createdAt: '2026-10-06T08:00:00.000Z', lastActivity: '2026-10-06T08:00:00.000Z',
  }]));
  fs.writeFileSync(path.join(dir, 'projects.json'), JSON.stringify([project]));
  fs.writeFileSync(path.join(dir, 'hermes-connection.json'), JSON.stringify({ mode: 'local', localPort: 9, authMode: 'token' }));
  fs.writeFileSync(path.join(dir, 'app-settings.json'), JSON.stringify({ autoStartAgentsOnLaunch: false, ollamaBaseUrl: 'http://127.0.0.1:9' }));
  const busy = spawn('sleep', ['300'], { cwd: wt('busy'), stdio: 'ignore' });
  const onDisk = () => ({ relay: fs.existsSync(wt('feat-relay-retry')), noGit: fs.existsSync(wt('agent-7f3c1a')), busy: fs.existsSync(wt('busy')) });

  const app = await launchSandboxed(electron, home, {
    env: { NODE_ENV: 'development', DOROTHY_DEV_URL: DEV_URL, DOROTHY_API_PORT: apiPort(31460), DOROTHY_E2E: '1' },
  });
  const pageErrors: string[] = [];
  const seen: Record<string, unknown> = {};
  try {
    const page = await app.firstWindow();
    page.on('pageerror', e => pageErrors.push(String(e)));
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(`${DEV_URL}/settings?section=system`, { waitUntil: 'domcontentloaded' });

    // The list, and the disk above it.
    const block = page.locator('[data-orphan-folders]');
    await expect(block).toContainText('Folders no agent owns', { timeout: 90_000 });
    await expect(block).toContainText('3 folders,', { timeout: 60_000 });
    const rows = block.locator('[data-orphan-row]');
    await expect(rows).toHaveCount(3);
    seen.list = (await rows.allInnerTexts()).map(t => t.replace(/\s+/g, ' '));
    const byName = (name: string) => rows.filter({ hasText: `tars-hermes/.worktrees/${name}` });
    await expect(byName('feat-relay-retry')).toContainText('git forgot it');
    await expect(byName('feat-relay-retry')).toContainText('195 KB');
    await expect(byName('agent-7f3c1a')).toContainText('no .git');
    await expect(byName('busy')).toContainText('no .git');
    await expect(block).not.toContainText(project);
    const disk = page.locator('[data-settings-row]', { hasText: 'Disk' });
    await expect(disk).toContainText(/\d+ GB free of \d+ GB on the startup disk\. Tars warns below 30 GB\./);
    seen.disk = (await disk.innerText()).replace(/\s+/g, ' ');
    seen.listHint = (await block.locator('[data-settings-hint]').first().innerText()).replace(/\s+/g, ' ');
    await stepShot(page, '01-list');

    // Remove asks first, and removes nothing yet.
    await block.getByRole('button', { name: 'remove 3 folders', exact: true }).click();
    const confirm = block.locator('[data-orphan-confirm]');
    await expect(confirm).toContainText('Remove these 3 folders,');
    await expect(confirm).toContainText('for good?');
    seen.asks = (await confirm.innerText()).replace(/\s+/g, ' ');
    expect(onDisk(), 'asking removes nothing').toEqual({ relay: true, noGit: true, busy: true });
    await stepShot(page, '02-asks-first');

    // Cancel takes the question away.
    await confirm.getByRole('button', { name: 'cancel', exact: true }).click();
    await expect(confirm).toHaveCount(0);
    expect(onDisk(), 'cancel removes nothing').toEqual({ relay: true, noGit: true, busy: true });
    await expect(rows).toHaveCount(3);

    // Remove, then remove in the question.
    await block.getByRole('button', { name: 'remove 3 folders', exact: true }).click();
    await confirm.getByRole('button', { name: 'remove 3 folders', exact: true }).click();
    await expect(block).toContainText('Removed 2 folders:', { timeout: 60_000 });
    await expect(block).toContainText('One was kept: a process works in it.');
    await expect(rows).toHaveCount(1);
    await expect(rows.first()).toContainText('tars-hermes/.worktrees/busy');
    await expect(rows.first()).toContainText('in use');
    await expect(block.getByRole('button', { name: 'remove 1 folder', exact: true })).toBeEnabled();
    seen.done = (await block.locator('[data-settings-hint]').first().innerText()).replace(/\s+/g, ' ');
    seen.kept = (await rows.allInnerTexts()).map(t => t.replace(/\s+/g, ' '));
    await stepShot(page, '03-done-one-kept');

    const after = { ...onDisk(), live: git(wt('feat', 'live'), 'rev-parse', '--abbrev-ref', 'HEAD'), agent: fs.existsSync(wt('agent-wt', 'a.txt')) };
    recordValues({ ...seen, after, pageErrors });
    expect(after).toEqual({ relay: false, noGit: false, busy: true, live: 'feat/live', agent: true });
    expect(pageErrors).toEqual([]);
  } finally {
    if (busy.pid) { try { process.kill(busy.pid, 'SIGKILL'); } catch { /* gone */ } }
    await app.close().catch(() => { /* gone */ });
    fs.rmSync(home, { recursive: true, force: true });
  }
});
