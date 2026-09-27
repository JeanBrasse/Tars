import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { registerTools, text, tool } from "../../../mcp-shared/src/tools.js";
import { assertPostingEnabled, xApiRequest } from "../utils/api.js";

export function registerPostTools(server: McpServer): void {
  registerTools(server, [
    // Post a new tweet
    tool({
      name: "x_post_tweet",
      description: "Post a new tweet on X (Twitter). The tweet text must be 280 characters or less. Refused unless Posting is on in Tars Settings > X (Twitter).",
      schema: {
        text: z
          .string()
          .max(280)
          .describe("The text content of the tweet (max 280 characters)"),
        quote_tweet_id: z
          .string()
          .optional()
          .describe("Optional tweet ID to quote-tweet"),
      },
      failure: "posting tweet",
      async run({ text: tweet, quote_tweet_id }) {
        assertPostingEnabled();
        const body: Record<string, unknown> = { text: tweet };
        if (quote_tweet_id) {
          body.quote_tweet_id = quote_tweet_id;
        }

        const result = (await xApiRequest("POST", "/2/tweets", body)) as {
          data?: { id: string; text: string };
        };

        if (result.data) {
          return text(`Tweet posted successfully!\n\nID: ${result.data.id}\nText: ${result.data.text}\nURL: https://x.com/i/status/${result.data.id}`);
        }

        return text(`Tweet posted. Response: ${JSON.stringify(result)}`);
      },
    }),

    // Reply to a tweet
    tool({
      name: "x_reply_tweet",
      description: "Reply to an existing tweet on X (Twitter). Refused unless Posting is on in Tars Settings > X (Twitter).",
      schema: {
        text: z
          .string()
          .max(280)
          .describe("The reply text (max 280 characters)"),
        reply_to_id: z
          .string()
          .describe("The ID of the tweet to reply to"),
      },
      failure: "replying to tweet",
      async run({ text: reply, reply_to_id }) {
        assertPostingEnabled();
        const body: Record<string, unknown> = {
          text: reply,
          reply: {
            in_reply_to_tweet_id: reply_to_id,
          },
        };

        const result = (await xApiRequest("POST", "/2/tweets", body)) as {
          data?: { id: string; text: string };
        };

        if (result.data) {
          return text(`Reply posted successfully!\n\nID: ${result.data.id}\nText: ${result.data.text}\nURL: https://x.com/i/status/${result.data.id}`);
        }

        return text(`Reply posted. Response: ${JSON.stringify(result)}`);
      },
    }),

    // Delete a tweet
    tool({
      name: "x_delete_tweet",
      description: "Delete a tweet by its ID. You can only delete tweets you own. Refused unless Posting is on in Tars Settings > X (Twitter).",
      schema: {
        tweet_id: z.string().describe("The ID of the tweet to delete"),
      },
      failure: "deleting tweet",
      async run({ tweet_id }) {
        assertPostingEnabled();
        const result = (await xApiRequest(
          "DELETE",
          `/2/tweets/${tweet_id}`
        )) as {
          data?: { deleted: boolean };
        };

        if (result.data?.deleted) {
          return text(`Tweet ${tweet_id} deleted successfully.`);
        }

        return text(`Delete response: ${JSON.stringify(result)}`);
      },
    }),
  ]);
}
