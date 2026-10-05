import { test, expect, _electron as electron, type Page } from '@playwright/test';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { launchSandboxed, recordValues, seedSandbox, stepShot } from './fixture.mjs';
import { DEV_URL, apiPort } from './ports.mjs';

/**
 * A permission question Tars holds, answered from the window (#318's renderer
 * side). Frame: `Permission asked of Tars`.
 *
 * The agent's CLI is a stand-in for claude with the state mod: it registers
 * its session, then asks Tars about three calls the way the mod's tool.check
 * does (POST /api/hooks/permission, with the agent's own token, asking again
 * while Tars answers `pending`), and writes each decision it is handed to its
 * file. Its Edit sends a file's content along, which the page must never show.
 * After an `ask` it does what claude does: its dialog, and the
 * PermissionRequest hook's post.
 *
 * The person answers from where Tars shows the question: the first from the
 * Dashboard panel's line (allow); the second, seen on the Agents page card,
 * from the agent window (deny, with a reason typed in its field); the third
 * from the window again (ask in terminal), after which the question is gone
 * from the window and the agent still reads waiting, at its terminal's dialog.
 *
 * The artefact: the decisions the stand-in was handed and what the page
 * showed for each question, in values.json, and a screenshot of each step.
 */

const AGENT = { id: 'asker', name: 'Frontend Engineer' };
const FILE_CONTENT = 'THE FILE CONTENT TARS MUST NOT SHOW';
const REASON = 'edit the copy in the CMS instead';

function standIn(home: string, project: string): string {
  const calls = [
    { tool_use_id: 'toolu_1', tool: 'Bash', input: { command: 'npm run build && npm test', description: 'Build and test' } },
    { tool_use_id: 'toolu_2', tool: 'Edit', input: { file_path: path.join(project, 'src/app/page.tsx'), old_string: FILE_CONTENT, new_string: 'x' } },
    { tool_use_id: 'toolu_3', tool: 'WebFetch', input: { url: 'https://docs.example.com/api/limits', prompt: 'the limits' } },
  ];
  const bin = path.join(home, 'stand-in.cjs');
  fs.writeFileSync(bin, [
    `#!${process.execPath}`,
    "const fs = require('fs'); const path = require('path'); const crypto = require('crypto');",
    "if (process.argv.includes('--version')) { console.log('2.1.289 (Claude Code)'); process.exit(0); }",
    "const session = crypto.randomUUID();",
    `const answers = ${JSON.stringify(path.join(home, 'answers.jsonl'))};`,
    `const CALLS = ${JSON.stringify(calls)};`,
    "const post = (route, body) => fetch(process.env.CLAUDE_MGR_API_URL + route, {",
    "  method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + process.env.CLAUDE_MGR_API_TOKEN },",
    "  body: JSON.stringify({ agent_id: process.env.CLAUDE_AGENT_ID, session_id: session, ...body }),",
    "}).then(r => r.json());",
    "const pause = ms => new Promise(r => setTimeout(r, ms));",
    "(async () => {",
    "  process.stdout.write('stand-in ready\\r\\n');",
    "  await post('/api/hooks/status', { status: 'idle', source: 'startup' });",
    "  await post('/api/hooks/status', { status: 'running', event: 'UserPromptSubmit', current_task: 'Build it and run the tests before the PR' });",
    "  for (const call of CALLS) {",
    "    process.stdout.write('* ' + call.tool + ', asking Tars\\r\\n');",
    "    let answer;",
    "    do answer = await post('/api/hooks/permission', { tool: call.tool, input: call.input, tool_use_id: call.tool_use_id });",
    "    while (answer.decision === 'pending');",
    "    fs.appendFileSync(answers, JSON.stringify({ call: call.tool_use_id, ...answer }) + '\\n');",
    "    process.stdout.write('* ' + call.tool + ': ' + answer.decision + '\\r\\n');",
    "    if (answer.decision === 'ask') {",
    "      process.stdout.write('Do you want to proceed?\\r\\n');",
    "      await post('/api/hooks/status', { status: 'waiting', waiting_reason: 'permission', tool_name: call.tool, tool_input: call.input });",
    "      return;",
    "    }",
    "    await pause(1500);",
    "  }",
    "})();",
    "process.stdin.resume();",
    '',
  ].join('\n'), { mode: 0o755 });
  return bin;
}

const answersOf = (home: string) => {
  const file = path.join(home, 'answers.jsonl');
  return fs.existsSync(file) ? fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l)) : [];
};

const line = (page: Page) => page.locator(`[data-permission-ask="${AGENT.id}"]`);

