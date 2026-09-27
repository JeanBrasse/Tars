import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { registerTools, text, tool } from "../../../mcp-shared/src/tools.js";
import { apiRequest } from "../utils/api.js";

interface VaultFolder {
  id: string;
  name: string;
  parent_id: string | null;
  created_at: string;
  updated_at: string;
}

export function registerFolderTools(server: McpServer): void {
  registerTools(server, [
    tool({
      name: "vault_create_folder",
      description: "Create a folder in the Vault for organizing documents.",
      schema: {
        name: z.string().describe("Folder name"),
        parent_id: z.string().optional().describe("Parent folder ID for nesting"),
      },
      failure: "creating folder",
      async run({ name, parent_id }) {
        const result = await apiRequest("POST", "/api/vault/folders", {
          name,
          parent_id,
        }) as { success: boolean; folder: VaultFolder };

        return text(`Folder created successfully!\nID: ${result.folder.id}\nName: ${result.folder.name}\nParent: ${result.folder.parent_id || "Root"}`);
      },
    }),

    tool({
      name: "vault_list_folders",
      description: "List all folders in the Vault.",
      schema: {},
      failure: "listing folders",
      async run() {
        const result = await apiRequest("GET", "/api/vault/folders") as { folders: VaultFolder[] };

        if (result.folders.length === 0) {
          return text("No folders found.");
        }

        // Build tree structure
        const rootFolders = result.folders.filter(f => !f.parent_id);
        const childMap = new Map<string, VaultFolder[]>();
        for (const folder of result.folders) {
          if (folder.parent_id) {
            const children = childMap.get(folder.parent_id) || [];
            children.push(folder);
            childMap.set(folder.parent_id, children);
          }
        }

        function renderTree(folders: VaultFolder[], indent = ""): string {
          return folders.map(f => {
            const children = childMap.get(f.id) || [];
            let line = `${indent}- ${f.name} [${f.id.slice(0, 8)}]`;
            if (children.length > 0) {
              line += "\n" + renderTree(children, indent + "  ");
            }
            return line;
          }).join("\n");
        }

        return text(`Vault folders:\n${renderTree(rootFolders)}`);
      },
    }),

    tool({
      name: "vault_delete_folder",
      description: "Delete a folder from the Vault. Documents in the folder will be moved to root.",
      schema: {
        folder_id: z.string().describe("The folder ID to delete"),
        recursive: z.boolean().optional().describe("If true, also delete all documents and subfolders"),
      },
      failure: "deleting folder",
      async run({ folder_id, recursive }) {
        let path = `/api/vault/folders/${folder_id}`;
        if (recursive) {
          path += "?recursive=true";
        }
        await apiRequest("DELETE", path);

        return text(`Folder ${folder_id} deleted successfully.${recursive ? " All contents were also deleted." : " Documents were moved to root."}`);
      },
    }),
  ]);
}
