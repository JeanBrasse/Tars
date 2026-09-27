import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { registerTools, text, tool } from "../../../mcp-shared/src/tools.js";
import { apiRequest } from "../utils/api.js";

interface SearchResult {
  id: string;
  title: string;
  content: string;
  author: string;
  tags: string;
  created_at: string;
  updated_at: string;
  snippet: string;
}

export function registerSearchTools(server: McpServer): void {
  registerTools(server, [
    tool({
      name: "vault_search",
      description: "Full-text search across all Vault documents. Searches titles, content, and tags.",
      schema: {
        query: z.string().describe("Search query (supports FTS5 syntax: AND, OR, NOT, phrase matching with quotes)"),
        limit: z.number().optional().describe("Maximum results to return (default: 20)"),
      },
      failure: "searching vault",
      async run({ query, limit }) {
        const params = new URLSearchParams({ q: query });
        if (limit) params.set("limit", String(limit));

        const result = await apiRequest("GET", `/api/vault/search?${params.toString()}`) as { results: SearchResult[] };

        if (result.results.length === 0) {
          return text(`No documents found matching "${query}".`);
        }

        const summary = result.results.map(r => {
          const tags = JSON.parse(r.tags || "[]");
          // Strip HTML mark tags for plain text output
          const snippet = r.snippet?.replace(/<\/?mark>/g, "**") || "";
          return `- [${r.id.slice(0, 8)}] ${r.title} (by ${r.author})\n  ${snippet}${tags.length > 0 ? `\n  Tags: ${tags.join(", ")}` : ""}`;
        }).join("\n\n");

        return text(`Found ${result.results.length} result(s) for "${query}":\n\n${summary}`);
      },
    }),
  ]);
}
