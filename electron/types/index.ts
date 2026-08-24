export interface WorktreeConfig {
  enabled: boolean;
  branchName: string;
}

export type AgentCharacter = 'robot' | 'ninja' | 'wizard' | 'astronaut' | 'knight' | 'pirate' | 'alien' | 'viking';

export type AgentProvider =
  | 'claude'
  | 'codex'
  | 'gemini'
  | 'grok'
  | 'opencode'
  | 'pi'
  | 'local'
  | 'openrouter'
  | 'deepseek'
  | 'mimo'
  | 'moonshot'
  | 'qwen'
  | 'zhipu'
  | 'minimax'
  | 'nvidia'
  | 'nous-portal'
  | 'ollama'
  | 'venice'
  | 'ollama-cloud'
  | 'custom-openai';

/** Permission mode for agent tool use:
 * - normal: Claude asks for confirmation on each tool use
 * - auto: agent runs fully autonomously (--dangerously-skip-permissions)
 * - bypass: same as auto, explicit intent to bypass all checks
 */
export type AgentPermissionMode = 'normal' | 'auto' | 'bypass';

/** Effort level for agent reasoning:
 * - low: fast, minimal thinking
 * - medium: default balanced mode
 * - high: extended thinking (--think flag)
 */
export type AgentEffort = 'low' | 'medium' | 'high' | 'xhigh' | 'max';

export interface AgentStatus {
  id: string;
  status: 'idle' | 'running' | 'completed' | 'error' | 'waiting';
  projectPath: string;
  secondaryProjectPath?: string;
  worktreePath?: string;
  branchName?: string;
  skills: string[];
  currentTask?: string;
  output: string[];
  lastActivity: string;
  error?: string;
  ptyId?: string;
  /** CWD the active PTY was spawned with. Used to detect stale PTYs when
   *  the agent's worktreePath changes after the PTY was started. Not persisted. */
  ptyCwd?: string;
  character?: AgentCharacter;
  name?: string;
  pathMissing?: boolean;
  /** @deprecated use permissionMode instead */
  skipPermissions?: boolean;
  permissionMode?: AgentPermissionMode;
  effort?: AgentEffort;
  /** When true, the agent is an orchestrator and should not have Edit/Write
   *  implementation tools available: it can only read, delegate, and use
   *  shell/git commands. See BUG 5. */
  orchestratorMode?: boolean;
  /** 'orchestrator' agents delegate work and message other agents of the SAME
   *  project; 'worker' agents receive tasks. Migrated from name-substring
   *  matching in loadAgents. */
  role?: 'orchestrator' | 'worker';
  currentSessionId?: string;
  /**
   * The last session this agent ran, kept so it can be resumed.
   *
   * Distinct from `currentSessionId` on purpose. That one is ownership: which
   * live session may drive status, and it has to be cleared on load or the
   * stale-session guard rejects the next real session's hooks. This one is
   * only a memory of where the work got to, so it survives a restart. Without
   * it, updating the app threw away every agent's conversation.
   */
  resumableSessionId?: string;
  /** Session id of the most recently killed PTY's claude session. Its hooks
   *  may still be in flight after the kill; any post carrying this id is
   *  stale and must be ignored (tombstone). */
  lastKilledSessionId?: string;
  /** Why the agent is 'waiting': 'permission' = blocking permission dialog
   *  (auto-continue must NOT type into it), 'idle' = waiting for next prompt. */
  waitingReason?: string;
  kanbanTaskId?: string;  // For kanban task completion tracking
  statusLine?: string;       // ANSI-stripped last meaningful output line
  lastCleanOutput?: string;  // Clean text output captured from transcript by hooks
  provider?: AgentProvider;   // 'claude' (default) or 'local' (Tasmania)
  model?: string;              // Model name (e.g. 'sonnet', 'opus', 'haiku'), persisted across restarts
  localModel?: string;        // Tasmania model name when provider is 'local'
  savedPrompt?: string;       // Saved task/prompt for re-launching the agent
  obsidianVaultPaths?: string[]; // Obsidian vault paths to mount via --add-dir (read-only)
  createdAt?: string;         // ISO timestamp when the agent was created
  cliPath?: string;              // Custom CLI binary path override
}

export interface CLIPaths {
  claude: string;
  codex: string;
  gemini: string;
  grok: string;
  qwencode: string;
  opencode: string;
  pi: string;
  gws: string;
  gcloud: string;
  gh: string;
  node: string;
  minimax: string;
  additionalPaths: string[];
}

