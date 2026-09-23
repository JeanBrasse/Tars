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
  tmpHome: `${process.env.TMPDIR?.replace(/\/$/, '') || '/tmp'}/tars-telegram-revoke-${process.pid}-${Date.now()}`,
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
import { initTelegramBotService, initTelegramBot, stopTelegramBot } from '../../../electron/services/telegram-bot';
import type { AgentStatus, AppSettings } from '../../../electron/types';

let live: AppSettings;
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
    agents, ptyProcesses, () => live, null, () => undefined, () => {}, async () => null,
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
