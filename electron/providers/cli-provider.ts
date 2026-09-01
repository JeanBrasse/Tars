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
  /**
   * A session to pick up where it left off, already checked against the
   * transcript on disk (see utils/resume-session.ts). Only the providers that
   * run a binary with a verified resume flag act on it; the rest ignore it and
   * start fresh, which is what they did before.
   */
  resumeSessionId?: string;
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

/**
 * The tools an orchestrator may not use, as a command fragment.
 *
 * Here rather than in each provider because thirteen of them run the same
 * `claude` binary and none of them applied this: an orchestrator on DeepSeek,
 * Venice or Ollama Cloud could edit files directly, which is the one thing
 * orchestrator mode exists to prevent. The restriction lived only in
 * claude-provider.ts, next to the twelve copies that had gone without it.
 *
 * `Task` is in the list because it spawns an ephemeral subagent: that looks
 * like delegating and is not. The work happens inside the orchestrator's own
 * session, so it never appears in list_agents, never reaches the specialist
 * whose project and permissions were set up for it, and cannot be watched or
 * stopped from Tars. An orchestrator asked for a security audit used it
 * instead of the Audit agent that already existed.
 *
 * Bash stays available: an orchestrator still has to run git, gh and read-only
 * inspection commands to know what it is delegating.
 */
export function orchestratorToolFlags(orchestratorMode: boolean | undefined): string {
  if (!orchestratorMode) return '';
  return ' --disallowed-tools "Edit" "Write" "MultiEdit" "NotebookEdit" "Task"';
}

/**
 * Whether orchestrator mode is enforced for a binary, or only asked for.
 *
 * `--disallowed-tools` is Claude Code's flag. Fourteen providers run that
 * binary, so for them the restriction is real: the tools are not there.
 *
 * The five CLIs with their own syntax (codex, gemini, grok, opencode, pi) have
 * no verified equivalent. None of them is installed on the machine this was
 * written on, so a flag could not be checked against `--help`, and a guessed
 * flag is worse than none: it would look enforced and silently do nothing.
 * Until one is verified against the real binary, an orchestrator on those runs
 * on its persona alone, and the app says so rather than implying otherwise.
 */
export function enforcesOrchestratorMode(binaryName: string): boolean {
  return binaryName === 'claude';
}

/**
 * Extra environment for a CLI that Tars launched, as opposed to one the user is
 * driving themselves.
 *
 * This is NOT what loses a dispatch. Claude Code's auto-updater is a
 * fire-and-forget effect inside its footer component: it is started without
 * being awaited and re-runs on a thirty minute interval, and a real agent here
 * has been observed finishing a four minute task while the updater cycled and
 * failed underneath it. An agent that looks stopped on "Checking for updates"
 * is not stopped by it.
 *
 * It is still wrong for a managed PTY, for two reasons that have both happened
 * on this machine. It replaces the binary under a session that is already
 * running, so an agent ends a task on a build it did not start on and the
 * footer offers a restart the user is not the one performing. And its thirty
 * minute redraw is the only output an idle agent produces, so it fills the
 * hundred output chunks Tars keeps per agent and the terminal's real history is
 * gone: sixteen agents here have nothing left in their buffer but update noise,
 * which is what made the updater look like the cause in the first place.
 *
 * DISABLE_AUTOUPDATER rather than DISABLE_UPDATES. Both stop the background
 * updater. DISABLE_UPDATES is the administrator lockdown: it is checked first,
 * and it also makes an explicitly typed `claude update` refuse with a message
 * about contacting your IT team. These are real terminals the user can take
 * over at any time, so a command they type themselves stays theirs. Tars only
 * takes back what it started.
 *
 * Only for the binary that reads it. The fourteen providers that re-point the
 * claude binary get it; codex, gemini, grok, opencode and pi have their own
 * updaters and would silently ignore it.
 */
export function managedCliEnv(binaryName: string): Record<string, string> {
  if (binaryName !== 'claude') return {};
  return { DISABLE_AUTOUPDATER: '1' };
}

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
  let parsed: URL;
  try {
    parsed = new URL(value.trim());
  } catch {
    return false;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false;

  // Credentials in the URL would be sent to whatever host it names, and end up
  // in logs and error messages. There is no OpenAI-compatible vendor that
  // authenticates this way - they all use the API key field beside this one.
  if (parsed.username || parsed.password) return false;

  // The link-local range is where every cloud provider parks its instance
  // metadata service (169.254.169.254 on AWS, GCP and Azure alike), and the
  // stored vendor key would be attached to the call. Nothing that serves
  // completions lives there.
  //
  // Loopback and the private LAN ranges are deliberately allowed: pointing
  // this at LM Studio on 127.0.0.1, or at a vLLM box on the LAN, is the main
  // reason the custom provider exists. Blocking them to say "SSRF" would
  // remove the feature and protect nothing the user did not choose.
  const host = parsed.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (/^169\.254\./.test(host)) return false;
  if (/^fe[89ab][0-9a-f]:/.test(host)) return false;
  if (host === 'metadata.google.internal') return false;

  return true;
}
