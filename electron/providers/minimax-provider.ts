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
import { readAppSettingsFromDisk , safeEffort } from './cli-provider';
import { DATA_DIR, DATA_DIR_SHELL } from '../constants';

const MINIMAX_BASE_URL = 'https://api.minimax.io/anthropic'; // Anthropic-compatible endpoint
const OPENROUTER_BASE_URL = 'https://openrouter.ai/api'; // claude appends /v1/messages

/** Registry (OpenRouter-namespace) id -> vendor-native id for the direct endpoint. */
const DIRECT_MODEL_MAP: Record<string, string> = {
  'minimax/minimax-m2': 'MiniMax-M2',
  'minimax/minimax-m1': 'MiniMax-M1',
  'minimax/minimax-01': 'MiniMax-Text-01'
};

export class MiniMaxProvider implements CLIProvider {
  readonly id = 'minimax' as const;
  readonly displayName = 'MiniMax';
  readonly binaryName = 'claude';
  readonly configDir = path.join(os.homedir(), '.claude');

  /** OpenRouter-style ids ('vendor/model') are only valid via OpenRouter.
   *  On the vendor's direct Anthropic-compatible endpoint, translate to the
   *  native id (mapping table, else strip the vendor prefix). */
  private mapModelForEndpoint(model: string): string {
    const direct = !!readAppSettingsFromDisk().minimaxApiKey;
    if (!direct) return model;
    return DIRECT_MODEL_MAP[model] ?? model.replace(/^[^/]+\//, '');
  }

  getModels(): ProviderModel[] {
    return [
      { id: 'minimax/minimax-m2', name: 'MiniMax M2', description: 'Agentic flagship' },
      { id: 'minimax/minimax-m1', name: 'MiniMax M1', description: 'Long-context reasoning' },
      { id: 'minimax/minimax-01', name: 'MiniMax Text-01', description: 'Fast' },
    ];
  }

  resolveBinaryPath(appSettings: AppSettings): string {
    return appSettings.cliPaths?.claude || 'claude';
  }

  buildInteractiveCommand(params: InteractiveCommandParams): string {
    let command = `'${params.binaryPath.replace(/'/g, "'\\''")}'`;

    if (params.mcpConfigPath && fs.existsSync(params.mcpConfigPath)) {
      command += ` --mcp-config '${params.mcpConfigPath.replace(/'/g, "'\\''")}'`;
    }

    if (params.systemPromptFile && fs.existsSync(params.systemPromptFile)) {
      command += ` --append-system-prompt-file '${params.systemPromptFile.replace(/'/g, "'\\''")}'`;
    }

    if (params.model && params.model !== 'default') {
      if (!/^[a-zA-Z0-9._:\/\-]+$/.test(params.model)) {
        throw new Error('Invalid model name');
      }
      command += ` --model '${this.mapModelForEndpoint(params.model)}'`;
    }

    if (params.verbose) command += ' --verbose';

    if (params.permissionMode === 'auto') {
      command += ' --permission-mode auto';
    } else if (params.permissionMode === 'bypass') {
      command += ' --permission-mode bypassPermissions';
    }

    if (safeEffort(params.effort) && params.effort !== 'medium') {
      command += ` --effort ${safeEffort(params.effort)}`;
    }

    command += ` --add-dir '${DATA_DIR}'`;

    let finalPrompt = params.prompt;
    if (params.skills && params.skills.length > 0 && !params.isSuperAgent) {
      finalPrompt = `[IMPORTANT: Use these skills for this session: ${params.skills.join(', ')}.] ${params.prompt}`;
    }

    if (finalPrompt) {
      command += ` '${finalPrompt.replace(/'/g, "'\\''")}'`;
    }

    return command;
  }

  buildScheduledCommand(params: ScheduledCommandParams): string {
    let command = `"${params.binaryPath}"`;
    if (params.autonomous) command += ' --dangerously-skip-permissions';
    if (params.outputFormat) command += ` --output-format ${params.outputFormat}`;
    if (params.verbose) command += ' --verbose';
    if (params.mcpConfigPath) command += ` --mcp-config "${params.mcpConfigPath}"`;
    command += ` --add-dir "${DATA_DIR}"`;
    command += ` -p '${params.prompt.replace(/'/g, "'\\''")}'`;
    return command;
  }

  buildOneShotCommand(params: OneShotCommandParams): string {
    let command = `'${params.binaryPath.replace(/'/g, "'\\''")}'`;
    command += ' -p';
    if (params.model && params.model !== 'default') command += ` --model ${this.mapModelForEndpoint(params.model)}`;
    command += ` '${params.prompt.replace(/'/g, "'\\''")}'`;
    return command;
  }

  getPtyEnvVars(agentId: string, projectPath: string, skills: string[], appSettings?: AppSettings): Record<string, string> {
    const vars: Record<string, string> = {
      CLAUDE_SKILLS: skills.join(','),
      CLAUDE_AGENT_ID: agentId,
      CLAUDE_PROJECT_PATH: projectPath,
      CLAUDE_PROVIDER: this.id,
    };

    // Prefer direct MiniMax endpoint when a MiniMax key is set,
    // otherwise fall back to OpenRouter.
    if (appSettings?.minimaxApiKey) {
      vars.ANTHROPIC_BASE_URL = MINIMAX_BASE_URL;
      vars.ANTHROPIC_API_KEY = appSettings.minimaxApiKey;
    } else if (appSettings?.openRouterApiKey) {
      vars.ANTHROPIC_BASE_URL = OPENROUTER_BASE_URL;
      vars.ANTHROPIC_API_KEY = appSettings.openRouterApiKey;
    }

    return vars;
  }

  getEnvVarsToDelete(): string[] {
    return ['CLAUDECODE'];
  }

  getHookConfig(): HookConfig {
    return {
      supportsNativeHooks: true,
      configDir: this.configDir,
      settingsFile: path.join(this.configDir, 'settings.json'),
    };
  }

  async configureHooks(_hooksDir: string): Promise<void> {}

  async registerMcpServer(name: string, command: string, args: string[]): Promise<void> {
    const mcpConfigPath = path.join(this.configDir, 'mcp.json');
    if (!fs.existsSync(this.configDir)) fs.mkdirSync(this.configDir, { recursive: true });
    let mcpConfig: { mcpServers?: Record<string, unknown> } = { mcpServers: {} };
    if (fs.existsSync(mcpConfigPath)) {
      try { mcpConfig = JSON.parse(fs.readFileSync(mcpConfigPath, 'utf-8')); if (!mcpConfig.mcpServers) mcpConfig.mcpServers = {}; } catch { mcpConfig = { mcpServers: {} }; }
    }
    mcpConfig.mcpServers![name] = { command, args };
    fs.writeFileSync(mcpConfigPath, JSON.stringify(mcpConfig, null, 2));
  }

  async removeMcpServer(name: string): Promise<void> {
    const mcpConfigPath = path.join(this.configDir, 'mcp.json');
    if (!fs.existsSync(mcpConfigPath)) return;
    try {
      const mcpConfig = JSON.parse(fs.readFileSync(mcpConfigPath, 'utf-8'));
      if (mcpConfig?.mcpServers?.[name]) { delete mcpConfig.mcpServers[name]; fs.writeFileSync(mcpConfigPath, JSON.stringify(mcpConfig, null, 2)); }
    } catch { /* ignore */ }
  }

  isMcpServerRegistered(name: string, expectedServerPath: string): boolean {
    const mcpConfigPath = path.join(this.configDir, 'mcp.json');
    if (!fs.existsSync(mcpConfigPath)) return false;
    try {
      const mcpConfig = JSON.parse(fs.readFileSync(mcpConfigPath, 'utf-8'));
      const existing = mcpConfig?.mcpServers?.[name];
      if (!existing?.args) return false;
      return existing.args[existing.args.length - 1] === expectedServerPath;
    } catch { return false; }
  }

  getMcpConfigStrategy(): 'flag' | 'config-file' { return 'flag'; }

  getSkillDirectories(): string[] {
    return [path.join(this.configDir, 'skills'), path.join(os.homedir(), '.agents', 'skills')];
  }

  getInstalledSkills(): string[] {
    const skills = new Set<string>();
    for (const dir of this.getSkillDirectories()) {
      if (fs.existsSync(dir)) {
        try { for (const e of fs.readdirSync(dir, { withFileTypes: true })) { if (e.isDirectory() || e.isSymbolicLink()) skills.add(e.name); } } catch { /* ignore */ }
      }
    }
    return Array.from(skills);
  }

  supportsSkills(): boolean { return true; }
  getMemoryBasePath(): string { return path.join(this.configDir, 'projects'); }
  getAddDirFlag(): string { return '--add-dir'; }

  buildScheduledScript(params: {
    binaryPath: string; binaryDir: string; projectPath: string; prompt: string;
    autonomous: boolean; mcpConfigPath: string; logPath: string; homeDir: string;
    skills?: string[];
  }): string {
    const flags = params.autonomous ? '--dangerously-skip-permissions' : '';
    const promptWithSkills = (params.skills && params.skills.length > 0)
      ? `[IMPORTANT: Use these skills for this session: ${params.skills.join(', ')}. Invoke them with /<skill-name> when relevant to the task.] ${params.prompt}`
      : params.prompt;
    const settings = readAppSettingsFromDisk();
    const direct = !!settings.minimaxApiKey;
    const schedBase = direct ? MINIMAX_BASE_URL : OPENROUTER_BASE_URL;
    const schedKeyJq = direct ? '.minimaxApiKey' : '.openRouterApiKey';
    const envExports = `export ANTHROPIC_BASE_URL="${schedBase}"\nexport ANTHROPIC_API_KEY="$(jq -r '${schedKeyJq} // empty' "${DATA_DIR_SHELL}/app-settings.json")"\n`;

    return `#!/bin/bash
export HOME="${params.homeDir}"
if [ -s "${params.homeDir}/.nvm/nvm.sh" ]; then source "${params.homeDir}/.nvm/nvm.sh" 2>/dev/null || true; fi
if [ -f "${params.homeDir}/.zshrc" ]; then source "${params.homeDir}/.zshrc" 2>/dev/null || true; fi
export PATH="${params.binaryDir}:$PATH"
cd "${params.projectPath}"
echo "=== Task started at $(date) ===" >> "${params.logPath}"
unset CLAUDECODE
export CLAUDE_PROVIDER="minimax"
${envExports}"${params.binaryPath}" ${flags} --output-format stream-json --verbose --mcp-config "${params.mcpConfigPath}" --add-dir "${DATA_DIR}" -p '${promptWithSkills}' >> "${params.logPath}" 2>&1
echo "=== Task completed at $(date) ===" >> "${params.logPath}"
`;
  }
}
