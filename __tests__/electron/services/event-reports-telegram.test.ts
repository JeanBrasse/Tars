import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';

/**
 * The chain of an event report, from an agent gone to error to Noah's
 * Telegram: the status change Tars already confirms (5 s, as its desktop
 * notifications), the event reports, and the real Telegram bot on a fake
 * node-telegram-bot-api.
 *
 * How it fails, written before the code (2026-09-28):
 * 1. An agent gone to error is not reported, or is reported before the 5 s
 *    Tars waits to be sure of a status.
 * 2. A report goes to a group, or to a chat Settings does not authorize.
 * 3. It goes as Markdown, where names are markup.
 * 4. Reports keep going once the bot is stopped.
 * 5. It depends on the desktop notification switch for errors: the two are
 *    different people's settings, the Mac's and Noah's phone.
 */

const { tmpHome } = vi.hoisted(() => ({
  tmpHome: `${process.env.TMPDIR?.replace(/\/$/, '') || '/tmp'}/tars-event-reports-${process.pid}-${Date.now()}`,
}));
const bot = vi.hoisted(() => ({ sent: [] as Array<{ chatId: string; text: string; options?: Record<string, unknown> }> }));

vi.mock('os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('os')>();
  return { ...actual, homedir: () => tmpHome, default: { ...actual, homedir: () => tmpHome } };
});
vi.mock('node-pty', () => ({ spawn: vi.fn() }));
vi.mock('electron', () => ({
  app: { getPath: () => tmpHome, getAppPath: () => process.cwd(), isPackaged: false, getVersion: () => '1.9.1' },
  BrowserWindow: Object.assign(vi.fn(), { getAllWindows: () => [] }),
  Notification: vi.fn(),
}));
vi.mock('../../../electron/core/window-manager', () => ({ getMainWindow: () => null }));
vi.mock('@slack/bolt', () => ({ App: class {}, LogLevel: { INFO: 'info' } }));
vi.mock('node-telegram-bot-api', () => ({
  default: class {
    on() {}
    onText() {}
    getMe() { return Promise.resolve({ username: 'tars_test_bot' }); }
    sendMessage(chatId: unknown, text: string, options?: Record<string, unknown>) {
      bot.sent.push({ chatId: String(chatId), text, options });
      return Promise.resolve({ message_id: 1 });
    }
    stopPolling() { return Promise.resolve(); }
  },
}));

import { agents, handleStatusChangeNotification } from '../../../electron/core/agent-manager';
import { ptyProcesses } from '../../../electron/core/pty-manager';
import { initTelegramBotService, initTelegramBot, stopTelegramBot } from '../../../electron/services/telegram-bot';
import type { AgentStatus, AppSettings } from '../../../electron/types';

const NOAH = '1159136418';
const GROUP = '-100200300';
const settings = { notificationsEnabled: true, notifyOnError: false } as AppSettings;

beforeEach(() => {
  vi.useFakeTimers();
  fs.rmSync(tmpHome, { recursive: true, force: true });
  fs.mkdirSync(tmpHome, { recursive: true });
  agents.clear();
  bot.sent.length = 0;
  const live = {
    telegramEnabled: true, telegramBotToken: 't', telegramAuthToken: 'x',
    telegramAuthorizedChatIds: [NOAH, GROUP], telegramChatId: NOAH,
  } as AppSettings;
  initTelegramBotService(agents, ptyProcesses, () => live, null, () => undefined, () => {}, async () => null, vi.fn(async () => 'pty'), () => {});
  initTelegramBot();
});
afterEach(() => { stopTelegramBot(); vi.useRealTimers(); });

function goesToError(id: string, name: string, reason: string) {
  const agent = { id, name, status: 'running', provider: 'claude', projectPath: '/p/tars', skills: [], output: [], lastActivity: '' } as unknown as AgentStatus;
  agents.set(id, agent);
  handleStatusChangeNotification(agent, 'running', settings, vi.fn());
  agent.status = 'error';
  agent.error = reason;
  handleStatusChangeNotification(agent, 'error', settings, vi.fn());
}
const reports = () => bot.sent.filter(m => /stopped on an error/.test(m.text));

describe('an agent gone to error', () => {
  it('1, 2, 3, 5. is reported to Noah\'s private chat, in HTML, after Tars is sure of it, whatever the desktop switch', async () => {
    goesToError('a1', 'Tars-<Backend>', 'The API refused the request');
    await vi.advanceTimersByTimeAsync(4_000);
    expect(reports()).toEqual([]);
    await vi.advanceTimersByTimeAsync(1_000 + 120_000 + 10);

    expect(reports().map(m => m.chatId)).toEqual([NOAH]);
    expect(reports()[0].options).toMatchObject({ parse_mode: 'HTML' });
    expect(reports()[0].text).toContain('Tars-&lt;Backend&gt;');
    expect(reports()[0].text).toContain('The API refused the request');
  });

  it('4. is not reported once the bot is stopped', async () => {
    stopTelegramBot();
    goesToError('a2', 'Other', 'boom');
    await vi.advanceTimersByTimeAsync(130_000);
    expect(reports()).toEqual([]);
  });
});
