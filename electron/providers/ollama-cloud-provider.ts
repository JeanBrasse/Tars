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
import { safeEffort, orchestratorToolFlags } from './cli-provider';
import { DATA_DIR, DATA_DIR_SHELL } from '../constants';

export const OLLAMA_CLOUD_BASE_URL = 'https://ollama.com'; // claude appends /v1/messages

/**
 * Ollama Cloud is a different product from local Ollama (ollama-provider.ts):
 * a hosted vendor at ollama.com, billed separately, with its own API key and
 * its own model set (the ":cloud"-tagged models on ollama.com/search?c=cloud -
 * plain tags, not ":cloud"-suffixed, when talking to the hosted API directly
 * rather than proxying through a local server). Do not point this provider's
 * requests at the local-Ollama code path: they are not interchangeable.
 *
 * It DOES speak the Anthropic Messages wire format natively at
 * https://ollama.com/v1/messages, same as local Ollama v0.14+ - so, like
 * local Ollama, this needs no translation bridge. What differs is auth: its
 * endpoint requires `Authorization: Bearer <key>` and rejects `x-api-key`
 * outright (confirmed against ollama/ollama#16922, open as of this writing,
 * and docs.ollama.com/cloud's own example: `Authorization: Bearer
 * $OLLAMA_API_KEY`). The claude binary's `ANTHROPIC_API_KEY` env var is
 * always sent as `x-api-key`; the header it sends as `Authorization: Bearer`
 * is `ANTHROPIC_AUTH_TOKEN` (documented for exactly this kind of
 * gateway/proxy auth - see code.claude.com/docs/en/authentication). So this
 * is a direct provider with a header difference, not a shim: set
 * ANTHROPIC_AUTH_TOKEN instead of ANTHROPIC_API_KEY.
 */
export class OllamaCloudProvider implements CLIProvider {
  readonly id = 'ollama-cloud' as const;
  readonly displayName = 'Ollama Cloud';
  readonly binaryName = 'claude';
  readonly configDir = path.join(os.homedir(), '.claude');

  getModels(): ProviderModel[] {
    // Curated, not exhaustive - models:list (ipc-handlers.ts) prefers the
    // live models.dev catalogue, which does carry an 'ollama-cloud' entry
    // (see model-catalog.ts PROVIDER_KEYS); this is only the floor shown
    // before that loads or if it is unreachable.
    return [
      { id: 'gpt-oss:120b', name: 'GPT-OSS 120B', description: 'OpenAI open weights, flagship' },
      { id: 'gpt-oss:20b', name: 'GPT-OSS 20B', description: 'OpenAI open weights, fast' },
      { id: 'glm-5.2', name: 'GLM-5.2', description: 'Zhipu, flagship' },
      { id: 'kimi-k2.7-code', name: 'Kimi K2.7 Code', description: 'Moonshot, code-focused' },
      { id: 'deepseek-v4-pro', name: 'DeepSeek V4 Pro', description: 'Flagship reasoning' },
      { id: 'minimax-m3', name: 'MiniMax M3', description: 'Agentic' },
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

    command += orchestratorToolFlags(params.orchestratorMode);

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

  getPtyEnvVars(agentId: string, projectPath: string, skills: string[] | undefined, appSettings?: AppSettings): Record<string, string> {
    const vars: Record<string, string> = {
      CLAUDE_SKILLS: (skills ?? []).join(','),
      CLAUDE_AGENT_ID: agentId,
      CLAUDE_PROJECT_PATH: projectPath,
      CLAUDE_PROVIDER: this.id,
    };

    if (appSettings?.ollamaCloudApiKey) {
      vars.ANTHROPIC_BASE_URL = OLLAMA_CLOUD_BASE_URL;
      // See the file header: ollama.com's Anthropic-compatible endpoint wants
      // this as a Bearer token, not as x-api-key.
      vars.ANTHROPIC_AUTH_TOKEN = appSettings.ollamaCloudApiKey;
      // Blank out any real Anthropic key inherited from the user's shell so
      // the CLI cannot also send x-api-key alongside the bearer token to an
      // endpoint that has nothing to do with that key.
      vars.ANTHROPIC_API_KEY = '';
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
    // Scheduled tasks run as their own process later, so the key is read from
    // disk at run time rather than baked in at generation time (same pattern
    // as ollama-provider.ts's base-url read).
    return `#!/bin/bash
export HOME="${params.homeDir}"
if [ -s "${params.homeDir}/.nvm/nvm.sh" ]; then source "${params.homeDir}/.nvm/nvm.sh" 2>/dev/null || true; fi
if [ -f "${params.homeDir}/.zshrc" ]; then source "${params.homeDir}/.zshrc" 2>/dev/null || true; fi
export PATH="${params.binaryDir}:$PATH"
cd "${params.projectPath}"
echo "=== Task started at $(date) ===" >> "${params.logPath}"
unset CLAUDECODE
export CLAUDE_PROVIDER="ollama-cloud"
export ANTHROPIC_BASE_URL="${OLLAMA_CLOUD_BASE_URL}"
export ANTHROPIC_AUTH_TOKEN="$(jq -r '.ollamaCloudApiKey // empty' "${DATA_DIR_SHELL}/app-settings.json")"
export ANTHROPIC_API_KEY=""
"${params.binaryPath}" ${flags} --output-format stream-json --verbose --mcp-config "${params.mcpConfigPath}" --add-dir "${DATA_DIR}" -p '${promptWithSkills}' >> "${params.logPath}" 2>&1
echo "=== Task completed at $(date) ===" >> "${params.logPath}"
`;
  }
}