test('a permission question Tars holds is answered from the panel and the window: allow, deny with a reason, ask in terminal', async () => {
  test.setTimeout(240_000);
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dorothy-e2e-permission-ask-'));
  seedSandbox(home);
  const project = path.join(home, 'projects', 'tars');
  const cli = standIn(home, project);
  // The asker alone, idle and without a terminal: the board's auto start runs
  // it through its own CLI path.
  fs.writeFileSync(path.join(home, '.dorothy', 'agents.json'), JSON.stringify([{
    id: AGENT.id, name: AGENT.name, character: 'robot', provider: 'claude', status: 'idle', role: 'worker',
    projectPath: project, skills: [], cliPath: cli,
    createdAt: '2026-10-05T08:00:00.000Z', lastActivity: '2026-10-05T08:00:00.000Z',
  }], null, 2));

  const app = await launchSandboxed(electron, home, {
    env: { NODE_ENV: 'development', DOROTHY_DEV_URL: DEV_URL, DOROTHY_API_PORT: apiPort(31462), DOROTHY_E2E: '1' },
  });
  const seen: Record<string, string> = {};
  try {
    const page = await app.firstWindow();
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.waitForLoadState('domcontentloaded');
    await page.goto(`${DEV_URL}/`, { waitUntil: 'domcontentloaded' });

    // 1. The Dashboard panel: what the Bash call runs, and allow.
    await expect(line(page)).toContainText('Asks to use Bash:', { timeout: 90_000 });
    await expect(line(page)).toContainText('npm run build && npm test');
    seen.panel = (await line(page).innerText()).replace(/\s+/g, ' ');
    await stepShot(page, '01-panel-asks');
    await line(page).getByRole('button', { name: 'allow', exact: true }).click();
    await expect.poll(() => answersOf(home).length, { timeout: 15_000 }).toBe(1);

    // 2. The Edit: its file by its path on the card, never what it holds.
    await page.goto(`${DEV_URL}/agents`, { waitUntil: 'domcontentloaded' });
    const card = page.locator('div.cursor-pointer', { hasText: AGENT.name }).filter({ has: page.getByRole('button', { name: 'open', exact: true }) }).first();
    await expect(card).toContainText('Asks to use Edit:', { timeout: 30_000 });
    seen.card = (await card.innerText()).replace(/\s+/g, ' ');
    await stepShot(page, '02-card-asks');

    // 3. The window: the question in full; deny, with a reason typed in.
    await card.getByRole('button', { name: 'open', exact: true }).click();
    await expect(line(page)).toContainText('Asks to use Edit');
    await expect(line(page)).toContainText(path.join(project, 'src/app/page.tsx'));
    await expect(line(page)).toContainText(/asked at \d\d:\d\d/);
    seen.window = (await line(page).innerText()).replace(/\s+/g, ' ');
    await stepShot(page, '03-window-asks');
    // Esc in the field goes back to the three answers, and leaves the window
    // open: the window closes on Esc, and the field keeps it.
    await line(page).getByRole('button', { name: 'deny', exact: true }).click();
    await line(page).getByRole('textbox').press('Escape');
    await expect(line(page).getByRole('textbox')).toHaveCount(0);
    await expect(page.getByRole('dialog')).toBeVisible();
    expect(answersOf(home), 'Esc answers nothing').toHaveLength(1);
    await line(page).getByRole('button', { name: 'deny', exact: true }).click();
    const why = line(page).getByRole('textbox');
    await why.fill(REASON);
    await stepShot(page, '04-window-deny-reason');
    await why.press('Enter');
    await expect.poll(() => answersOf(home).length, { timeout: 15_000 }).toBe(2);
    await expect(page.getByRole('dialog'), 'Enter in the field leaves the window open').toBeVisible();

    // 4. The WebFetch, in the same window: ask in terminal.
    await expect(line(page)).toContainText('https://docs.example.com/api/limits', { timeout: 30_000 });
    await line(page).getByRole('button', { name: 'ask in terminal', exact: true }).click();
    await expect.poll(() => answersOf(home).length, { timeout: 15_000 }).toBe(3);
    await expect(line(page)).toHaveCount(0, { timeout: 15_000 });
    await expect(page.getByText('Do you want to proceed?').first()).toBeVisible({ timeout: 15_000 });
    const status = await page.evaluate(async (id) => {
      const list = await (window as unknown as { electronAPI: { agent: { list: () => Promise<Array<{ id: string; status: string; permissionAsk?: unknown }>> } } }).electronAPI.agent.list();
      const a = list.find(x => x.id === id);
      return { status: a?.status, permissionAsk: a?.permissionAsk ?? null };
    }, AGENT.id);
    await stepShot(page, '05-window-asked-in-terminal');

    const answers = answersOf(home);
    recordValues({ seen, answers, afterAskInTerminal: status });
    expect(answers).toEqual([
      { call: 'toolu_1', decision: 'allow', reason: 'the user allowed it in Tars' },
      { call: 'toolu_2', decision: 'deny', reason: `the user refused it in Tars: ${REASON}` },
      { call: 'toolu_3', decision: 'ask' },
    ]);
    expect(status, 'at its terminal\'s dialog, the agent still waits, and Tars holds nothing').toEqual({ status: 'waiting', permissionAsk: null });
    expect(Object.values(seen).join(' '), 'a file\'s content never reaches the page').not.toContain(FILE_CONTENT);
  } finally {
    await app.close();
    fs.rmSync(home, { recursive: true, force: true });
  }
});
