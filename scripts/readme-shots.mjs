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
 *   node scripts/readme-shots.mjs                     # writes screenshots/
 *   README_SHOTS_DIR=/some/folder node scripts/readme-shots.mjs
 *
 * Everything runs in a sandbox, through launchSandboxed (e2e/fixture.mjs): a
 * temp HOME, and Electron's profile moved with --user-data-dir and
 * CFFIXED_USER_HOME, then checked. HOME alone moved ~/.dorothy and ~/.claude
 * and nothing else: until 1.9.1 this script opened the installed Tars's own
 * profile (QA's note on #214).
 *
 * What a public picture must not carry, and the e2e's seed has (2026-10-04):
 * - What's New's dot and count: the sandbox has never seen the changelog, so
 *   it is marked seen, at the newest entry src/data/changelog.ts has;
 * - Next's dev indicator, in the bottom left corner of every page `next dev`
 *   serves: hidden by e2e/screenshot.css, as the e2e does;
 * - agents that all read idle: the seed's fake CLI posts no status, so every
 *   agent the seed declares running, waiting or in error read idle once
 *   started. Here each agent runs a stand-in that reports the status the seed
 *   declares for it, through the same hook route and with the same token as
 *   the hooks Tars installs in a real CLI. The e2e's fake CLI is left alone.
 */
import { _electron as electron } from '@playwright/test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { launchSandboxed, seedSandbox } from '../e2e/fixture.mjs';

const DEV_URL = process.env.DOROTHY_DEV_URL || 'http://localhost:3100';
const API_PORT = '31495';
const OUT = process.env.README_SHOTS_DIR || 'screenshots';

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

/** What's New's newest entry, as the page compares it with what was last seen. */
function newestChangelogId() {
  const source = readFileSync('src/data/changelog.ts', 'utf8');
  const key = /WHATS_NEW_STORAGE_KEY = '([^']+)'/.exec(source)?.[1];
  const id = /\bid:\s*(\d+)/.exec(source)?.[1];
  if (!key || !id) throw new Error('src/data/changelog.ts no longer says its storage key or its newest id');
  return { key, id };
}

/**
 * A CLI for each seeded agent that reports the status the seed declares for
 * it, as the installed hooks report a real one's: it registers its session
 * (SessionStart's post, with `source`), then says it is running its task,
 * waiting on a permission dialog, or failed with its message. An idle agent
 * says nothing more. The token and the address are the ones Tars hands every
 * terminal it starts (CLAUDE_MGR_API_TOKEN, CLAUDE_MGR_API_URL).
 */
function writeStandIn(home) {
  const agentsFile = join(home, '.dorothy', 'agents.json');
  const agents = JSON.parse(readFileSync(agentsFile, 'utf8'));
  const declared = Object.fromEntries(agents.map(a => [a.id, { status: a.status, task: a.currentTask ?? '' }]));
  const dir = join(home, 'bin');
  mkdirSync(dir, { recursive: true });
  const file = join(dir, 'readme-cli.cjs');
  writeFileSync(file, [
    `#!${process.execPath}`,
    "const { randomUUID } = require('crypto');",
    `const declared = ${JSON.stringify(declared)}[process.env.CLAUDE_AGENT_ID] || { status: 'idle', task: '' };`,
    "process.stdout.write('\\x1b[2J\\x1b[HA CLI of the README sandbox: no model, no network\\r\\n> ');",
    'process.stdin.resume();',
    'const session = randomUUID();',
    `const api = process.env.CLAUDE_MGR_API_URL || 'http://127.0.0.1:${API_PORT}';`,
    'const post = body => fetch(`${api}/api/hooks/status`, {',
    "  method: 'POST',",
    "  headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${process.env.CLAUDE_MGR_API_TOKEN}` },",
    '  body: JSON.stringify({ agent_id: process.env.CLAUDE_AGENT_ID, session_id: session, ...body }),',
    '}).catch(() => undefined);',
    '(async () => {',
    "  await post({ status: 'idle', source: 'startup' });",
    "  if (declared.status === 'running') await post({ status: 'running', event: 'UserPromptSubmit', current_task: declared.task });",
    "  if (declared.status === 'waiting') {",
    "    // The task first, as a turn that reached a permission dialog had it.",
    "    await post({ status: 'running', event: 'UserPromptSubmit', current_task: declared.task });",
    "    await post({ status: 'waiting', waiting_reason: 'permission', opened_at: Date.now(), tool_name: 'Edit', tool_input: { file_path: declared.task } });",
    "  }",
    "  if (declared.status === 'error') await post({ status: 'error', error_kind: 'server_error', error_message: declared.task });",
    '})();',
    '',
  ].join('\n'), { mode: 0o755 });
  writeFileSync(agentsFile, JSON.stringify(agents.map(a => ({ ...a, cliPath: file })), null, 2));
  // Autostart starts the agents that were at work; one the seed declares in
  // error is started here, so its stand-in can say why.
  return agents.filter(a => a.status === 'error').map(a => a.id);
}

// Spelled /tmp, as the 1.9.0 pictures were taken: the project line shows the
// path, and the system's temp folder is a long random one.
const home = mkdtempSync('/tmp/tars-readme-');
seedSandbox(home);
const startHere = writeStandIn(home);
const seen = newestChangelogId();
const hideDevIndicator = readFileSync(join('e2e', 'screenshot.css'), 'utf8');
mkdirSync(OUT, { recursive: true });

let app;
try {
  app = await launchSandboxed(electron, home, {
    env: {
      NODE_ENV: 'development',
      DOROTHY_DEV_URL: DEV_URL,
      DOROTHY_API_PORT: API_PORT,
      DOROTHY_E2E: '1',
    },
  });

  const page = await app.firstWindow();
  // Before any page reads it: the changelog counts as read, so no dot and no count.
  await page.addInitScript(([key, id]) => {
    try { localStorage.setItem(key, id); } catch { /* storage blocked */ }
  }, [seen.key, seen.id]);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.waitForLoadState('domcontentloaded');
  // The splash runs its real steps; let it finish rather than photographing it.
  // The seeded agents start meanwhile and their stand-ins report their status.
  await page.waitForTimeout(6000);
  for (const id of startHere) {
    await page.evaluate(agentId => window.electronAPI.agent.start({ id: agentId, prompt: '' }), id).catch(() => {});
  }
  await page.waitForTimeout(3000);

  for (const { file, route } of SHOTS) {
    await page.goto(`${DEV_URL}${route}`);
    await page.waitForLoadState('networkidle').catch(() => {});
    // Terminals mount asynchronously and the catalogue fetch settles late.
    await page.waitForTimeout(2500);
    await page.addStyleTag({ content: hideDevIndicator });
    await page.screenshot({ path: join(OUT, file), animations: 'disabled' });
    console.log(`wrote ${join(OUT, file)}`);
  }
} finally {
  await app?.close().catch(() => {});
  rmSync(home, { recursive: true, force: true });
}
