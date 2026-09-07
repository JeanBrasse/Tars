import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';
import type { AppSettings } from '../types';
import type {
  CLIProvider,
  InteractiveCommandParams,
  ScheduledCommandParams,
  OneShotCommandParams,
  ProviderModel,
  HookConfig,
} from './cli-provider';
import { safeEffort } from './cli-provider';
import { dataPath } from '../constants';

/**
 * Amp's own agent modes, from `amp --help`:
 *
 *   -m, --mode <value>  Set the agent mode (low, medium, high, ultra, or a
 *                       plugin mode by key or label, case-insensitive)
 *                       controls the model, system prompt, and tool selection
 *
 * This is the closest thing Amp has to picking a model, and it is an effort
 * dial rather than a model list, so it is wired to Tars's effort rather than to
 * its model. Tars has five levels and Amp has four, so the top two both land on
 * ultra. A plugin mode the user has installed is not in this map and cannot be,
 * since it is named by their own settings.
 */
const EFFORT_TO_MODE: Record<string, string> = {
  low: 'low',
  medium: 'medium',
  high: 'high',
  xhigh: 'ultra',
  max: 'ultra',
};

export class AmpProvider implements CLIProvider {
  readonly id = 'amp' as const;
  readonly displayName = 'Amp';
  readonly binaryName = 'amp';
  /** `amp --help` names this as the settings location, not ~/.amp. */
  readonly configDir = path.join(os.homedir(), '.config', 'amp');

  /** The settings file Amp reads by default, and the one Tars merges from. */
  private get userSettingsFile(): string {
    return path.join(this.configDir, 'settings.json');
  }

  /**
   * Tars's copy of the user's Amp settings, with the updater turned off.
   *
   * `amp --help` documents six environment variables and AMP_SKIP_UPDATE_CHECK
   * is not one of them: the update control is a setting, `amp.updates.mode`,
   * whose values are warn, disabled and auto. So the only honest way to stop a
   * CLI Tars launched from replacing its own binary under a running session
   * (the 1.6.19 lesson) is to hand it a settings file that says so.
   *
   * It is a merge of whatever the user already has rather than a fresh file,
   * which makes it correct whichever way AMP_SETTINGS_FILE behaves: --help says
   * it "overrides the default location", so if it replaces their file nothing
   * is lost, and if it merges the result is the same.
   */
  private get managedSettingsFile(): string {
    return dataPath('amp-settings.json');
  }

  getModels(): ProviderModel[] {
    // Amp publishes no model selection flag and chooses a mix of models per
    // request, so there is one entry and it means "let Amp decide". `--mode`
    // above is not a model list: it is wired to effort instead.
    return [
      { id: 'default', name: 'Default', description: 'Amp picks the model' },
    ];
  }

  resolveBinaryPath(appSettings: AppSettings): string {
    return appSettings.cliPaths?.amp || 'amp';
  }

  /**
   * Write the managed settings file and return its path, or undefined when the
   * user's own settings cannot be read.
   *
   * Failing open matters: an unreadable or malformed settings file means we
   * cannot reproduce what is in it, and pointing Amp at a partial copy would
   * silently drop the user's MCP servers, permissions and keymap. Better to
   * leave them on their own file and accept the updater.
   */
  private writeManagedSettings(): string | undefined {
    let settings: Record<string, unknown> = {};
    if (fs.existsSync(this.userSettingsFile)) {
      try {
        const raw = fs.readFileSync(this.userSettingsFile, 'utf-8');
        settings = raw.trim() ? JSON.parse(raw) : {};
      } catch (err) {
        console.warn(`[amp] could not read ${this.userSettingsFile}, leaving settings alone:`, err);
        return undefined;
      }
    }

    try {
      settings['amp.updates.mode'] = 'disabled';
      fs.writeFileSync(this.managedSettingsFile, JSON.stringify(settings, null, 2));
      return this.managedSettingsFile;
    } catch (err) {
      console.warn('[amp] could not write the managed settings file:', err);
      return undefined;
    }
  }

