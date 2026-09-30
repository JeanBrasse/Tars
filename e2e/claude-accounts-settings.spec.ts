import { test, expect, _electron as electron, type Page } from '@playwright/test';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { launchSandboxed, listenForErrors, recordValues, stepShot } from './fixture.mjs';
import { DEV_URL, apiPort } from './ports.mjs';

/**
 * Settings > Claude accounts, and the account an agent runs on, driven through
 * the page in the real app on #263's channels. Frames: `Settings · Claude
 * accounts`, its states sheet and `Agent · Claude account`.
 *
 * The claude binary is a stand-in (Settings > CLI paths), as in
 * claude-accounts.spec.ts: `auth status` answers from a marker in the folder
 * CLAUDE_CONFIG_DIR names (~/.claude without it), `auth login` writes it after
 * printing a line. No real account, no keychain, no network.
 *
 * What the run proves, in order, each step a picture:
 * - the section sits under AI & Providers, off, and says how accounts sign in
 *   and that each must be your own, its limits Anthropic's;
 * - turned on, it lists account 1 as Claude Code reports it;
 * - add an account names it, and its terminal shows Claude Code's own sign-in
 *   and says signed in once Claude Code does;
 * - a rename, a move and a threshold reach the registry main keeps, and a
 *   threshold main would refuse never does;
 * - remove asks first, and Cancel removes nothing;
 * - the agent's card names its account, and its menu pins the agent, which
 *   the card hears from main's push (claude-accounts:agent-changed);
 * - a registry main cannot read is said in the section, in main's words.
 * Removing for real is left to #263's unit tests: shell.trashItem goes to the
 * real user's Trash.
 */

const AGENT = { id: 'w1', name: 'Worker One' };

function writeFakeClaude(home: string): string {
  const bin = path.join(home, 'fake-claude.cjs');
  fs.writeFileSync(bin, [
    `#!${process.execPath}`,
    "const fs = require('fs'); const path = require('path');",
    "const [cmd, sub] = process.argv.slice(2);",
    "const d = process.env.CLAUDE_CONFIG_DIR || path.join(process.env.HOME, '.claude');",
    "const marker = path.join(d, '.fake-signed-in');",
    "if (cmd === 'auth' && sub === 'status') {",
    "  if (fs.existsSync(marker)) { console.log(JSON.stringify({ loggedIn: true, authMethod: 'claude.ai', email: fs.readFileSync(marker, 'utf8'), subscriptionType: 'max', configDirectory: d })); process.exit(0); }",
    "  console.log(JSON.stringify({ loggedIn: false, authMethod: 'none', configDirectory: d })); process.exit(1);",
    "} else if (cmd === 'auth' && sub === 'logout') {",
    "  fs.rmSync(marker, { force: true }); process.exit(0);",
    "} else if (cmd === 'auth' && sub === 'login') {",
    "  process.stdout.write('Opening browser to sign in' + String.fromCharCode(13, 10));",
    "  setTimeout(() => { fs.mkdirSync(d, { recursive: true }); fs.writeFileSync(marker, path.basename(d) + '@example.com'); process.stdout.write('Login successful.'); process.exit(0); }, 600);",
    "} else { process.exit(2); }",
    '',
  ].join('\n'), { mode: 0o755 });
  return bin;
}

/** Main's registry of accounts, kept where no agent is handed it (#263, after the design gate). */
const registry = (home: string) => JSON.parse(fs.readFileSync(path.join(home, '.tars-private', 'claude-accounts.json'), 'utf8'));
const row = (page: Page, id: string) => page.locator(`[data-account-row="${id}"]`);
/** Main's sentence for a registry that does not parse (#263, registryProblem). */
const UNREADABLE = '~/.tars-private/claude-accounts.json does not read as a list of accounts. Nothing is changed until it is fixed or removed.';

