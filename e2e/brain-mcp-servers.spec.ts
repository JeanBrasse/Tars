import { test, expect, _electron as electron, type ElectronApplication, type Page } from '@playwright/test';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { LATEST_RELEASE, WHATS_NEW_STORAGE_KEY } from '@/data/changelog';
import { launchSandboxed, listenForErrors, markWhatsNewSeen, recordValues, seedSandbox, stepShot } from './fixture.mjs';
import { DEV_URL, apiPort } from './ports.mjs';

/**
 * The Brain page's graph shows the MCP servers of ~/.claude/mcp.json, a
 * defect QA found on main (01/10): the graph read `.output` from
 * fs:read-text-file, which answers `{ content }`, so no server of that file
 * ever reached it. In the real app, in a sandbox: a server written to the
 * sandbox's ~/.claude/mcp.json is a node of the graph, on Brain > Agents.
 */

let app: ElectronApplication;
let page: Page;
let home: string;
const errors: string[] = [];
const SERVER = 'graph-probe-server';

test.beforeAll(async () => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'dorothy-e2e-brain-mcp-'));
  seedSandbox(home);
  fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
  fs.writeFileSync(path.join(home, '.claude', 'mcp.json'), JSON.stringify({ mcpServers: { [SERVER]: { command: 'node', args: ['probe.js'] } } }, null, 2));
  app = await launchSandboxed(electron, home, {
    env: { NODE_ENV: 'development', DOROTHY_DEV_URL: DEV_URL, DOROTHY_API_PORT: apiPort(31480), DOROTHY_E2E: '1' },
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

test("brain: the graph shows the servers of ~/.claude/mcp.json", async () => {
  test.setTimeout(180_000);
  await page.goto(`${DEV_URL}/memory`, { waitUntil: 'domcontentloaded' });
  const agentsTab = page.getByRole('radio', { name: 'Agents' });
  await agentsTab.click();
  await expect(agentsTab).toHaveAttribute('aria-checked', 'true');
  await expect(page.getByText(SERVER, { exact: true })).toBeVisible({ timeout: 60_000 });
  // The graph is rebuilt behind a short overlay (300 ms) when the agents
  // change: the node counts once nothing covers it.
  await expect(page.getByText('Switching agent', { exact: true })).toHaveCount(0, { timeout: 10_000 });
  await expect(page.getByText(SERVER, { exact: true })).toBeVisible();
  await stepShot(page, '01-graph-with-the-mcp-server');
  expect(errors, errors.join('\n')).toEqual([]);
  recordValues({ server: SERVER, pageErrors: errors });
});
