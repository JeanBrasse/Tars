import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

/**
 * A chat removed or a token regenerated in Settings stops working at once
 * (the audit's lead #19).
 *
 * The bot checked chats and /auth tokens against the settings object it was
 * started with, while every Settings save replaces main's object: after any
 * save, 'remove' and 'regenerate' changed only the new object, the removed
 * chat kept commanding agents, the old token kept enrolling chats, and a
 * successful /auth wrote the bot's old object back to disk. The bot now reads
 * the settings as they are, through a getter, at every message.
 *
 * The bot and its handlers are the real ones; the Telegram client is a recorder
 * of the handlers the bot registers and of what it sends.
 */

const { tmpHome } = vi.hoisted(() => ({
  tmpHome: process.getBuiltinModule('node:path').join(process.getBuiltinModule('node:os').tmpdir(), `tars-telegram-revoke-${process.pid}-${Date.now()}`),
}));
const bot = vi.hoisted(() => ({
  texts: [] as Array<{ pattern: RegExp; handler: (msg: Record<string, unknown>, match: RegExpExecArray | null) => unknown }>,
  sent: [] as Array<{ chatId: string; text: string }>,
}));

vi.mock('os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('os')>();
  return { ...actual, homedir: () => tmpHome, default: { ...actual, homedir: () => tmpHome } };
});
vi.mock('node-pty', () => ({ spawn: vi.fn(() => ({ pid: 1, process: 'bash', write: vi.fn(), kill: vi.fn(), resize: vi.fn(), onData: vi.fn(), onExit: vi.fn() })) }));
vi.mock('electron', () => ({
  app: { getPath: () => tmpHome, getAppPath: () => process.cwd(), isPackaged: false, getVersion: () => '1.7.9' },
  BrowserWindow: Object.assign(vi.fn(), { getAllWindows: () => [] }),
  Notification: vi.fn(),
}));
vi.mock('../../../electron/core/window-manager', () => ({ getMainWindow: () => null }));
vi.mock('@slack/bolt', () => ({ App: class {}, LogLevel: { INFO: 'info' } }));
vi.mock('node-telegram-bot-api', () => ({
  default: class {
    on() {}
    onText(pattern: RegExp, handler: (msg: Record<string, unknown>, match: RegExpExecArray | null) => unknown) {
      bot.texts.push({ pattern, handler });
    }
    getMe() { return Promise.resolve({ username: 'tars_test_bot' }); }
    sendMessage(chatId: unknown, text: string) { bot.sent.push({ chatId: String(chatId), text }); return Promise.resolve({}); }
    stopPolling() { return Promise.resolve(); }
  },
}));

import { agents } from '../../../electron/core/agent-manager';
import { ptyProcesses } from '../../../electron/core/pty-manager';
import {
  initTelegramBotService, initTelegramBot, stopTelegramBot, sendToSuperAgent, sendTelegramMessage,
} from '../../../electron/services/telegram-bot';
import type { AgentStatus, AppSettings } from '../../../electron/types';

let live: AppSettings;
let superAgent: AgentStatus | undefined;
const saved: AppSettings[] = [];
const initAgentPty = vi.fn(async () => 'pty-new');

async function send(chatId: string, text: string) {
  const handler = bot.texts.find(t => t.pattern.test(text));
  expect(handler, `no handler for ${text}`).toBeDefined();
  await handler!.handler({ chat: { id: Number(chatId), type: 'private' }, text }, handler!.pattern.exec(text));
  await new Promise(resolve => setTimeout(resolve, 50));
}
const lastReply = (chatId: string) => bot.sent.filter(m => m.chatId === chatId).at(-1)?.text ?? '';

beforeEach(() => {
  fs.rmSync(tmpHome, { recursive: true, force: true });
  fs.mkdirSync(path.join(tmpHome, 'project'), { recursive: true });
  agents.clear();
  ptyProcesses.clear();
  bot.texts.length = 0;
  bot.sent.length = 0;
  saved.length = 0;
  superAgent = undefined;
  initAgentPty.mockClear();
  agents.set('w1', {
    id: 'w1', name: 'Worker', status: 'idle', provider: 'claude', projectPath: path.join(tmpHome, 'project'),
    skills: [], output: [], lastActivity: new Date().toISOString(),
  } as AgentStatus);
  live = {
    telegramEnabled: true, telegramBotToken: 'test-bot-token', telegramAuthToken: 'old-token',
    telegramAuthorizedChatIds: ['42'], telegramChatId: '42',
  } as AppSettings;
  initTelegramBotService(
    agents, ptyProcesses, () => live, null, () => superAgent, () => {}, async () => null,
    initAgentPty, s => { saved.push(s); },
  );
  initTelegramBot();
});

