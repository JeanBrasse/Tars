import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';

/**
 * A Telegram attachment that cannot be written to disk fails that download.
 * It does not throw at the top of the main process.
 *
 * The download opened its write stream with nothing listening for the
 * stream's 'error', and a stream throws an 'error' nobody hears: in the main
 * process, the "Uncaught Exception" window, the same class as the ACP launch
 * that brought it up on 2026-09-18. A full disk or a folder that cannot be
 * written is all it takes. Here the downloads folder is read-only.
 *
 * The bot and the file server are fakes; the handler, the download and the
 * stream are the real ones.
 */

type Handler = (msg: Record<string, unknown>) => Promise<void> | void;

const bot = vi.hoisted(() => ({
  handlers: new Map<string, (msg: Record<string, unknown>) => Promise<void> | void>(),
  sent: [] as string[],
}));

vi.mock('electron', () => ({ BrowserWindow: class {}, app: { getPath: () => '/tmp' } }));
vi.mock('node-pty', () => ({ spawn: vi.fn() }));
vi.mock('node-telegram-bot-api', () => ({
  default: class {
    on(event: string, handler: Handler) { bot.handlers.set(event, handler); }
    onText() {}
    getMe() { return Promise.resolve({ username: 'tars_test_bot' }); }
    getFile() { return Promise.resolve({ file_path: 'photos/file_1.jpg' }); }
    sendMessage(_chatId: unknown, text: string) { bot.sent.push(text); return Promise.resolve({}); }
    stopPolling() { return Promise.resolve(); }
  },
}));
// Telegram's file server: a 200 with a few bytes, as the download expects.
vi.mock('https', () => ({
  get: (_url: string, onResponse: (res: Readable & { statusCode: number }) => void) => {
    const request = new EventEmitter();
    setImmediate(() => onResponse(Object.assign(Readable.from([Buffer.from('jpeg bytes')]), { statusCode: 200 })));
    return request;
  },
}));

import { initTelegramBotService, initTelegramBot, stopTelegramBot } from '../../../electron/services/telegram-bot';
import { TELEGRAM_DOWNLOADS_DIR } from '../../../electron/constants';
import type { AppSettings } from '../../../electron/types';
import { makeUnwritable } from '../../setup/file-access';

const uncaught: Error[] = [];
/** Gives the downloads folder its writes back, once a test has taken them. */
let writable: (() => void) | undefined;
const record = (err: Error) => { uncaught.push(err); };

const settings = {
  telegramEnabled: true,
  telegramBotToken: 'test-bot-token',
  telegramAuthToken: 'test-auth-token',
  telegramAuthorizedChatIds: ['42'],
} as AppSettings;

beforeEach(() => {
  expect(TELEGRAM_DOWNLOADS_DIR.startsWith(process.env.HOME!), 'the downloads folder is not under the throwaway HOME').toBe(true);
  uncaught.length = 0;
  bot.handlers.clear();
  bot.sent.length = 0;
  process.on('uncaughtException', record);
  initTelegramBotService(
    new Map(), new Map(),
    () => settings,
    null, () => undefined, () => {}, async () => null, async () => 'unused', () => {},
  );
  initTelegramBot();
});

afterEach(async () => {
  await new Promise(resolve => setTimeout(resolve, 250));
  process.off('uncaughtException', record);
  stopTelegramBot();
  writable?.();
  writable = undefined;
  expect(uncaught.map(e => String(e)), 'an error reached the top of the process').toEqual([]);
});

describe('a Telegram photo that cannot be saved', () => {
  it('tells the chat the download failed, and throws nothing', async () => {
    fs.mkdirSync(TELEGRAM_DOWNLOADS_DIR, { recursive: true });
    writable = makeUnwritable(TELEGRAM_DOWNLOADS_DIR, 0o700);
    const onPhoto = bot.handlers.get('photo');
    expect(onPhoto, 'the bot registered no photo handler').toBeDefined();

    let timer: NodeJS.Timeout | undefined;
    const handled = await Promise.race([
      Promise.resolve(onPhoto!({ chat: { id: 42, type: 'private' }, message_id: 7, photo: [{ file_id: 'f1' }] })).then(() => 'handled'),
      new Promise<string>(resolve => { timer = setTimeout(() => resolve('the download never settled'), 3_000); }),
    ]);
    clearTimeout(timer);
    await new Promise(resolve => setTimeout(resolve, 250));

    expect(uncaught.map(e => String(e)), 'writing the file threw at the top of the process').toEqual([]);
    expect(handled).toBe('handled');
    expect(bot.sent.some(text => text.startsWith('❌ Failed to download image')), `the chat was told: ${JSON.stringify(bot.sent)}`).toBe(true);
  });
});
