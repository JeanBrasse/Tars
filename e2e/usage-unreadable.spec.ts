import { test, expect, _electron as electron } from '@playwright/test';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { seedSandbox } from './fixture.mjs';

/**
 * The Usage page saying what it could not read.
 *
 * Tars prices agents by replaying the transcripts Claude Code writes, and a
 * file it cannot open contributes nothing. The total went on presenting itself
 * as the total: the one failure that arrives as a smaller bill rather than as a
 * gap, which is why nobody ever reported it.
 *
 * Driven through the real app because every part of this is renderer: the suite
 * runs in `node` with no DOM, so a hook or a page cannot be rendered. Going end
 * to end proves what matters anyway, which is the whole chain from a file the
 * process cannot open to the sentence under the subtitle.
 */

const DEV_URL = process.env.DOROTHY_DEV_URL || 'http://localhost:3100';

function assistantLine(i: number): string {
  return JSON.stringify({
    type: 'assistant',
    requestId: `req_${i}`,
    timestamp: '2026-09-15T12:00:00.000Z',
    message: {
      id: `msg_${i}`,
      model: 'claude-opus-5',
      usage: {
        input_tokens: 1000, output_tokens: 500,
        cache_read_input_tokens: 2000, cache_creation_input_tokens: 4000,
        cache_creation: { ephemeral_1h_input_tokens: 4000, ephemeral_5m_input_tokens: 0 },
      },
    },
  });
}

test('names how many transcripts it could not read, and prices the rest', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dorothy-unreadable-'));
  seedSandbox(home);

  const projects = path.join(home, '.claude', 'projects', 'demo');
  fs.mkdirSync(projects, { recursive: true });
  fs.writeFileSync(path.join(projects, 'good.jsonl'), [assistantLine(1), assistantLine(2)].join('\n'));
  const blocked = path.join(projects, 'blocked.jsonl');
  fs.writeFileSync(blocked, assistantLine(3));
  fs.chmodSync(blocked, 0o000);

  const app = await electron.launch({
    args: ['.'],
    env: { ...process.env, HOME: home, NODE_ENV: 'development', DOROTHY_DEV_URL: DEV_URL, DOROTHY_API_PORT: '31491', DOROTHY_E2E: '1' },
  });
  const page = await app.firstWindow();
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.waitForLoadState('domcontentloaded');
  await page.goto(`${DEV_URL}/usage`, { waitUntil: 'domcontentloaded' });

  const main = page.locator('main');
  await expect(main).toContainText('1 transcript could not be read', { timeout: 20_000 });

  // And the figure beside it is still the figure: the two readable turns are
  // priced. A page that says a file is missing and then shows nothing would be
  // no better than one that said nothing at all.
  await expect(main).toContainText('TOTAL TOKENS');
  const body = await main.innerText();
  expect(body).not.toContain('2 transcripts could not be read');

  await app.close();
  fs.chmodSync(blocked, 0o600);
  fs.rmSync(home, { recursive: true, force: true });
});
