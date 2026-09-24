import { ipcMain } from 'electron';
import type { AppSettings } from '../types';
import { sendDiscordMessage, testDiscordToken } from '../services/discord-bot';

/**
 * The two channels behind Settings > Discord's test row: "test token" asks
 * Discord who the token is (and hands back the invite link), "send test" posts
 * to the channel the bot detected.
 */
export function registerDiscordHandlers(deps: { getAppSettings: () => AppSettings }): void {
  ipcMain.handle('discord:test', async () => testDiscordToken(deps.getAppSettings().discordBotToken));

  ipcMain.handle('discord:sendTest', async () => {
    const settings = deps.getAppSettings();
    if (!settings.discordChannelId) {
      return { success: false, error: 'No channel yet: mention the bot or send it a direct message first.' };
    }
    const sent = await sendDiscordMessage('✅ Test message from Tars!', settings, settings.discordChannelId);
    return sent.ok ? { success: true } : { success: false, error: sent.error };
  });
}
