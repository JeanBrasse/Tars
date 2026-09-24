import { test, expect, _electron as electron, ElectronApplication, Page } from '@playwright/test';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { LATEST_RELEASE, WHATS_NEW_STORAGE_KEY } from '@/data/changelog';
import { launchSandboxed, listenForErrors, markWhatsNewSeen, recordValues, seedSandbox, stepShot } from './fixture.mjs';
import { DEV_URL, apiPort } from './ports.mjs';
import { splitPageErrors } from './surfaces.mjs';

/**
 * What a Chat room does, where chat-rooms.spec.ts photographs what it shows.
 *
 * Written before the fixes, each test red on main at 00c7fc40 (1.8.0). The ways
 * a room fails that these pin:
 *
 * 1. A draft follows you into the next room. The room view stayed mounted from
 *    one room to the next, so the words typed in orion were in the composer of
 *    tars once tars opened, and Enter posted them to tars, whose agents were
 *    never meant to read them.
 * 2. An error hides behind "no turn signal". The team rail asked whether the
 *    CLI reports its turns before it asked about an error, so an agent on grok
 *    whose session failed read "no turn signal" and "Tars sees its output, not
 *    its turns", and the reason it failed was nowhere on the page.
 *
 * Same sandbox as chat-rooms.spec.ts: the seeded journal, nothing started. The
 * statuses a test needs are set on the app's own agent map and pushed with a
 * tick, as a hook would.
 */

let app: ElectronApplication;
let page: Page;
let sandboxHome: string;
const pageErrors: string[] = [];

const DRAFT = 'typed in orion, for orion only';
const REASON = 'connect ECONNREFUSED 127.0.0.1:5432';

test.beforeAll(async () => {
  sandboxHome = fs.mkdtempSync(path.join(os.tmpdir(), 'dorothy-e2e-chat-behaviour-'));
  seedSandbox(sandboxHome, { chatRooms: true });
  app = await launchSandboxed(electron, sandboxHome, {
    timezoneId: 'UTC',
    env: {
      NODE_ENV: 'development',
      DOROTHY_DEV_URL: DEV_URL,
      DOROTHY_API_PORT: apiPort(31477),
      DOROTHY_E2E: '1',
      TZ: 'UTC',
    },
  });
  page = await app.firstWindow();
  listenForErrors(page, pageErrors);
  await markWhatsNewSeen(page, WHATS_NEW_STORAGE_KEY, String(LATEST_RELEASE.id));
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.waitForLoadState('domcontentloaded');
});

test.afterAll(async () => {
  await app?.close();
  fs.rmSync(sandboxHome, { recursive: true, force: true });
});

/** Patches agents on the app's own map and pushes a tick, as a hook would. */
async function setAgents(patches: Record<string, Record<string, unknown>>) {
  const dist = path.resolve(process.cwd(), 'electron', 'dist');
  await app.evaluate((_electron, { dist, patches }) => {
    const req = process.mainModule!.require;
    const { agents } = req(`${dist}/core/agent-manager.js`);
    for (const [id, patch] of Object.entries(patches)) {
      const agent = agents.get(id);
      if (agent) Object.assign(agent, patch);
    }
    req(`${dist}/utils/agents-tick.js`).scheduleTick();
  }, { dist, patches });
}

/** Opens a room from the conversation list and waits for its own words. */
async function openRoom(title: string, says: string) {
  const entry = page.getByRole('button', { name: title, exact: false }).filter({ hasText: title }).first();
  await entry.waitFor({ state: 'visible', timeout: 20_000 });
  await entry.click();
  await expect(page.getByText(says, { exact: false }).first()).toBeVisible({ timeout: 20_000 });
}

test('a draft typed in one room is not sent from the next', async () => {
  const errorsBefore = pageErrors.length;
  // Someone at work in each room, or neither composer takes a word.
  await setAgents({ c4: { status: 'running' }, a3: { status: 'running' } });
  await page.goto(DEV_URL + '/chat', { waitUntil: 'domcontentloaded' });

  await openRoom('orion', 'Stop there, both of you.');
  const field = page.getByRole('textbox', { name: 'Message' });
  await expect(field).toBeEditable({ timeout: 20_000 });
  await field.fill(DRAFT);
  await stepShot(page, 'draft-1-typed-in-orion');

  await openRoom('tars', 'Then I hold the write until the fit resolves');
  const composerInTars = await field.inputValue();
  await stepShot(page, 'draft-2-tars-opened');

  // What a person does next: Enter, in the field in front of them.
  await field.focus();
  await page.keyboard.press('Enter');
  await page.waitForTimeout(1500);

  const copies = await page.evaluate(async text => {
    const bus = window.electronAPI!.bus!;
    const { rooms } = await bus.listRooms();
    const found: Record<string, number> = {};
    for (const room of rooms) {
      const { messages = [] } = await bus.getRoom(room.id);
      found[room.title] = messages.filter(m => m.text === text).length;
    }
    return found;
  }, DRAFT);
  await stepShot(page, 'draft-3-after-enter');
  recordValues({ draft: { composerInTars, copies } });

  expect.soft(composerInTars, 'what the composer of tars opens with').toBe('');
  expect.soft(copies.tars ?? 0, 'copies of the orion draft posted to tars').toBe(0);
  // The sweep's rule: whatever KNOWN_PAGE_ERRORS does not tolerate fails.
  expect.soft(splitPageErrors(pageErrors.slice(errorsBefore)).fatal, 'page errors').toEqual([]);
});

test('an error on a CLI that never reports its turns still says why', async () => {
  const errorsBefore = pageErrors.length;
  // a5 runs grok, one of the five CLIs with no end of turn.
  await setAgents({ a5: { status: 'error', error: REASON } });
  await page.goto(DEV_URL + '/chat', { waitUntil: 'domcontentloaded' });
  await openRoom('1212-capital', 'Nobody was stopped: every agent finished its turn');
  await page.waitForTimeout(900);
  await stepShot(page, 'error-1-capital');

  const shown = {
    reason: await page.getByText(REASON, { exact: true }).count(),
    noTurnSignal: await page.getByText('no turn signal', { exact: true }).count(),
    outputNotTurns: await page.getByText('Tars sees its output, not its turns', { exact: true }).count(),
  };
  recordValues({ error: shown });

  expect.soft(shown.reason, 'the reason, in the team rail').toBe(1);
  expect.soft(shown.noTurnSignal, '"no turn signal" in place of the error').toBe(0);
  expect.soft(shown.outputNotTurns, 'the no-turn-signal line in place of the reason').toBe(0);
  expect.soft(splitPageErrors(pageErrors.slice(errorsBefore)).fatal, 'page errors').toEqual([]);
});
