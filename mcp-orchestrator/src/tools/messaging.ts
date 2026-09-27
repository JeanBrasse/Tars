/**
 * Messaging tools (Telegram, Slack, Discord) for the MCP server
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { registerTools, text, tool } from "../../../mcp-shared/src/tools.js";
import { apiRequest } from "../utils/api.js";

const sent = (to: string, message: string) =>
  text(`Message sent to ${to}: "${message.slice(0, 100)}${message.length > 100 ? "..." : ""}"`);

export function registerMessagingTools(server: McpServer): void {
  registerTools(server, [
    tool({
      name: "send_telegram",
      description: "Send a message to Telegram. Use this to respond to the user when the request came from Telegram.",
      schema: {
        message: z.string().describe("The message to send to Telegram"),
        chat_id: z.string().optional().describe("The chat ID to send to. REQUIRED when responding to a specific Telegram chat. Use the chat_id from the incoming Telegram message. Falls back to the default chat ID if not provided."),
      },
      failure: "sending to Telegram",
      async run({ message, chat_id }) {
        await apiRequest("/api/telegram/send", "POST", { message, chat_id });
        return sent("Telegram", message);
      },
    }),
    tool({
      name: "send_slack",
      description: "Send a message to Slack. Use this to respond to the user when the request came from Slack.",
      schema: {
        message: z.string().describe("The message to send to Slack"),
      },
      failure: "sending to Slack",
      async run({ message }) {
        await apiRequest("/api/slack/send", "POST", { message });
        return sent("Slack", message);
      },
    }),
    tool({
      name: "send_discord",
      description: "Send a message to Discord. Use this to respond to the user when the request came from Discord.",
      schema: {
        message: z.string().describe("The message to send to Discord"),
        channel_id: z.string().optional().describe("The channel to send to: the channel_id of the incoming Discord message. Without it, the channel the bot last answered in."),
      },
      failure: "sending to Discord",
      async run({ message, channel_id }) {
        await apiRequest("/api/discord/send", "POST", { message, channel_id });
        return sent("Discord", message);
      },
    }),
  ]);
}