  buildInteractiveCommand(params: InteractiveCommandParams): string {
    let command = `'${params.binaryPath.replace(/'/g, "'\\''")}'`;

    // Amp CLI, from `amp --help`:
    //   amp                  start the interactive TUI (no subcommand)
    //   amp -x [message]     execute mode: run the prompt, print the last
    //                        assistant message, exit
    //   -m, --mode <value>   agent mode: low, medium, high, ultra
    //   --mcp-config <value> JSON config or file path, merged with settings
    //   --settings-file      alternative settings file
    //
    // There is no model flag, so params.model is deliberately unused.

    if (safeEffort(params.effort)) {
      const mode = EFFORT_TO_MODE[safeEffort(params.effort) as string];
      if (mode) command += ` --mode ${mode}`;
    }

    // Amp's permission model is settings-driven (amp.permissions,
    // amp.dangerouslyAllowAll) with no command line equivalent, so
    // params.permissionMode has nothing to map to here.

    // A delegated task arrives as params.prompt. Dropping it would launch a
    // bare TUI and report success while the task went nowhere, which is the
    // trap opencode-provider.ts documents. The TUI takes a starting message
    // only over stdin (`echo "..." | amp`), and stdin is how Tars types into a
    // live session, so the prompt goes through -x instead: it is the documented
    // way to pass one as an argument. Like opencode's `run`, that means the
    // process ends with the task and a follow-up message respawns it.
    let finalPrompt = params.prompt;
    if (params.skills && params.skills.length > 0 && !params.isSuperAgent) {
      finalPrompt = `[IMPORTANT: Use these skills for this session: ${params.skills.join(', ')}. Invoke them with /<skill-name> when relevant to the task.] ${params.prompt}`;
    }
    if (finalPrompt) {
      command += ` -x '${finalPrompt.replace(/'/g, "'\\''")}'`;
    }

    return command;
  }

  buildScheduledCommand(params: ScheduledCommandParams): string {
    let command = `"${params.binaryPath}"`;
    command += ` -x '${params.prompt.replace(/'/g, "'\\''")}'`;
    return command;
  }

  buildOneShotCommand(params: OneShotCommandParams): string {
    let command = `'${params.binaryPath.replace(/'/g, "'\\''")}'`;
    command += ` -x '${params.prompt.replace(/'/g, "'\\''")}'`;
    return command;
  }

  getPtyEnvVars(agentId: string, projectPath: string, skills: string[] | undefined, appSettings?: AppSettings): Record<string, string> {
    const vars: Record<string, string> = {
      DOROTHY_SKILLS: (skills ?? []).join(','),
      DOROTHY_AGENT_ID: agentId,
      DOROTHY_PROJECT_PATH: projectPath,
      // The orchestrator MCP and the hooks both read the CLAUDE_ names. Without
      // them the agent has no identity, so whoami fails and list_agents falls
      // back to every project's agents instead of its own.
      CLAUDE_AGENT_ID: agentId,
      CLAUDE_PROJECT_PATH: projectPath,
      CLAUDE_PROVIDER: this.id,
    };

    // AMP_API_KEY is one of the six variables `amp --help` documents. Without
    // it Amp starts a device login flow in the PTY, which an unattended agent
    // cannot complete.
    const apiKey = appSettings?.ampApiKey;
    if (apiKey) {
      vars.AMP_API_KEY = apiKey;
    }

    const managed = this.writeManagedSettings();
    if (managed) {
      vars.AMP_SETTINGS_FILE = managed;
    }

    return vars;
  }

  getEnvVarsToDelete(): string[] {
    return [];
  }

  getHookConfig(): HookConfig {
    return {
      supportsNativeHooks: false,
      configDir: this.configDir,
      settingsFile: this.userSettingsFile,
    };
  }

  async configureHooks(_hooksDir: string): Promise<void> {
    console.log('Amp: hooks not supported, using exit-code based status detection');
  }

  /**
   * Read the user's settings, apply `mutate`, write it back.
   *
   * Amp keeps MCP servers in the same settings file as everything else, under
   * the `amp.` prefixed key `amp.mcpServers`, so every write here has to
   * preserve the rest of the file.
   */
  private editUserSettings(mutate: (servers: Record<string, unknown>) => void): void {
    if (!fs.existsSync(this.configDir)) {
      fs.mkdirSync(this.configDir, { recursive: true });
    }

    let settings: Record<string, unknown> = {};
    if (fs.existsSync(this.userSettingsFile)) {
      try {
        const raw = fs.readFileSync(this.userSettingsFile, 'utf-8');
        settings = raw.trim() ? JSON.parse(raw) : {};
      } catch {
        // A file we cannot parse is not one to overwrite: it is the user's.
        return;
      }
    }

    const servers = (settings['amp.mcpServers'] && typeof settings['amp.mcpServers'] === 'object')
      ? settings['amp.mcpServers'] as Record<string, unknown>
      : {};
    mutate(servers);
    settings['amp.mcpServers'] = servers;

    fs.writeFileSync(this.userSettingsFile, JSON.stringify(settings, null, 2));
  }

