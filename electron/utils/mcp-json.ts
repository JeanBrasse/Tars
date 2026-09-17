import { updateSharedJsonSync } from './shared-file';

type McpJson = { mcpServers?: Record<string, unknown>; [key: string]: unknown };

/**
 * Adds or replaces one server in an `mcp.json`: `~/.claude/mcp.json`, which
 * every Claude session Tars starts reads through --mcp-config, or the file of
 * the same shape OpenCode, Pi and Qwen Code keep.
 *
 * Fourteen providers, the MCP settings page and the orchestrator setup each
 * carried their own copy of this. Every copy rewrote the file in place, and
 * read a file it could not parse as empty, so a registration replaced every
 * other server with its own. It lives here once, through updateSharedJsonSync:
 * written beside the file and renamed over, with the file's mode kept, and
 * nothing written when the server is already as asked. A file that is not JSON
 * is left as it is, and the call fails saying so.
 */
export function addMcpServerToJson(file: string, name: string, entry: Record<string, unknown>): void {
  const outcome = updateSharedJsonSync<McpJson>(file, config => ({
    ...config,
    mcpServers: { ...config?.mcpServers, [name]: entry },
  }));
  if (outcome === 'unreadable') throw new Error(`${file} is not valid JSON: left untouched, ${name} not registered`);
  if (outcome === 'busy') throw new Error(`${file} kept changing: ${name} not registered`);
}

/** Removes one server from an `mcp.json`, and writes nothing when it is not there. */
export function removeMcpServerFromJson(file: string, name: string): void {
  const outcome = updateSharedJsonSync<McpJson>(file, config => {
    if (!config?.mcpServers?.[name]) return undefined;
    const mcpServers = { ...config.mcpServers };
    delete mcpServers[name];
    return { ...config, mcpServers };
  });
  if (outcome === 'unreadable') throw new Error(`${file} is not valid JSON: ${name} left in it`);
  if (outcome === 'busy') throw new Error(`${file} kept changing: ${name} left in it`);
}
