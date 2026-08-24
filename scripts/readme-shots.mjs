#!/usr/bin/env node
/**
 * The screenshots the README carries.
 *
 * These are NOT the e2e baselines. Those mask the terminal bodies, because the
 * dashboard photographs real PTY output carrying a random temp directory and a
 * clock, so the baseline could never match twice. A masked terminal is right for
 * a regression test and useless in a README, where the whole point of the first
 * image is that those panes are live terminals.
 *
 * So: the same sandboxed app, the same seeded fixture, no mask.
 *
 *   npx next dev -p 3100        (or let the e2e webServer be running)
 *   node scripts/readme-shots.mjs
 *
 * Everything runs against a temp HOME. The real ~/.dorothy and ~/.claude are
 * never read or written.
 */

import { _electron as electron } from '@playwright/test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { seedSandbox } from '../e2e/fixture.mjs';

const DEV_URL = process.env.DOROTHY_DEV_URL || 'http://localhost:3100';

/** Only the ones the README actually embeds, in the order it embeds them. */
const SHOTS = [
  { file: 'dashboard.png', route: '/' },
  { file: 'chat.png', route: '/chat' },
  { file: 'agents.png', route: '/agents' },
  { file: 'kanban.png', route: '/kanban' },
  { file: 'usage.png', route: '/usage' },
  { file: 'vault.png', route: '/vault' },
  { file: 'review.png', route: '/review' },
  { file: 'brain.png', route: '/memory' },
  { file: 'extensions.png', route: '/skills' },
  { file: 'providers.png', route: '/settings?section=ai-providers' },
];

const home = mkdtempSync(join(tmpdir(), 'tars-shots-'));
seedSandbox(home);

let app;
try {
  app = await electron.launch({
    args: ['.'],
    env: {
      ...process.env,
      HOME: home,
      NODE_ENV: 'development',
      DOROTHY_DEV_URL: DEV_URL,
      DOROTHY_API_PORT: '31495',
      DOROTHY_E2E: '1',
    },
  });

  const page = await app.firstWindow();
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.waitForLoadState('domcontentloaded');
  // The splash runs its real steps; let it finish rather than photographing it.
  await page.waitForTimeout(4000);

  for (const { file, route } of SHOTS) {
    await page.goto(`${DEV_URL}${route}`);
    await page.waitForLoadState('networkidle').catch(() => {});
    // Terminals mount asynchronously and the catalogue fetch settles late.
    await page.waitForTimeout(2500);
    await page.screenshot({ path: join('screenshots', file), animations: 'disabled' });
    console.log('wrote screenshots/' + file);
  }
} finally {
  await app?.close().catch(() => {});
  rmSync(home, { recursive: true, force: true });
}
