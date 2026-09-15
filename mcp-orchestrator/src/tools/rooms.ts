/**
 * Room tools: how an agent talks to its team.
 *
 * Publishing is an act. Nothing an agent says reaches the room because its
 * turn ended: it reaches the room because the agent called room_post. Every
 * bound is applied by Tars, not here, so writing faster does not buy a longer
 * conversation: three rounds and ten agent messages per thread, silence
 * markers that cost nothing, and a turn after the first round only for an
 * agent another one mentioned.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { apiRequest } from "../utils/api.js";

type PostResult = {
  success?: boolean;
  refused?: string;
  message?: string;
  messageId?: string;
  threadId?: string;
  threadState?: string;
  round?: number;
  agentMessageCount?: number;
  deliveries?: Array<{ targetAgentId: string; state: string; reason?: string }>;
};

type ReadResult = {
  room?: { id: string; title: string; memberIds: string[] };
  messages?: Array<{ authorName: string; authorKind: string; text: string; createdAt: string; mentions: string[] }>;
  threads?: Array<{ id: string; state: string; round: number; agentMessageCount: number }>;
};

export function registerRoomTools(server: McpServer): void {
  // Tool: publish into the room
  server.tool(
    "room_post",
    "Say something to your team in your project's room. Use it when you have a result, a blocker, or an answer someone asked you for: mention an agent by id to address it. Saying nothing is fine and costs nothing: reply with (pass) and it is not published. Do not post to acknowledge a message or to say you are starting; post when you have something.",
    {
      text: z.string().describe("What you want to say to the room"),
      mentions: z.array(z.string()).optional().describe("Agent ids you are addressing. After the first round, only an agent another one mentioned gets a turn"),
      room: z.string().optional().describe("Room id. Defaults to your own project's room, which is almost always what you want"),
    },
    async ({ text, mentions, room }) => {
      try {
        const data = await apiRequest("/api/bus/post", "POST", { text, mentions, room }) as PostResult;

        if (data.refused) {
          return {
            content: [{
              type: "text",
              text: `Not published (${data.refused}): ${data.message ?? "the room refused it"}`,
            }],
          };
        }

        const queued = (data.deliveries ?? []).filter(d => d.state === "queued").length;
        const notSent = (data.deliveries ?? []).filter(d => d.state === "not_sent");
        const lines = [
          `Posted to ${room ?? "your project room"} (thread ${data.threadId}, round ${data.round}, ${data.agentMessageCount} agent messages so far).`,
          queued > 0 ? `${queued} teammate(s) will get it when they are free.` : "Nobody was queued for it.",
        ];
        for (const d of notSent) {
          lines.push(`Not sent to ${d.targetAgentId}: ${d.reason ?? "that provider cannot be reached at rest"}.`);
        }
        if (data.threadState === "bounded") {
          lines.push("This thread has reached its bounds: only a human message reopens it.");
        }
        return { content: [{ type: "text", text: lines.join("\n") }] };
      } catch (error) {
        return {
          content: [{ type: "text", text: `Error posting to the room: ${error instanceof Error ? error.message : String(error)}` }],
          isError: true,
        };
      }
    }
  );

  // Tool: catch up before answering
  server.tool(
    "room_read",
    "Read the recent conversation in your project's room, so you answer what was actually said rather than guessing from the one line you were handed.",
    {
      room: z.string().optional().describe("Room id. Defaults to your own project's room"),
      limit: z.number().optional().describe("How many recent messages to read. Defaults to 50"),
    },
    async ({ room, limit }) => {
      try {
        const params = new URLSearchParams();
        if (room) params.set("room", room);
        if (limit) params.set("limit", String(limit));
        const query = params.toString();
        const data = await apiRequest(`/api/bus/read${query ? `?${query}` : ""}`) as ReadResult;

        const messages = data.messages ?? [];
        if (messages.length === 0) {
          return { content: [{ type: "text", text: "Nothing has been said in this room yet." }] };
        }
        const open = (data.threads ?? []).find(t => t.state === "open");
        const header = open
          ? `Room ${data.room?.title ?? ""}: thread ${open.id} is open, round ${open.round}, ${open.agentMessageCount} agent messages so far.`
          : `Room ${data.room?.title ?? ""}: no thread is open, so only a human message starts one.`;
        const body = messages.map(m => `[${m.createdAt}] ${m.authorName} (${m.authorKind}): ${m.text}`);
        return { content: [{ type: "text", text: [header, "", ...body].join("\n") }] };
      } catch (error) {
        return {
          content: [{ type: "text", text: `Error reading the room: ${error instanceof Error ? error.message : String(error)}` }],
          isError: true,
        };
      }
    }
  );
}
