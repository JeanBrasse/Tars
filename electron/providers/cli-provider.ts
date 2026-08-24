import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { AgentProvider, AppSettings, AgentPermissionMode, AgentEffort } from '../types';
import { dataPath } from '../constants';

/**
 * Synchronously read the persisted app settings. Providers use this in
 * command/script builders that don't receive live settings (the same pattern
 * initAgentPty and the automation handlers already use).
 */
export function readAppSettingsFromDisk(): Partial<AppSettings> {
  try {
    const settingsFile = dataPath('app-settings.json');
    return JSON.parse(fs.readFileSync(settingsFile, 'utf-8')) as Partial<AppSettings>;
  } catch {
    return {};
  }
}

/**
 * Parameters for building an interactive (PTY) agent command.
 */
export interface InteractiveCommandParams {
  binaryPath: string;
  prompt: string;
  model?: string;
  verbose?: boolean;
  permissionMode?: AgentPermissionMode;
  effort?: AgentEffort;
  secondaryProjectPath?: string;
  obsidianVaultPaths?: string[];
  mcpConfigPath?: string;
  systemPromptFile?: string;
  skills?: string[];
  isSuperAgent?: boolean;
  chrome?: boolean;
  /** Orchestrator mode: disable Edit/Write/MultiEdit/NotebookEdit so the agent
   *  cannot do implementation work itself and must delegate. See BUG 5. */
  orchestratorMode?: boolean;
}

/**
 * Parameters for building a scheduled (non-interactive, one-shot) command.
 */
export interface ScheduledCommandParams {
  binaryPath: string;
  prompt: string;
  autonomous: boolean;
  mcpConfigPath?: string;
  outputFormat?: string;
  verbose?: boolean;
}

/**
 * Parameters for building a quick one-shot command (e.g. kanban task generation).
 */
export interface OneShotCommandParams {
  binaryPath: string;
  prompt: string;
  model?: string;
}

/**
 * Model definition for a provider.
 */
export interface ProviderModel {
  id: string;
  name: string;
  description: string;
}

/**
 * Hook configuration for a provider.
 */
export interface HookConfig {
  supportsNativeHooks: boolean;
  configDir: string;
  settingsFile: string;
}

/**
 * Strategy pattern interface for CLI providers.
 * Each provider (Claude, Codex, Gemini) implements this interface
 * to encapsulate all provider-specific behavior.
 */
export interface CLIProvider {
  readonly id: AgentProvider;
  readonly displayName: string;
  readonly binaryName: string;
  readonly configDir: string;

  /** Available models for this provider */
  getModels(): ProviderModel[];

  /** Resolve the binary path from app settings or defaults */
  resolveBinaryPath(appSettings: AppSettings): string;

  /** Build command string for interactive PTY sessions */
  buildInteractiveCommand(params: InteractiveCommandParams): string;

  /** Build command string for scheduled task execution */
  buildScheduledCommand(params: ScheduledCommandParams): string;

  /** Build command string for quick one-shot prompts */
  buildOneShotCommand(params: OneShotCommandParams): string;

  /** Get environment variables to set for PTY sessions */
  getPtyEnvVars(agentId: string, projectPath: string, skills: string[] | undefined, appSettings?: AppSettings): Record<string, string>;

  /** Get environment variable names to delete before spawning PTY */
  getEnvVarsToDelete(): string[];

  /** Get hook configuration for this provider */
  getHookConfig(): HookConfig;

  /** Configure hooks in the provider's settings */
  configureHooks(hooksDir: string): Promise<void>;

  /** MCP configuration strategy: 'flag' = pass via CLI flag, 'config-file' = write to config file */
  getMcpConfigStrategy(): 'flag' | 'config-file';

  /** Register an MCP server with this provider's configuration */
  registerMcpServer(name: string, command: string, args: string[]): Promise<void>;

  /** Remove an MCP server from this provider's configuration */
  removeMcpServer(name: string): Promise<void>;

  /** Check if an MCP server is registered with the expected server path */
  isMcpServerRegistered(name: string, expectedServerPath: string): boolean;

  /** Directories where this provider reads skills from */
  getSkillDirectories(): string[];

  /** List installed skill names by scanning skill directories */
  getInstalledSkills(): string[];

  /** Whether this provider supports native skill installation */
  supportsSkills(): boolean;

  /** Base path for project memory directories */
  getMemoryBasePath(): string;

  /** Get the Tars --add-dir equivalent flag for this provider */
  getAddDirFlag(): string;

  /** Generate the shell script content for scheduled tasks */
  buildScheduledScript(params: {
    binaryPath: string;
    binaryDir: string;
    projectPath: string;
    prompt: string;
    autonomous: boolean;
    mcpConfigPath: string;
    logPath: string;
    homeDir: string;
    /** Optional skills list to inject as a prompt prefix (same as interactive sessions) */
    skills?: string[];
  }): string;
}

/**
 * The reasoning-effort values a CLI accepts.
 *
 * This lands unquoted in a command string that is written to a shell, and it
 * arrives from an IPC message, so it is validated at the point of use rather
 * than trusted from the caller.
 */
const EFFORT_VALUES = new Set(['low', 'medium', 'high', 'xhigh', 'max']);

export function safeEffort(effort: string | undefined): string | undefined {
  if (!effort) return undefined;
  return EFFORT_VALUES.has(effort) ? effort : undefined;
}

/**
 * Whether a user-supplied string is a usable OpenAI-compatible base URL:
 * parses at all, and is http/https (not file:, not a bare host that `new
 * URL()` would otherwise reject, not a scheme fetch() cannot use). Used by
 * custom-openai-provider.ts to decide whether to wire the bridge up at all,
 * and by the Settings screen before it persists what was typed - the same
 * check on both sides of the IPC boundary rather than trusting the renderer.
 */
export function isValidOpenAIBaseUrl(value: string | undefined): boolean {
  if (!value || !value.trim()) return false;
  try {
    const parsed = new URL(value.trim());
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch {
    return false;
  }
}
