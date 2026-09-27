import { ipcMain } from 'electron';
import type { AppSettings } from '../types';
import { inviteUrlFromToken, sendDiscordMessage, testDiscordToken } from '../services/discord-bot';

/**
 * The channels behind Settings > Discord: "test token" asks Discord who the
 * token is (and hands back the invite link), "send test" posts to the channel
 * the bot detected, and the invite link shown as the token is typed is main's,
 * made from that token without asking Discord.
 */
export function registerDiscordHandlers(deps: { getAppSettings: () => AppSettings }): void {
  ipcMain.handle('discord:test', async () => testDiscordToken(deps.getAppSettings().discordBotToken));

  ipcMain.handle('discord:inviteUrl', async (_event, token: unknown) => inviteUrlFromToken(token));

  ipcMain.handle('discord:sendTest', async () => {
    const settings = deps.getAppSettings();
    if (!settings.discordChannelId) {
      return { success: false, error: 'No channel yet: mention the bot or send it a direct message first.' };
    }
    const sent = await sendDiscordMessage('✅ Test message from Tars!', settings, settings.discordChannelId);
    return sent.ok ? { success: true } : { success: false, error: sent.error };
  });
}
