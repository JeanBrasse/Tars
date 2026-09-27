import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';

/**
 * The Telegram bot's side of ask_user: where a question goes, and how the user's
 * "reply" to it is told from any other message.
 *
 * The bot is the real one (initTelegramBot), on a fake node-telegram-bot-api
 * that records what is sent and hands the handlers the messages a test writes.
 *
 * How it fails, written before the code (2026-09-28):
 * 1. A question goes to a group, or to a chat Settings does not authorize:
 *    somebody else reads it, and could answer it.
 * 2. It goes as Markdown, where the agent's words are markup, or without
 *    being kept by message id, so a reply cannot be matched to it.
 * 3. the user's reply to a question also reaches the super agent, as a new task.
 * 4. Over-correction: a message that is not a reply to a question no longer
 *    reaches the super agent.
 * 5. The proof against a fake Telegram needs the bot pointed at it
 *    (DOROTHY_TELEGRAM_API); a packaged Tars must never be, whatever its
 *    environment says.
 */

const { tmpHome } = vi.hoisted(() => ({
  tmpHome: `${process.env.TMPDIR?.replace(/\/$/, '') || '/tmp'}/tars-telegram-ask-${process.pid}-${Date.now()}`,
}));
const bot = vi.hoisted(() => ({
  on: new Map<string, (msg: Record<string, unknown>) => unknown>(),
  options: [] as Array<Record<string, unknown> | undefined>,
  packaged: false,
  sent: [] as Array<{ chatId: string; text: string; options?: Record<string, unknown>; messageId: number }>,
  next: 500,
}));

vi.mock('os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('os')>();
  return { ...actual, homedir: () => tmpHome, default: { ...actual, homedir: () => tmpHome } };
});
vi.mock('node-pty', () => ({ spawn: vi.fn(() => ({ pid: 1, process: 'bash', write: vi.fn(), kill: vi.fn(), resize: vi.fn(), onData: vi.fn(), onExit: vi.fn() })) }));
vi.mock('electron', () => ({
  app: { getPath: () => tmpHome, getAppPath: () => process.cwd(), get isPackaged() { return bot.packaged; }, getVersion: () => '1.9.1' },
  BrowserWindow: Object.assign(vi.fn(), { getAllWindows: () => [] }),
  Notification: vi.fn(),
}));
vi.mock('../../../electron/core/window-manager', () => ({ getMainWindow: () => null }));
vi.mock('@slack/bolt', () => ({ App: class {}, LogLevel: { INFO: 'info' } }));
vi.mock('node-telegram-bot-api', () => ({
  default: class {
    constructor(_token: string, options?: Record<string, unknown>) { bot.options.push(options); }
    on(event: string, handler: (msg: Record<string, unknown>) => unknown) { bot.on.set(event, handler); }
    onText() {}
    getMe() { return Promise.resolve({ username: 'tars_test_bot' }); }
    sendMessage(chatId: unknown, text: string, options?: Record<string, unknown>) {
      const messageId = bot.next++;
      bot.sent.push({ chatId: String(chatId), text, options, messageId });
      return Promise.resolve({ message_id: messageId, chat: { id: Number(chatId) } });
    }
    stopPolling() { return Promise.resolve(); }
  },
}));

import { agents } from '../../../electron/core/agent-manager';
import { ptyProcesses } from '../../../electron/core/pty-manager';
import { initTelegramBotService, initTelegramBot, stopTelegramBot } from '../../../electron/services/telegram-bot';
import { askUser } from '../../../electron/services/user-questions';
import type { AgentStatus, AppSettings } from '../../../electron/types';

const NOAH = '1159136418';
const GROUP = '-100200300';
let live: AppSettings;

beforeEach(() => {
  fs.rmSync(tmpHome, { recursive: true, force: true });
  fs.mkdirSync(tmpHome, { recursive: true });
  agents.clear();
  ptyProcesses.clear();
  bot.on.clear();
  bot.sent.length = 0;
  live = {
    telegramEnabled: true, telegramBotToken: 'test-bot-token', telegramAuthToken: 'x',
    telegramAuthorizedChatIds: [NOAH, GROUP], telegramChatId: NOAH,
  } as AppSettings;
  initTelegramBotService(agents, ptyProcesses, () => live, null, () => undefined, () => {}, async () => null, vi.fn(async () => 'pty'), () => {});
  initTelegramBot();
  agents.set('a1', { id: 'a1', name: 'Asker', status: 'running', provider: 'claude', projectPath: '/p/tars', skills: [], output: [], lastActivity: '' } as unknown as AgentStatus);
});
afterEach(() => stopTelegramBot());

const message = (over: Record<string, unknown>) => bot.on.get('message')!({
  message_id: 900, chat: { id: Number(NOAH), type: 'private' }, from: { id: Number(NOAH) }, text: 'hello', ...over,
});
const settle = () => new Promise(r => setTimeout(r, 30));

describe('a question on Telegram', () => {
  it('1, 2. goes to the authorized private chat only, in HTML', async () => {
    const r = await askUser({ agentId: 'a1', question: 'Staging or prod?' });
    expect(r).toMatchObject({ ok: true });

    expect(bot.sent.map(m => m.chatId)).toEqual([NOAH]);
    expect(bot.sent[0].options).toMatchObject({ parse_mode: 'HTML' });
    // No link preview: a URL in an agent's question would have Telegram fetch
    // it and show that site's title and picture in the user's chat (gate of #231).
    expect(bot.sent[0].options).toMatchObject({ disable_web_page_preview: true, link_preview_options: JSON.stringify({ is_disabled: true }) });
    expect(bot.sent[0].text).toContain('<blockquote>Staging or prod?</blockquote>');
  });

  it('3. takes the user\'s reply to it away from the super agent', async () => {
    await askUser({ agentId: 'a1', question: 'Staging or prod?' });
    const question = bot.sent[0];
    bot.sent.length = 0;

    await message({ text: 'Staging.', reply_to_message: { message_id: question.messageId } });
    await settle();

    // The agent has no terminal here, so the user is told it was not delivered,
    // in a reply to their own message; nothing about a Super Agent.
    expect(bot.sent).toHaveLength(1);
    expect(bot.sent[0].text).toMatch(/not delivered|no session/i);
    expect(bot.sent[0].text).not.toMatch(/Super Agent/);
    expect(bot.sent[0].options).toMatchObject({ reply_to_message_id: 900 });
  });

  it('4. leaves any other message to the super agent, a reply to another message included', async () => {
    await askUser({ agentId: 'a1', question: 'Staging or prod?' });
    bot.sent.length = 0;

    await message({ text: 'What is everyone doing?', reply_to_message: { message_id: 1 } });
    await settle();

    expect(bot.sent.at(-1)?.text).toMatch(/Super Agent/);
  });
});

describe('which Telegram the bot talks to', () => {
  const restart = () => { stopTelegramBot(); bot.options.length = 0; initTelegramBot(); return bot.options.at(-1); };
  afterEach(() => { delete process.env.DOROTHY_TELEGRAM_API; bot.packaged = false; });

  it('5. is the one DOROTHY_TELEGRAM_API names, in a development run', () => {
    process.env.DOROTHY_TELEGRAM_API = 'http://127.0.0.1:39200';
    expect(restart()).toMatchObject({ polling: true, baseApiUrl: 'http://127.0.0.1:39200' });
  });

  it('5. is always Telegram\'s own in a packaged Tars', () => {
    bot.packaged = true;
    process.env.DOROTHY_TELEGRAM_API = 'http://127.0.0.1:39200';
    expect(restart()?.baseApiUrl).toBeUndefined();
  });
});
