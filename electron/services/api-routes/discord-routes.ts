import { RouteApp, RouteContext } from './types';
import { sendDiscordMessage } from '../discord-bot';

export function registerDiscordRoutes(app: RouteApp, ctx: RouteContext): void {
  // POST /api/discord/send: send_discord, an agent answering in Discord.
  app.post('/api/discord/send', async (req, sendJson) => {
    const { message, channel_id } = req.body as { message?: string; channel_id?: string };
    if (!message) {
      sendJson({ error: 'message is required' }, 400);
      return;
    }
    // The settings as they are now, not the server's startup snapshot.
    const sent = await sendDiscordMessage(`👑 ${message}`, ctx.getAppSettings(), channel_id);
    if (sent.ok) sendJson({ success: true });
    else sendJson({ error: sent.error }, sent.status);
  });
}
