import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

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

type Handler = (args: Record<string, unknown>) => Promise<{ content: Array<{ text: string }>; isError?: boolean }>;
const tools = new Map<string, Handler>();

/** The SDK the server gets: a McpServer that keeps the handlers, and a transport that connects to nothing. */
const FAKE_SDK: Record<string, () => unknown> = {
  '@modelcontextprotocol/sdk/server/mcp.js': () => ({
    McpServer: class {
      tool(name: string, _description: string, _schema: unknown, handler: Handler) { tools.set(name, handler); }
      async connect() {}
    },
  }),
  '@modelcontextprotocol/sdk/server/stdio.js': () => ({ StdioServerTransport: class {} }),
};

const SERVER_DIR = path.join(__dirname, '..', '..', 'mcp-telegram');

/**
 * The file the server's own import of `specifier` lands on, or the bare name
 * when nothing there provides it.
 *
 * vitest keys a mock by the file an import resolves to, and resolves each
 * import from the file that makes it. The root does not depend on the SDK, so
 * a `vi.mock('@modelcontextprotocol/sdk/...')` written in this file is keyed by
 * the bare name, and it met the server's import only where the server finds no
 * SDK either: a worktree, whose mcp-telegram has no node_modules. In the main
 * checkout the server's import lands in mcp-telegram/node_modules, the mock
 * missed it, and the real SDK took the three tools, and the worker's stdin
 * with them. Measured on 24f1889: green in the worktree the test was written
 * in, "was never registered" three times in the main checkout.
 *
 * Node's own ESM resolver, run from the server's directory, says where that
 * import lands, `import` condition and all. When it finds nothing, vitest
 * keys the server's unresolved import by the bare name, which is what is
 * returned then. A wrong answer cannot pass for a right one: the mock misses,
 * and the tests below find no tool registered.
 */
function whereTheServerFinds(specifier: string): string {
  try {
    const url = execFileSync(process.execPath, [
      '--input-type=module', '--eval', 'process.stdout.write(import.meta.resolve(process.env.SPECIFIER))',
    ], { cwd: SERVER_DIR, env: { ...process.env, SPECIFIER: specifier }, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'] });
    return fileURLToPath(url);
  } catch {
    return specifier;
  }
}

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
    for (const [specifier, fake] of Object.entries(FAKE_SDK)) vi.doMock(whereTheServerFinds(specifier), fake);
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