export interface AppSettings {
  notificationsEnabled: boolean;
  notifyOnWaiting: boolean;
  notifyOnComplete: boolean;
  notifyOnStop: boolean;
  notifyOnError: boolean;
  telegramEnabled: boolean;
  telegramBotToken: string;
  telegramChatId: string; // Legacy - kept for backwards compatibility
  telegramAuthToken: string; // Secret token for authentication
  telegramAuthorizedChatIds: string[]; // List of authorized chat IDs
  telegramRequireMention: boolean; // Only respond when bot is @mentioned in groups
  slackEnabled: boolean;
  slackBotToken: string;
  slackAppToken: string;
  slackSigningSecret: string;
  slackChannelId: string;
  jiraEnabled: boolean;
  jiraDomain: string;
  jiraEmail: string;
  jiraApiToken: string;
  socialDataEnabled: boolean;
  socialDataApiKey: string;
  xPostingEnabled: boolean;
  xApiKey: string;
  xApiSecret: string;
  xAccessToken: string;
  xAccessTokenSecret: string;
  tasmaniaEnabled: boolean;
  tasmaniaServerPath: string;
  gwsEnabled: boolean;
  gwsSkillsInstalled: boolean;
  verboseModeEnabled: boolean;
  chromeEnabled: boolean;
  autoCheckUpdates: boolean;
  /** Resume idle agents once, when the app launches. Not on navigation - that
   *  was the old behaviour and it spawned sessions on every visit home. */
  autoStartAgentsOnLaunch?: boolean;
  cliPaths: CLIPaths;
  opencodeEnabled: boolean;
  opencodeDefaultModel: string;
  /** External AI provider keys. All alt providers use the claude binary
   *  with ANTHROPIC_BASE_URL + ANTHROPIC_API_KEY injected into the PTY. */
  openRouterEnabled?: boolean;
  openRouterApiKey?: string;
  deepSeekEnabled?: boolean;
  deepSeekApiKey?: string;
  mimoEnabled?: boolean;
  mimoApiKey?: string;
  moonshotEnabled?: boolean;
  moonshotApiKey?: string;
  qwenEnabled?: boolean;
  qwenApiKey?: string;
  zhipuEnabled?: boolean;
  zhipuApiKey?: string;
  minimaxEnabled?: boolean;
  minimaxApiKey?: string;
  nvidiaEnabled?: boolean;
  nvidiaApiKey?: string;
  nousPortalEnabled?: boolean;
  nousPortalApiKey?: string;
  /** Venice AI has no Anthropic-compatible endpoint (OpenAI-compatible only), so
   *  it is reached through Tars's own local translation bridge, not directly. */
  veniceEnabled?: boolean;
  veniceApiKey?: string;
  /** Ollama is a local server, not a hosted vendor: no key, just where to find it.
   *  Empty means the default http://localhost:11434. */
  ollamaBaseUrl?: string;
  /** Ollama Cloud is a different product from local Ollama: a hosted vendor at
   *  https://ollama.com with its own key. It speaks the Anthropic wire format
   *  natively (like local Ollama), but wants `Authorization: Bearer`, not
   *  `x-api-key` (ollama/ollama#16922) - a header difference, not a translation
   *  problem, so it is a direct provider like local Ollama, never through the
   *  OpenAI-compatible bridge. See providers/ollama-cloud-provider.ts. */
  ollamaCloudEnabled?: boolean;
  ollamaCloudApiKey?: string;
  /** Any OpenAI-compatible endpoint the user points Tars at directly - the
   *  point of not shipping a named provider for every such vendor. Has no
   *  models.dev catalogue entry (private/self-hosted), so the model is typed
   *  by hand rather than picked from a live list. Reached through the same
   *  translation bridge as Venice; see services/openai-bridge.ts. */
  customOpenAIEnabled?: boolean;
  customOpenAIBaseUrl?: string;
  customOpenAIApiKey?: string;
  customOpenAIModel?: string;
  /** Remote Hermes instance (external scheduler) */
  hermesGatewayUrl?: string;
  hermesGatewayToken?: string;
  /** Shared memory backends: remote MCP servers auto-registered so every
   *  claude-binary agent shares the same brain as Hermes/Cowork. */
  memoryGbrainEnabled?: boolean;
  memoryGbrainMcpUrl?: string;
  memoryGbrainAuthToken?: string;
  memoryHonchoEnabled?: boolean;
  memoryHonchoMcpUrl?: string;
  memoryHonchoApiKey?: string;
  defaultProvider?: AgentProvider;
  obsidianVaultPaths?: string[];
  notificationSounds?: {
    waiting?: string;
    complete?: string;
    stop?: string;
    error?: string;
  };
  terminalFontSize?: number;
  terminalTheme?: 'dark' | 'light';
  statusLineEnabled?: boolean;
  favoriteProjects?: string[];
  hiddenProjects?: string[];
  defaultProjectPath?: string;
  /** Monthly ceiling per provider, in dollars. Set on the Usage page. */
  providerBudgets?: Record<string, number>;
}