  async registerMcpServer(name: string, command: string, args: string[]): Promise<void> {
    this.editUserSettings(servers => {
      servers[name] = { command, args };
    });
    console.log(`[amp] Registered MCP server ${name} in settings.json`);
  }

  async removeMcpServer(name: string): Promise<void> {
    if (!fs.existsSync(this.userSettingsFile)) return;
    this.editUserSettings(servers => {
      delete servers[name];
    });
    console.log(`[amp] Removed MCP server ${name} from settings.json`);
  }

  isMcpServerRegistered(name: string, expectedServerPath: string): boolean {
    if (!fs.existsSync(this.userSettingsFile)) return false;
    try {
      const settings = JSON.parse(fs.readFileSync(this.userSettingsFile, 'utf-8'));
      const servers = settings['amp.mcpServers'];
      if (!servers || typeof servers !== 'object') return false;
      const server = servers[name];
      if (!server) return false;
      return JSON.stringify(server).includes(expectedServerPath);
    } catch {
      return false;
    }
  }

  getMcpConfigStrategy(): 'flag' | 'config-file' {
    // Amp does have a --mcp-config flag, but the flag path in agent-routes
    // hands every provider ~/.claude/mcp.json, and Amp's own MCP shape lives
    // under the `amp.mcpServers` key. Writing the settings file is the
    // documented shape and needs no guess about what --mcp-config accepts.
    return 'config-file';
  }

  getSkillDirectories(): string[] {
    // `amp skill` manages these, and amp.skills.disableClaudeCodeSkills in the
    // settings reference says Amp reads ~/.claude/skills by default.
    return [path.join(os.homedir(), '.claude', 'skills')];
  }

  getInstalledSkills(): string[] {
    const skills: string[] = [];
    for (const dir of this.getSkillDirectories()) {
      if (!fs.existsSync(dir)) continue;
      try {
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
          if (entry.isDirectory() || entry.isSymbolicLink()) {
            skills.push(entry.name);
          }
        }
      } catch {
        // Ignore read errors
      }
    }
    return skills;
  }

  supportsSkills(): boolean {
    return true;
  }

  getMemoryBasePath(): string {
    return this.configDir;
  }

  getAddDirFlag(): string {
    // Amp has no documented flag for a second directory: it works from the
    // process cwd. Returning an empty string keeps callers from composing one.
    return '';
  }

  buildScheduledScript(params: {
    binaryPath: string;
    binaryDir: string;
    projectPath: string;
    prompt: string;
    autonomous: boolean;
    mcpConfigPath: string;
    logPath: string;
    homeDir: string;
    skills?: string[];
  }): string {
    const promptWithSkills = (params.skills && params.skills.length > 0)
      ? `[IMPORTANT: Use these skills for this session: ${params.skills.join(', ')}. Invoke them with /<skill-name> when relevant to the task.] ${params.prompt}`
      : params.prompt;

    return `#!/bin/bash

# Source shell profile for proper PATH (nvm, homebrew, etc.)
export HOME="${params.homeDir}"

if [ -s "${params.homeDir}/.nvm/nvm.sh" ]; then
  source "${params.homeDir}/.nvm/nvm.sh" 2>/dev/null || true
fi

if [ -f "${params.homeDir}/.bashrc" ]; then
  source "${params.homeDir}/.bashrc" 2>/dev/null || true
elif [ -f "${params.homeDir}/.bash_profile" ]; then
  source "${params.homeDir}/.bash_profile" 2>/dev/null || true
elif [ -f "${params.homeDir}/.zshrc" ]; then
  source "${params.homeDir}/.zshrc" 2>/dev/null || true
fi

export PATH="${params.binaryDir}:$PATH"
cd "${params.projectPath}"
echo "=== Task started at $(date) ===" >> "${params.logPath}"
"${params.binaryPath}" -x '${promptWithSkills}' >> "${params.logPath}" 2>&1
echo "=== Task completed at $(date) ===" >> "${params.logPath}"
`;
  }
}
