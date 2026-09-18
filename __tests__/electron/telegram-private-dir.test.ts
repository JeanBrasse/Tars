import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

/**
 * What Tars keeps out of the agents' directory cannot be sent to Telegram
 * either, by either of the two ways an agent has of sending a file.
 *
 * Found by the audit of lot 4: Noah's conversation with the super chat moved
 * from `~/.dorothy` to `~/.tars-private`, and both Telegram guards refuse
 * `~/.dorothy` by name, so the move took the file out of the only list that
 * kept it from being sent. One call to `send_telegram_document` with the new
 * path, and the conversation was in a chat. The webhook secret moved there in
 * the same lot.
 *
 * Both guards are the real ones: `isSafeTelegramPath`, which the app's three
 * `/api/telegram/send-*` routes call, and the MCP server's own three tools,
 * loaded from `mcp-telegram/src/index.ts` with the MCP SDK replaced by a fake
 * that keeps the handlers. No file named here exists, so a path the guard lets
 * through stops at "File not found", before any network: that is the witness
 * that a refusal came from the guard and not from something after it.
 */

const tools = vi.hoisted(() => new Map<string, (args: Record<string, unknown>) => Promise<{ content: Array<{ text: string }>; isError?: boolean }>>());

vi.mock('@modelcontextprotocol/sdk/server/mcp.js', () => ({
  McpServer: class {
    tool(name: string, _description: string, _schema: unknown, handler: never) { tools.set(name, handler); }
    async connect() {}
  },
}));
vi.mock('@modelcontextprotocol/sdk/server/stdio.js', () => ({ StdioServerTransport: class {} }));
// Nothing here may reach Telegram, whatever a guard lets through.
vi.mock('https', () => {
  const refuse = () => { throw new Error('a test reached the network'); };
  return { default: { get: refuse, request: refuse }, get: refuse, request: refuse };
});

import { isSafeTelegramPath } from '../../electron/services/api-routes/utils';
import * as constants from '../../electron/constants';

const home = os.homedir();
const PRIVATE_FILES = [
  path.join(home, '.tars-private', 'overseer.json'),
  path.join(home, '.tars-private', 'hermes-webhook-secret'),
];
const DATA_FILES = [
  path.join(home, '.dorothy', 'overseer.json'),
  path.join(home, '.dorothy', 'app-settings.json'),
];
const ORDINARY = path.join(home, 'Documents', 'not-there-report.pdf');

describe('the guard of the app\'s own Telegram routes', () => {
  it('refuses the private directory as it refuses the data directory', () => {
    for (const file of [...PRIVATE_FILES, ...DATA_FILES]) {
      expect(isSafeTelegramPath(file), file).toBe(false);
    }
    expect(isSafeTelegramPath(path.join(home, '.tars-private'))).toBe(false);
    // The witness: the guard is not simply refusing everything.
    expect(isSafeTelegramPath(ORDINARY)).toBe(true);
  });

  it('refuses the files the app itself puts there, wherever the constants say they are', () => {
    // Held to the constants rather than to a spelling, so a renamed directory
    // cannot quietly leave the guard behind.
    for (const file of [constants.OVERSEER_FILE, constants.HERMES_WEBHOOK_SECRET_FILE, constants.OVERSEER_LEGACY_FILE]) {
      expect(file.startsWith(home + path.sep), `${file} is not under this HOME`).toBe(true);
      expect(isSafeTelegramPath(file), file).toBe(false);
    }
  });
});

describe('the Telegram MCP server, which every agent is given', () => {
  const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'tars-telegram-home-'));
  let savedHome: string | undefined;

  beforeAll(async () => {
    savedHome = process.env.HOME;
    // The server reads its settings from the HOME it starts in.
    process.env.HOME = tmpHome;
    fs.mkdirSync(path.join(tmpHome, '.dorothy'), { recursive: true });
    fs.writeFileSync(path.join(tmpHome, '.dorothy', 'app-settings.json'), JSON.stringify({
      telegramBotToken: 'not-a-real-bot', telegramChatId: '1',
    }));
    await import('../../mcp-telegram/src/index');
  });

  afterAll(() => {
    process.env.HOME = savedHome;
    fs.rmSync(tmpHome, { recursive: true, force: true });
  });

  const SENDERS = [
    ['send_telegram_document', 'document_path'],
    ['send_telegram_photo', 'photo_path'],
    ['send_telegram_video', 'video_path'],
  ] as const;

  for (const [tool, arg] of SENDERS) {
    it(`${tool} refuses the private directory as it refuses the data directory`, async () => {
      const send = tools.get(tool);
      expect(send, `${tool} was never registered`).toBeDefined();

      for (const dir of ['.tars-private', '.dorothy']) {
        const result = await send!({ [arg]: path.join(tmpHome, dir, 'overseer.json') });
        expect(result.isError).toBe(true);
        expect(result.content[0].text, `${tool} would send ~/${dir}`).toContain(`Refused: ${dir} holds credentials`);
      }

      // The witness: an ordinary path gets past the guard and stops at the
      // file not being there, so the refusals above are the guard's.
      const ordinary = await send!({ [arg]: path.join(tmpHome, 'Documents', 'report.pdf') });
      expect(ordinary.content[0].text).toContain('File not found');
    });
  }
});
