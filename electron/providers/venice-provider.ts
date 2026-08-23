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
import { DATA_DIR, DATA_DIR_SHELL, VENICE_SHIM_PORT } from '../constants';

const VENICE_SHIM_BASE_URL = `http://127.0.0.1:${VENICE_SHIM_PORT}`; // claude appends /v1/messages

/**
 * Venice AI has no Anthropic-compatible endpoint (confirmed against
 * docs.venice.ai: /chat/completions, /embeddings, /images/*, /audio/*,
 * /video/*, /models - OpenAI-compatible only, no /v1/messages). Unlike every
 * other alt provider here, the claude binary cannot reach it directly. It is
 * routed through Tars's own local translation shim instead - see
 * services/venice-shim.ts for the wire-format translation and, importantly,
 * for why ANTHROPIC_API_KEY below is Tars's own local API token and NOT the
 * user's Venice key.
 */
export class VeniceProvider implements CLIProvider {
  readonly id = 'venice' as const;
  readonly displayName = 'Venice AI';
  readonly binaryName = 'claude';
  readonly configDir = path.join(os.homedir(), '.claude');

  getModels(): ProviderModel[] {
    return [
      { id: 'llama-3.3-70b', name: 'Llama 3.3 70B', description: 'Meta, balanced' },
      { id: 'venice-uncensored-1-2', name: 'Venice Uncensored', description: 'Unfiltered, Venice-tuned' },
      { id: 'deepseek-v3.2', name: 'DeepSeek V3.2', description: 'Flagship chat' },
      { id: 'qwen3-235b-a22b-instruct-2507', name: 'Qwen3 235B', description: 'Large MoE' },
      { id: 'hermes-3-llama-3.1-405b', name: 'Hermes 3 405B', description: 'Agentic' },
      { id: 'mistral-small-3-2-24b-instruct', name: 'Mistral Small', description: 'Fast' },
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
      command += ` --model '${params.model}'`;
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
    if (params.model && params.model !== 'default') command += ` --model ${params.model}`;
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

    // Only wire the shim once a Venice key exists to forward - same gate
    // DeepSeek/Moonshot/etc. use for their own key, just with no OpenRouter
    // fallback (Venice is not on OpenRouter, see the design note).
    if (appSettings?.veniceApiKey) {
      vars.ANTHROPIC_BASE_URL = VENICE_SHIM_BASE_URL;
      // NOT the Venice key. The claude binary sends this as `x-api-key` to
      // whatever ANTHROPIC_BASE_URL points at; here that's Tars's own shim on
      // 127.0.0.1, which authenticates the request with Tars's local API
      // token (the same one api-server.ts already guards /api/* with) and
      // only then reads the real Venice key from app-settings.json itself to
      // attach to the outbound call. See services/venice-shim.ts.
      const { getApiToken } = require('../services/api-server') as typeof import('../services/api-server');
      vars.ANTHROPIC_API_KEY = getApiToken();
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
    return `#!/bin/bash
export HOME="${params.homeDir}"
if [ -s "${params.homeDir}/.nvm/nvm.sh" ]; then source "${params.homeDir}/.nvm/nvm.sh" 2>/dev/null || true; fi
if [ -f "${params.homeDir}/.zshrc" ]; then source "${params.homeDir}/.zshrc" 2>/dev/null || true; fi
export PATH="${params.binaryDir}:$PATH"
cd "${params.projectPath}"
echo "=== Task started at $(date) ===" >> "${params.logPath}"
unset CLAUDECODE
export CLAUDE_PROVIDER="venice"
export ANTHROPIC_BASE_URL="${VENICE_SHIM_BASE_URL}"
export ANTHROPIC_API_KEY="$(cat "${DATA_DIR_SHELL}/api-token" 2>/dev/null)"
"${params.binaryPath}" ${flags} --output-format stream-json --verbose --mcp-config "${params.mcpConfigPath}" --add-dir "${DATA_DIR}" -p '${promptWithSkills}' >> "${params.logPath}" 2>&1
echo "=== Task completed at $(date) ===" >> "${params.logPath}"
`;
  }
}