test('claude accounts: the section, the sign-in terminal, and an agent pinned from its card', async () => {
  test.setTimeout(180_000);
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dorothy-e2e-accounts-ui-'));
  const dataDir = path.join(home, '.dorothy');
  const project = path.join(home, 'projects', 'demo');
  fs.mkdirSync(project, { recursive: true });
  fs.mkdirSync(dataDir, { recursive: true });
  // Account 1 is signed in already, as on a Mac that has Claude Code.
  fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
  fs.writeFileSync(path.join(home, '.claude', '.fake-signed-in'), 'one@example.com');
  const cli = writeFakeClaude(home);
  fs.writeFileSync(path.join(dataDir, 'agents.json'), JSON.stringify([{
    id: AGENT.id, name: AGENT.name, character: 'robot', provider: 'claude', status: 'idle', role: 'worker',
    projectPath: project, skills: [], createdAt: '2026-09-28T08:00:00.000Z', lastActivity: '2026-09-28T08:00:00.000Z',
  }], null, 2));
  fs.writeFileSync(path.join(dataDir, 'projects.json'), JSON.stringify([project]));
  fs.writeFileSync(path.join(dataDir, 'hermes-connection.json'), JSON.stringify({ mode: 'local', localPort: 9, authMode: 'token' }));
  fs.writeFileSync(path.join(dataDir, 'app-settings.json'), JSON.stringify({
    autoStartAgentsOnLaunch: false, ollamaBaseUrl: 'http://127.0.0.1:9', cliPaths: { claude: cli },
  }));

  const app = await launchSandboxed(electron, home, {
    env: { NODE_ENV: 'development', DOROTHY_DEV_URL: `${DEV_URL}/settings`, DOROTHY_API_PORT: apiPort(31486), DOROTHY_E2E: '1' },
  });
  const errors: string[] = [];
  try {
    const page = await app.firstWindow();
    listenForErrors(page, errors);
    await page.goto(`${DEV_URL}/settings`, { waitUntil: 'domcontentloaded' });

    // Under AI & Providers, after Providers; off, with its three lines.
    await page.getByText('AI & Providers', { exact: true }).click();
    await page.getByText('Claude accounts', { exact: true }).click();
    const toggle = page.getByRole('switch', { name: 'Use several Claude subscriptions' });
    await expect(toggle).toHaveAttribute('aria-checked', 'false');
    await expect(page.getByText('Each account signs in through Claude Code itself, in a terminal Tars opens. Tars never sees the sign-in.')).toBeVisible();
    await expect(page.getByText("Each account must be your own, and its limits are Anthropic's.")).toBeVisible();
    await expect(page.locator('[data-account-row]')).toHaveCount(0);
    await stepShot(page, '01-off');

    // On: account 1, as Claude Code reports it.
    await toggle.click();
    await expect(toggle).toHaveAttribute('aria-checked', 'true');
    await expect(row(page, 'default')).toContainText('Account 1');
    await expect(row(page, 'default')).toContainText('signed in', { timeout: 20_000 });
    await expect(row(page, 'default')).toContainText('one@example.com · max · 0 agents');
    await expect(row(page, 'default')).toContainText('~/.claude');
    await expect(row(page, 'default').getByRole('button', { name: 'remove' })).toHaveCount(0);
    await expect(page.getByText('Agents go where the most room is left, and this order breaks ties. 1 of 5.')).toBeVisible();
    await stepShot(page, '02-on-one-account');

    // Add an account: named, then Claude Code's own sign-in in its terminal.
    await page.getByRole('button', { name: 'add an account' }).click();
    const dialog = page.getByRole('dialog');
    await expect(dialog.getByRole('heading', { name: 'Add a Claude account' })).toBeVisible();
    await expect(dialog.getByLabel('Name')).toHaveValue('Account 2');
    await dialog.getByLabel('Name').fill('Max two');
    await dialog.getByRole('button', { name: 'Add and sign in' }).click();
    await expect(dialog.locator('.xterm-rows')).toContainText('Opening browser to sign in', { timeout: 20_000 });
    await stepShot(page, '03-signing-in');
    const two = (registry(home).accounts as Array<{ id: string; label: string }>).find(a => a.label === 'Max two')!;
    expect(two.id).toMatch(/^acct-[0-9a-f]{6}$/);
    await expect(dialog.getByText(`Signed in as ${two.id}@example.com.`)).toBeVisible({ timeout: 20_000 });
    await stepShot(page, '04-signed-in');
    await dialog.getByRole('button', { name: 'Done' }).click();
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await expect(row(page, two.id)).toContainText('signed in');
    await expect(row(page, two.id)).toContainText(`~/.claude-accounts/${two.id}`);
    await expect(row(page, two.id)).toContainText('No use seen yet: the first agent that runs on it measures it.');

    // A rename, a move and a threshold reach main's registry.
    await row(page, two.id).getByRole('button', { name: 'Rename Max two' }).click();
    await row(page, two.id).getByLabel('Name of Max two').fill('Work');
    await row(page, two.id).getByLabel('Name of Max two').press('Enter');
    await expect.poll(() => registry(home).accounts.find((a: { id: string }) => a.id === two.id)?.label).toBe('Work');
    await row(page, two.id).getByRole('button', { name: 'Move Work up' }).click();
    await expect.poll(() => registry(home).accounts.map((a: { id: string }) => a.id)).toEqual([two.id, 'default']);
    const five = page.getByLabel('5 h threshold');
    await five.fill('85');
    await five.press('Tab');
    await expect.poll(() => registry(home).fiveHourThreshold).toBe(85);
    await five.fill('120');
    await five.press('Tab');
    await expect(page.getByText('A threshold is a whole percentage from 50 to 100.')).toBeVisible();
    await expect(five).toHaveValue('85');
    expect(registry(home).fiveHourThreshold).toBe(85);
    await stepShot(page, '05-renamed-moved-threshold-refused');

    // Remove asks first; Cancel removes nothing.
    await row(page, two.id).getByRole('button', { name: 'remove' }).click();
    await expect(page.getByRole('dialog').getByRole('heading', { name: 'Remove Work?' })).toBeVisible();
    await stepShot(page, '06-remove-asks');
    await page.getByRole('dialog').getByRole('button', { name: 'Cancel' }).click();
    await expect(page.getByRole('dialog')).toHaveCount(0);
    expect(registry(home).accounts).toHaveLength(2);

    // The agent's card names its account, and its menu pins the agent.
    await page.goto(`${DEV_URL}/agents`, { waitUntil: 'domcontentloaded' });
    const control = page.getByRole('button', { name: `Claude account of ${AGENT.name}` });
    await expect(control).toHaveText('Account 1', { timeout: 20_000 });
    await expect(control).toHaveAttribute('title', 'Runs on Account 1, chosen by Tars.');
    await control.click();
    await expect(page.getByText('Run this agent on', { exact: true })).toBeVisible();
    await stepShot(page, '07-agent-menu');
    await page.locator(`[role="option"][data-value="${two.id}"]`).click();
    await expect.poll(() => {
      const raw = JSON.parse(fs.readFileSync(path.join(dataDir, 'agents.json'), 'utf8'));
      const agents = (Array.isArray(raw) ? raw : raw.agents) as Array<{ id: string; claudeAccountPin?: string }>;
      return agents.find(a => a.id === AGENT.id)?.claudeAccountPin;
    }, { timeout: 10_000 }).toBe(two.id);
    await expect(control).toHaveText('Work · pinned', { timeout: 10_000 });
    await stepShot(page, '08-agent-pinned');

    // A registry main cannot read: the section says so, in main's words, and
    // every change waits for it to be fixed or removed.
    fs.writeFileSync(path.join(home, '.tars-private', 'claude-accounts.json'), '{ not a list');
    await page.goto(`${DEV_URL}/settings`, { waitUntil: 'domcontentloaded' });
    await page.getByText('AI & Providers', { exact: true }).click();
    await page.getByText('Claude accounts', { exact: true }).click();
    await expect(page.getByText(UNREADABLE)).toBeVisible({ timeout: 20_000 });
    await expect(page.getByText(UNREADABLE)).toHaveCount(1);
    await stepShot(page, '09-registry-unreadable');

    expect(errors, errors.join('\n')).toEqual([]);
    recordValues({
      registry: registry(home),
      pin: two.id,
      unreadableSaid: UNREADABLE,
      pageErrors: errors,
    });
  } finally {
    await app.close();
    fs.rmSync(home, { recursive: true, force: true });
  }
});