afterEach(() => {
  stopTelegramBot();
});

describe('a chat removed in Settings', () => {
  it('commands nothing once removed, though Settings replaced the object since the bot started', async () => {
    // A delta save (app:saveSettings) builds a new object; 'remove' then edits it.
    live = { ...live, telegramAuthorizedChatIds: [], telegramChatId: '' };

    await send('42', '/start_agent Worker rebase onto main');

    expect(lastReply('42')).toContain('Authentication Required');
    expect(initAgentPty, 'a terminal was opened for a revoked chat').not.toHaveBeenCalled();
  });
});

describe('a token regenerated in Settings', () => {
  it('stops enrolling with the old token and enrolls with the new one, into the settings as they are', async () => {
    live = { ...live, telegramAuthToken: 'new-token' };

    await send('77', '/auth old-token');
    expect(live.telegramAuthorizedChatIds).not.toContain('77');

    await send('77', '/auth new-token');
    expect(live.telegramAuthorizedChatIds).toContain('77');
    // What is written is the live object, not the bot's old one with the old token.
    expect(saved.at(-1)?.telegramAuthToken).toBe('new-token');
  });
});

/**
 * The chat a reply goes to (the audit's gate of #137: lead #19's last path).
 *
 * The bot remembers the last chat that asked the super agent something and
 * sends there everything that names no chat of its own: the super agent's
 * reply, its error, and main's status notices. That chat was checked when it
 * wrote in and never again, so a chat removed in Settings afterwards went on
 * receiving all three until another chat wrote.
 *
 * How this can fail, written before the fix:
 * 1. a chat removed after it asked still receives what is sent without a chat named;
 * 2. the check reads the settings the bot started with, not the ones a save put in place;
 * 3. an authorized chat that asked stops receiving its answers: the fix over-blocks;
 * 4. what the removed chat would have received is lost, where the chats allowed now should get it;
 * 5. a chat named by the caller skips the check;
 * 6. the default chat of Settings, which the send route and mcp-telegram accept, is refused;
 * 7. ids compared with the wrong type: Telegram hands the id over as a number.
 */
describe('the chat a reply goes to', () => {
  beforeEach(() => {
    superAgent = {
      id: 's1', name: 'Super Agent', role: 'orchestrator', status: 'idle', provider: 'claude',
      projectPath: path.join(tmpHome, 'project'), skills: [], output: [], lastActivity: new Date().toISOString(),
    } as AgentStatus;
    agents.set('s1', superAgent);
    live = { ...live, telegramAuthorizedChatIds: ['42', '77'], telegramChatId: '42' };
  });

  it('is the authorized chat that asked, for its answers and its errors', async () => {
    await sendToSuperAgent('77', 'what is everyone doing?');
    bot.sent.length = 0;

    sendTelegramMessage('the answer');
    sendTelegramMessage('Super Agent error: boom');

    expect(bot.sent).toEqual([
      { chatId: '77', text: 'the answer' },
      { chatId: '77', text: 'Super Agent error: boom' },
    ]);
  });

  it('is no longer a chat removed since it asked: what it would have received goes to the chats allowed now', async () => {
    await sendToSuperAgent('77', 'what is everyone doing?');
    // Removed in Settings: a save replaces the object the bot reads.
    live = { ...live, telegramAuthorizedChatIds: ['42'] };
    bot.sent.length = 0;

    sendTelegramMessage('the answer');
    sendTelegramMessage('Super Agent error: boom');

    expect(bot.sent).toEqual([
      { chatId: '42', text: 'the answer' },
      { chatId: '42', text: 'Super Agent error: boom' },
    ]);
  });

  it('refuses a chat the caller names when Settings does not allow it, and keeps the default chat', () => {
    live = { ...live, telegramAuthorizedChatIds: ['77'], telegramChatId: '42' };

    sendTelegramMessage('for a stranger', 'Markdown', '99');
    sendTelegramMessage('for the default chat', 'Markdown', '42');

    expect(bot.sent).toEqual([{ chatId: '42', text: 'for the default chat' }]);
  });
});
