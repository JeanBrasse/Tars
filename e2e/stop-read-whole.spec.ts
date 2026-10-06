import { test, expect, _electron as electron, type ElectronApplication, type Locator, type Page } from '@playwright/test';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { LATEST_RELEASE, WHATS_NEW_STORAGE_KEY } from '@/data/changelog';
import { launchSandboxed, listenForErrors, markWhatsNewSeen, recordValues, stepShot } from './fixture.mjs';
import { DEV_URL, apiPort } from './ports.mjs';

/**
 * A stop, read whole (useElectronAgents). A stopped agent says who stopped it,
 * when and why, which only its full record carries: the status event names the
 * status alone, and the window read the record again only on the
 * agent:complete that comes when a stopped agent's terminal ends. An agent
 * stopped with no terminal sends none, and read "Stopped", by nobody, for no
 * reason, until the page was reloaded.
 *
 * In the real app, in a sandbox: Writer has no terminal, and Project Lead, the
 * orchestrator, stops it through the API with its own token and a reason, as
 * stop_agent does, while the Agents page is open. Its card says who stopped it,
 * when and why, with no reload.
 *
 * The artefact: a screenshot of the card and values.json with the line read.
 */

type Agent = { id: string; status: string; stoppedAt?: string };
type Api = { electronAPI: { agent: { list(): Promise<Agent[]> } } };

const REASON = 'frozen on a file read for 40 minutes';
const pad = (n: number) => String(n).padStart(2, '0');
/** The time as the window prints it: the clock of this machine, which is the app's. */
const clock = (iso: string) => { const d = new Date(iso); return `${pad(d.getHours())}:${pad(d.getMinutes())}`; };

let app: ElectronApplication;
let page: Page;
let home: string;
const errors: string[] = [];

function sandbox() {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'dorothy-e2e-stop-read-whole-'));
  const project = path.join(home, 'projects', 'demo');
  const dir = path.join(home, '.dorothy');
  fs.mkdirSync(project, { recursive: true });
  fs.mkdirSync(dir, { recursive: true });
  const agent = (id: string, name: string, role: string) => ({
    id, name, character: 'robot', provider: 'claude', model: 'opus-5', status: 'idle', role,
    projectPath: project, skills: [],
    createdAt: '2026-10-05T08:00:00.000Z', lastActivity: '2026-10-05T08:00:00.000Z',
  });
  fs.writeFileSync(path.join(dir, 'agents.json'), JSON.stringify([
    agent('o1', 'Project Lead', 'orchestrator'),
    agent('y1', 'Writer', 'worker'),
  ], null, 2));
  fs.writeFileSync(path.join(dir, 'projects.json'), JSON.stringify([project]));
  fs.writeFileSync(path.join(dir, 'hermes-connection.json'), JSON.stringify({ mode: 'local', localPort: 9, authMode: 'token' }));
  fs.writeFileSync(path.join(dir, 'app-settings.json'), JSON.stringify({ autoStartAgentsOnLaunch: false, ollamaBaseUrl: 'http://127.0.0.1:9' }));
}

test.beforeAll(async () => {
  sandbox();
  app = await launchSandboxed(electron, home, {
    env: { NODE_ENV: 'development', DOROTHY_DEV_URL: DEV_URL, DOROTHY_API_PORT: apiPort(31464), DOROTHY_E2E: '1' },
  });
  page = await app.firstWindow();
  listenForErrors(page, errors);
  await markWhatsNewSeen(page, WHATS_NEW_STORAGE_KEY, String(LATEST_RELEASE.id));
  await page.setViewportSize({ width: 1440, height: 900 });
});

test.afterAll(async ({}, testInfo) => {
  // Under next dev the app's process can linger a minute after it quits.
  testInfo.setTimeout(180_000);
  await app?.close().catch(() => { /* gone */ });
  if (home) fs.rmSync(home, { recursive: true, force: true });
});

/** An Agents card: the smallest block holding the name and its row of actions. */
function card(name: string): Locator {
  return page.locator('div')
    .filter({ has: page.getByText(name, { exact: true }) })
    .filter({ has: page.getByRole('button', { name: 'edit', exact: true }) })
    .last();
}

test('an agent stopped with no terminal says who stopped it, when and why, with no reload', async () => {
  test.setTimeout(240_000);
  await page.goto(`${DEV_URL}/agents`, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => !!(window as unknown as Partial<Api>).electronAPI);
  await expect(card('Writer')).toBeVisible({ timeout: 60_000 });

  // Project Lead's stop, through the API with its own token, as stop_agent does.
  const dist = path.resolve('electron', 'dist');
  const token = await app.evaluate((_e, { dist }) => {
    const req = process.mainModule!.require;
    return req(`${dist}/core/agent-tokens.js`).mintAgentToken('o1') as string;
  }, { dist });
  const res = await fetch(`http://127.0.0.1:${apiPort(31464)}/api/agents/y1/stop`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}`, 'X-Tars-Caller-Id': 'o1' },
    body: JSON.stringify({ reason: REASON }),
    signal: AbortSignal.timeout(30_000),
  });
  expect(res.status).toBe(200);

  const y1 = (await page.evaluate(() => (window as unknown as Api).electronAPI.agent.list())).find(a => a.id === 'y1')!;
  expect(y1.status).toBe('stopped');
  const line = `Stopped by Project Lead at ${clock(y1.stoppedAt!)}: ${REASON}`;
  await expect(card('Writer').getByText(line, { exact: true })).toBeVisible({ timeout: 15_000 });
  await expect(card('Writer').getByText('stopped', { exact: true })).toBeVisible();
  await stepShot(page, '01-agents-writer-stopped');
  recordValues({ writerCard: await card('Writer').getByText(line, { exact: true }).textContent() });
  expect(errors, 'no page error').toEqual([]);
});
