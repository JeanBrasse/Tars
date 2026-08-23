export interface RepoSummary {
  branch: string;
  status: { status: string; file: string }[];
  commits: { hash: string; subject: string; author: string; when: string }[];
  additions: number;
  deletions: number;
}

export interface LogLine {
  agentId: string;
  agentName: string;
  projectPath: string;
  branch?: string;
  status: string;
  line: string;
  position: number;
}

export interface FleetEntry {
  agentId: string;
  agentName: string;
  projectPath: string;
  branch?: string;
  provider?: string;
  status: string;
  lastActivity?: string;
  lines: number;
}

export interface ChangedFile {
  path: string;
  status: 'added' | 'modified' | 'deleted' | 'renamed' | 'untracked';
  additions: number;
  deletions: number;
}

export interface ReviewDiff {
  repo: string;
  branch: string;
  baseBranch: string | null;
  ahead: number;
  behind: number;
  files: ChangedFile[];
  totalAdditions: number;
  totalDeletions: number;
  patch: string;
  truncated: boolean;
}

export interface MemorySourceStatus {
  id: string;
  label: string;
  configured: boolean;
  reachable: boolean;
  detail: string;
  tools?: string[];
}

export interface MemoryHit {
  source: string;
  title: string;
  content: string;
  ref?: string;
}

export interface ModelCost {
  /** USD per million tokens */
  input?: number;
  output?: number;
  cache_read?: number;
  cache_write?: number;
}

export interface CatalogModel {
  id: string;
  name: string;
  contextWindow?: number;
  maxOutput?: number;
  reasoning?: boolean;
  effortValues?: string[];
  cost?: ModelCost;
  releaseDate?: string;
}

export type DisplayStatus = 'working' | 'waiting' | 'done' | 'ready' | 'stopped' | 'error';

export interface AgentTickItem {
  id: string;
  name: string;
  character: string;
  status: 'idle' | 'running' | 'completed' | 'error' | 'waiting';
  displayStatus: DisplayStatus;
  statusLine: string;
  currentTask: string;
  projectName: string;
  lastActivity: string;
  provider: string;
}

export interface AgentEvent {
  type: string;
  agentId: string;
  ptyId?: string;
  data: string;
  timestamp: string;
  exitCode?: number;
}

export interface KanbanTaskElectron {
  id: string;
  title: string;
  description: string;
  column: 'backlog' | 'planned' | 'ongoing' | 'done';
  projectId: string;
  projectPath: string;
  assignedAgentId: string | null;
  requiredSkills: string[];
  priority: 'low' | 'medium' | 'high';
  progress: number;
  createdAt: string;
  updatedAt: string;
  order: number;
  labels: string[];
}

export interface VaultDocumentElectron {
  id: string;
  title: string;
  content: string;
  folder_id: string | null;
  author: string;
  agent_id: string | null;
  tags: string; // JSON array string
  created_at: string;
  updated_at: string;
  snippet?: string; // From FTS search results
}

export interface VaultFolderElectron {
  id: string;
  name: string;
  parent_id: string | null;
  created_at: string;
  updated_at: string;
}

export interface VaultAttachmentElectron {
  id: string;
  document_id: string;
  filename: string;
  filepath: string;
  mimetype: string;
  size: number;
  created_at: string;
}

export interface MemoryFile {
  name: string;
  path: string;
  content: string;
  size: number;
  lastModified: string;
  isEntrypoint: boolean;
}

export interface ProjectMemory {
  id: string;
  projectName: string;
  projectPath: string;
  memoryDir: string;
  files: MemoryFile[];
  totalSize: number;
  lastModified: string;
  hasMemory: boolean;
  provider: string;    // 'claude' | 'codex' | 'gemini'
}

export interface ObsidianFile {
  name: string;
  path: string;
  relativePath: string;
  content: string;
  size: number;
  lastModified: string;
  frontmatter?: Record<string, unknown>;
}

export interface ObsidianFolder {
  name: string;
  path: string;
  relativePath: string;
  children: (ObsidianFolder | { type: 'file'; name: string; relativePath: string })[];
}

export interface ImportPreview {
  name: string;
  description: string;
  width: number;
  height: number;
  npcCount: number;
  buildingCount: number;
  screenshot: string;
}

export interface WorktreeConfig {
  enabled: boolean;
  branchName: string;
}

export type AgentCharacter = 'robot' | 'ninja' | 'wizard' | 'astronaut' | 'knight' | 'pirate' | 'alien' | 'viking' | 'frog';

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
  | 'nous-portal';

export interface AgentStatus {
  id: string;
  status: 'idle' | 'running' | 'completed' | 'error' | 'waiting';
  projectPath: string;
  secondaryProjectPath?: string; // Secondary project added via --add-dir
  worktreePath?: string;
  branchName?: string;
  skills: string[];
  currentTask?: string;
  output: string[];
  lastActivity: string;
  error?: string;
  ptyId?: string;
  character?: AgentCharacter;
  name?: string;
  statusLine?: string;    // ANSI-stripped last meaningful output line
  pathMissing?: boolean; // True if project path no longer exists
  /** @deprecated Use permissionMode instead */
  skipPermissions?: boolean;
  permissionMode?: 'normal' | 'auto' | 'bypass';
  effort?: 'low' | 'medium' | 'high' | 'xhigh' | 'max';
  /** Orchestrator mode: agent cannot edit files directly; must delegate. */
  orchestratorMode?: boolean;
  provider?: AgentProvider;   // 'claude' (default) or 'local' (Tasmania)
  model?: string;              // Model name (e.g. 'sonnet', 'opus', 'haiku')
  localModel?: string;        // Tasmania model name when provider is 'local'
  savedPrompt?: string;       // Saved task/prompt for re-launching the agent
  obsidianVaultPaths?: string[]; // Obsidian vault paths to mount via --add-dir (read-only)
  createdAt?: string;         // ISO timestamp when the agent was created
  cliPath?: string;              // Custom CLI binary path override
}

export interface AgentTemplate {
  id: string;
  builtin: boolean;
  /** True if this built-in has been customized by the user. */
  overridden?: boolean;
  displayName: string;
  description: string;
  icon: string;
  tags: string[];
  character: AgentCharacter;
  provider: AgentProvider;
  model?: string;
  localModel?: string;
  permissionMode: 'normal' | 'auto' | 'bypass';
  effort?: 'low' | 'medium' | 'high' | 'xhigh' | 'max';
  skills: string[];
  obsidianVaultPaths?: string[];
  savedPrompt?: string;
  createdAt: string;
  updatedAt: string;
}

export interface AgentTemplateInput {
  displayName: string;
  description?: string;
  icon?: string;
  tags?: string[];
  character?: AgentCharacter;
  provider?: AgentProvider;
  model?: string;
  localModel?: string;
  permissionMode?: 'normal' | 'auto' | 'bypass';
  effort?: 'low' | 'medium' | 'high' | 'xhigh' | 'max';
  skills?: string[];
  obsidianVaultPaths?: string[];
  savedPrompt?: string;
}

export interface AgentTemplatePatch extends Partial<AgentTemplateInput> {
  id: string;
}

export interface TemplateExport {
  version: number;
  kind: 'tars.agent-template';
  exportedAt: string;
  templates: AgentTemplateInput[];
}

/** One agent slot in a team. Deploying a team creates one agent per member. */
export type HermesMode = 'local' | 'ssh' | 'remote' | 'cloud';
export type HermesAuthMode = 'token' | 'oauth';

export interface HermesSshConfig {
  host: string;
  user: string;
  port?: number;
  keyPath?: string;
  remotePort?: number;
  localPort?: number;
}

export interface HermesConnection {
  mode: HermesMode;
  localPort?: number;
  ssh?: HermesSshConfig;
  url?: string;
  authMode?: HermesAuthMode;
  token?: string;
  org?: string;
}

export interface TeamTemplateMember {
  name: string;
  character: AgentCharacter;
  provider: AgentProvider;
  model?: string;
  localModel?: string;
  permissionMode: 'normal' | 'auto' | 'bypass';
  effort?: 'low' | 'medium' | 'high' | 'xhigh' | 'max';
  skills: string[];
  savedPrompt?: string;
  worktreeBranch?: string;
  orchestratorMode?: boolean;
}

export interface TeamTemplate {
  id: string;
  builtin: boolean;
  name: string;
  description: string;
  icon: string;
  members: TeamTemplateMember[];
  createdAt: string;
  updatedAt: string;
}

export interface TeamTemplateInput {
  name: string;
  description?: string;
  icon?: string;
  members: Partial<TeamTemplateMember>[];
}

export interface PtyDataEvent {
  id: string;
  data: string;
}

export interface PtyExitEvent {
  id: string;
  exitCode: number;
}

export interface SkillInstallOutputEvent {
  repo: string;
  data: string;
}

export interface ElectronAPI {
  // PTY terminal management
  pty: {
    create: (params: { cwd?: string; cols?: number; rows?: number }) => Promise<{ id: string }>;
    write: (params: { id: string; data: string }) => Promise<{ success: boolean }>;
    resize: (params: { id: string; cols: number; rows: number }) => Promise<{ success: boolean }>;
    kill: (params: { id: string }) => Promise<{ success: boolean }>;
    onData: (callback: (event: PtyDataEvent) => void) => () => void;
    onExit: (callback: (event: PtyExitEvent) => void) => () => void;
  };

  // Agent management
  agent: {
    create: (config: {
      projectPath: string;
      skills: string[];
      worktree?: WorktreeConfig;
      character?: AgentCharacter;
      name?: string;
      secondaryProjectPath?: string;
      permissionMode?: 'normal' | 'auto' | 'bypass';
      effort?: 'low' | 'medium' | 'high' | 'xhigh' | 'max';
      provider?: AgentProvider;
      localModel?: string;
      obsidianVaultPaths?: string[];
      orchestratorMode?: boolean;
    }) => Promise<AgentStatus & { ptyId: string }>;
    update: (params: {
      id: string;
      projectPath?: string;
      skills?: string[];
      secondaryProjectPath?: string | null;
      permissionMode?: 'normal' | 'auto' | 'bypass';
      effort?: 'low' | 'medium' | 'high' | 'xhigh' | 'max';
      name?: string;
      character?: AgentCharacter;
      model?: string | null;
      provider?: AgentProvider;
      localModel?: string | null;
      savedPrompt?: string | null;
      obsidianVaultPaths?: string[];
      worktree?: WorktreeConfig;
      orchestratorMode?: boolean;
      cliPath?: string | null;
    }) => Promise<{ success: boolean; error?: string; agent?: AgentStatus }>;
    start: (params: { id: string; prompt: string; options?: { model?: string; resume?: boolean; provider?: AgentProvider; localModel?: string } }) => Promise<{ success: boolean }>;
    get: (id: string) => Promise<AgentStatus | null>;
    list: () => Promise<AgentStatus[]>;
    stop: (id: string) => Promise<{ success: boolean }>;
    remove: (id: string) => Promise<{ success: boolean }>;
    sendInput: (params: { id: string; input: string }) => Promise<{ success: boolean }>;
    resize: (params: { id: string; cols: number; rows: number }) => Promise<{ success: boolean }>;
    setSecondaryProject: (params: { id: string; secondaryProjectPath: string | null }) => Promise<{ success: boolean; error?: string; agent?: AgentStatus }>;
    onOutput: (callback: (event: AgentEvent) => void) => () => void;
    onError: (callback: (event: AgentEvent) => void) => () => void;
    onComplete: (callback: (event: AgentEvent) => void) => () => void;
    onToolUse: (callback: (event: AgentEvent) => void) => () => void;
    onStatus?: (callback: (event: { type: string; agentId: string; status: string; timestamp: string }) => void) => () => void;
    onTick?: (callback: (agents: AgentTickItem[]) => void) => () => void;
  };

  // Skills management
  skill: {
    install: (repo: string) => Promise<{ success: boolean; output?: string; message?: string }>;
    installStart: (params: { repo: string; cols?: number; rows?: number }) => Promise<{ id: string; repo: string }>;
    installWrite: (params: { id: string; data: string }) => Promise<{ success: boolean }>;
    installResize: (params: { id: string; cols: number; rows: number }) => Promise<{ success: boolean }>;
    installKill: (params: { id: string }) => Promise<{ success: boolean }>;
    listInstalled: () => Promise<string[]>;
    listInstalledAll: () => Promise<Record<string, string[]>>;
    linkToProvider: (params: { skillName: string; providerId: string }) => Promise<{ success: boolean; error?: string }>;
    fetchMarketplace: () => Promise<{ skills: Array<{ rank: number; name: string; repo: string; installs: string; installsNum: number }> | null }>;
    onPtyData: (callback: (event: { id: string; data: string }) => void) => () => void;
    onPtyExit: (callback: (event: { id: string; exitCode: number }) => void) => () => void;
    onInstallOutput: (callback: (event: SkillInstallOutputEvent) => void) => () => void;
  };

  // Plugin management (with in-app terminal)
  plugin?: {
    installStart: (params: { command: string; cols?: number; rows?: number }) => Promise<{ id: string; command: string }>;
    installWrite: (params: { id: string; data: string }) => Promise<{ success: boolean }>;
    installResize: (params: { id: string; cols: number; rows: number }) => Promise<{ success: boolean }>;
    installKill: (params: { id: string }) => Promise<{ success: boolean }>;
    onPtyData: (callback: (event: { id: string; data: string }) => void) => () => void;
    onPtyExit: (callback: (event: { id: string; exitCode: number }) => void) => () => void;
  };

  // File system
  fs: {
    listProjects: () => Promise<{ path: string; name: string; lastModified?: string; custom?: boolean }[]>;
    readTextFile: (filePath: string) => Promise<{ content: string; error?: string }>;
    writeTextFile: (params: { filePath: string; content: string }) => Promise<{ success: boolean; error?: string }>;
    readProjectFiles: (params: { paths: string[]; relative: string[] }) => Promise<{ files: Record<string, string> }>;
    addCustomProject: (projectPath: string) => Promise<{ success: boolean; projects?: string[]; error?: string }>;
    removeCustomProject: (projectPath: string) => Promise<{ success: boolean; projects?: string[]; error?: string }>;
  };

  // Claude data
  claude: {
    getData: () => Promise<{
      settings: unknown;
      stats: unknown;
      projects: unknown[];
      plugins: unknown[];
      skills: Array<{ name: string; source: 'project' | 'user' | 'plugin'; path: string; description?: string; projectName?: string }>;
      history: Array<{ display: string; timestamp: number; project?: string }>;
      activeSessions: string[];
      rateLimits: {
        five_hour?: { used_percentage: number; resets_at: number };
        seven_day?: { used_percentage: number; resets_at: number };
      } | null;
      tokenStats: {
        totalInputTokens: number;
        totalOutputTokens: number;
        totalCostUsd: number;
        extraCostUsd: number;
        sessionCount: number;
        modelTokens?: Record<string, { in: number; out: number }>;
        dailyCosts?: Record<string, { cost: number; extraCost: number }>;
      } | null;
    } | null>;
  };

  // Settings
  settings: {
    get: () => Promise<{
      enabledPlugins: Record<string, boolean>;
      env: Record<string, string>;
      hooks: Record<string, unknown>;
      includeCoAuthoredBy: boolean;
      permissions: { allow: string[]; deny: string[] };
    } | null>;
    save: (settings: {
      enabledPlugins?: Record<string, boolean>;
      env?: Record<string, string>;
      hooks?: Record<string, unknown>;
      includeCoAuthoredBy?: boolean;
      permissions?: { allow: string[]; deny: string[] };
    }) => Promise<{ success: boolean; error?: string }>;
    getInfo: () => Promise<{
      claudeVersion: string;
      configPath: string;
      settingsPath: string;
      platform: string;
      arch: string;
      nodeVersion: string;
      electronVersion: string;
    } | null>;
  };

  // App settings (notifications, etc.)
  app?: {
    getVersion: () => Promise<{ version: string }>;
  };

  /** Per-provider spend, merged from transcripts and reported turns. */
  usage?: {
    byProvider: (sinceDays?: number) => Promise<{
      providers: Array<{
        provider: string;
        inputTokens: number;
        outputTokens: number;
        costUSD: number;
        turns: number;
        models: string[];
        measured: boolean;
      }>;
      dailyCost: Record<string, number>;
    }>;
  };

  /** Search across every agent's output at once. */
  logs?: {
    search: (query: string, opts?: { agentIds?: string[]; projectPath?: string; limit?: number }) =>
      Promise<{ lines: LogLine[]; scannedAgents: number; truncated: boolean }>;
    tail: (agentId: string, lines?: number) => Promise<{ lines: string[]; agentName: string }>;
    fleet: () => Promise<{ agents: FleetEntry[] }>;
  };

  /** Browsing a project without a shell: walked and read directly. */
  project?: {
    listFiles: (root: string, maxDepth?: number) =>
      Promise<{ success: boolean; files?: string[]; error?: string }>;
    searchFiles: (root: string, query: string) =>
      Promise<{ success: boolean; files?: string[]; error?: string }>;
    searchContent: (root: string, query: string) =>
      Promise<{ success: boolean; hits?: { path: string; line: number; text: string }[]; error?: string }>;
  };

  /** What an agent changed: per-file stats plus the actual patch. */
  review?: {
    diff: (repoPath: string, baseBranch?: string) =>
      Promise<{ success: boolean; diff?: ReviewDiff; error?: string }>;
    file: (repoPath: string, file: string, baseBranch?: string) =>
      Promise<{ success: boolean; patch?: string; error?: string }>;
    repo: (repoPath: string) => Promise<{ success: boolean; summary?: RepoSummary; error?: string }>;
  };

  /** Federated memory: every source probed for real, searchable from one place. */
  memoryHub?: {
    sources: (projectPath?: string) => Promise<{ sources: MemorySourceStatus[] }>;
    search: (
      query: string,
      opts?: { projectPath?: string; sources?: string[]; limit?: number },
    ) => Promise<{ hits: MemoryHit[]; errors: { source: string; error: string }[] }>;
  };

  /** Live model + price catalogue, refreshed from models.dev. */
  models?: {
    list: (provider: string) => Promise<{ models: CatalogModel[] }>;
    price: (modelId: string, provider?: string) => Promise<{ price: ModelCost | null }>;
    catalogStatus: () => Promise<{ loaded: boolean; fetchedAt: number | null; providers: number; models: number }>;
    refresh: () => Promise<{ loaded: boolean; fetchedAt: number | null; providers: number; models: number }>;
  };

  appSettings?: {
    get: () => Promise<{
      notificationsEnabled: boolean;
      notifyOnWaiting: boolean;
      notifyOnComplete: boolean;
      notifyOnStop: boolean;
      notifyOnError: boolean;
      telegramEnabled: boolean;
      telegramBotToken: string;
      telegramChatId: string;
      telegramAuthToken: string;
      telegramAuthorizedChatIds: string[];
      telegramRequireMention: boolean;
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
      tasmaniaEnabled: boolean;
      tasmaniaServerPath: string;
      defaultProvider?: string;
      opencodeEnabled?: boolean;
      opencodeDefaultModel?: string;
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
      notificationSounds?: {
        waiting?: string;
        complete?: string;
        stop?: string;
        error?: string;
      };
      terminalFontSize?: number;
      /** Resume idle agents once at launch (not on navigation). */
      autoStartAgentsOnLaunch?: boolean;
      terminalTheme?: 'dark' | 'light';
      statusLineEnabled?: boolean;
      hermesGatewayUrl?: string;
      hermesGatewayToken?: string;
      memoryGbrainEnabled?: boolean;
      memoryGbrainMcpUrl?: string;
      memoryGbrainAuthToken?: string;
      memoryHonchoEnabled?: boolean;
      memoryHonchoMcpUrl?: string;
      memoryHonchoApiKey?: string;
      favoriteProjects?: string[];
      hiddenProjects?: string[];
      defaultProjectPath?: string;
      cliPaths?: {
        claude: string;
        codex: string;
        gemini: string;
        grok: string;
        opencode: string;
        pi: string;
        gws: string;
        gcloud: string;
        gh: string;
        node: string;
        minimax: string;
        additionalPaths: string[];
      };
    }>;
    save: (settings: {
      notificationsEnabled?: boolean;
      notifyOnWaiting?: boolean;
      notifyOnComplete?: boolean;
      notifyOnStop?: boolean;
      notifyOnError?: boolean;
      telegramEnabled?: boolean;
      telegramBotToken?: string;
      telegramChatId?: string;
      telegramAuthToken?: string;
      telegramAuthorizedChatIds?: string[];
      telegramRequireMention?: boolean;
      slackEnabled?: boolean;
      slackBotToken?: string;
      slackAppToken?: string;
      slackSigningSecret?: string;
      slackChannelId?: string;
      jiraEnabled?: boolean;
      jiraDomain?: string;
      jiraEmail?: string;
      jiraApiToken?: string;
      socialDataEnabled?: boolean;
      socialDataApiKey?: string;
      tasmaniaEnabled?: boolean;
      tasmaniaServerPath?: string;
      defaultProvider?: string;
      notificationSounds?: {
        waiting?: string;
        complete?: string;
        stop?: string;
        error?: string;
      };
      terminalFontSize?: number;
      /** Resume idle agents once at launch (not on navigation). */
      autoStartAgentsOnLaunch?: boolean;
      terminalTheme?: 'dark' | 'light';
      statusLineEnabled?: boolean;
      hermesGatewayUrl?: string;
      hermesGatewayToken?: string;
      memoryGbrainEnabled?: boolean;
      memoryGbrainMcpUrl?: string;
      memoryGbrainAuthToken?: string;
      memoryHonchoEnabled?: boolean;
      memoryHonchoMcpUrl?: string;
      memoryHonchoApiKey?: string;
      favoriteProjects?: string[];
      hiddenProjects?: string[];
      defaultProjectPath?: string;
      cliPaths?: {
        claude: string;
        codex: string;
        gemini: string;
        grok: string;
        opencode: string;
        pi: string;
        gws: string;
        gcloud: string;
        gh: string;
        node: string;
        minimax: string;
        additionalPaths: string[];
      };
    }) => Promise<{ success: boolean; error?: string }>;
    onUpdated?: (callback: (settings: unknown) => void) => () => void;
  };

  // Telegram bot
  telegram?: {
    test: () => Promise<{ success: boolean; botName?: string; error?: string }>;
    sendTest: () => Promise<{ success: boolean; error?: string }>;
    generateAuthToken: () => Promise<{ success: boolean; token?: string; error?: string }>;
    removeAuthorizedChatId: (chatId: string) => Promise<{ success: boolean; error?: string }>;
  };

  // Slack bot
  slack?: {
    test: () => Promise<{ success: boolean; botName?: string; error?: string }>;
    sendTest: () => Promise<{ success: boolean; error?: string }>;
  };

  // JIRA
  jira?: {
    test: () => Promise<{ success: boolean; displayName?: string; email?: string; error?: string }>;
  };

  // SocialData (Twitter/X)
  socialData?: {
    test: () => Promise<{ success: boolean; error?: string }>;
  };

  // X API (posting)
  xApi?: {
    test: () => Promise<{ success: boolean; username?: string; error?: string }>;
  };

  // Google Workspace (gws CLI)
  gws?: {
    detect: () => Promise<string>;
    detectGcloud: () => Promise<string>;
    authStatus: () => Promise<{
      authenticated: boolean;
      user: string | null;
      tokenValid: boolean;
      scopes: string[];
      authMethod: string;
      services: Record<string, 'none' | 'read' | 'write'>;
    }>;
    setup: () => Promise<{ success: boolean; error?: string }>;
    remove: () => Promise<{ success: boolean; error?: string }>;
    getMcpStatus: () => Promise<{ configured: boolean; error?: string }>;
    listSkills: () => Promise<string[]>;
  };

  // Tasmania (Local LLM)
  tasmania?: {
    test: () => Promise<{ success: boolean; serverExists: boolean; apiReachable: boolean; error?: string }>;
    getStatus: () => Promise<{
      status: 'stopped' | 'starting' | 'running' | 'error';
      backend: string | null;
      port: number | null;
      modelName: string | null;
      modelPath: string | null;
      endpoint: string | null;
      startedAt: number | null;
      error?: string;
    }>;
    getModels: () => Promise<{
      models: Array<{
        name: string;
        filename: string;
        path: string;
        sizeBytes: number;
        repo: string | null;
        quantization: string | null;
        parameters: string | null;
        architecture: string | null;
      }>;
      error?: string;
    }>;
    loadModel: (modelPath: string) => Promise<{ success: boolean; error?: string }>;
    stopModel: () => Promise<{ success: boolean; error?: string }>;
    getMcpStatus: () => Promise<{ configured: boolean; error?: string }>;
    setup: () => Promise<{ success: boolean; error?: string }>;
    remove: () => Promise<{ success: boolean; error?: string }>;
  };

  // Dialogs
  dialog: {
    openFolder: () => Promise<string | null>;
    openFiles: () => Promise<string[]>;
    openAudio: () => Promise<string | null>;
  };

  // Shell operations
  shell: {
    /**
     * Open Terminal.app in a directory.
     *
     * No `command`: the handler used to paste one into an AppleScript literal
     * and run it, and nothing supplied it. Declaring the parameter here is what
     * kept the dead call sites type-checking, so the signature stays as narrow
     * as the channel.
     */
    openTerminal: (params: { cwd: string }) => Promise<{ success: boolean; error?: string }>;
    /** A CLI's --version, run through execFile with an argv array. */
    version: (binary: string) => Promise<{ success: boolean; output?: string; error?: string }>;
    /** The current branch of a repository. */
    branch: (cwd: string) => Promise<{ success: boolean; output?: string; error?: string }>;
    /** Reveal a path in Finder, through Electron's own shell API. */
    reveal: (path: string) => Promise<{ success: boolean; error?: string }>;
    // Quick terminal PTY
    startPty?: (params: { cwd?: string; cols?: number; rows?: number }) => Promise<string>;
    writePty?: (params: { ptyId: string; data: string }) => Promise<{ success: boolean }>;
    resizePty?: (params: { ptyId: string; cols: number; rows: number }) => Promise<{ success: boolean }>;
    killPty?: (params: { ptyId: string }) => Promise<{ success: boolean }>;
    onPtyOutput?: (callback: (event: { ptyId: string; data: string }) => void) => () => void;
    onPtyExit?: (callback: (event: { ptyId: string; exitCode: number }) => void) => () => void;
  };

  // Orchestrator (Super Agent) management
  orchestrator?: {
    getStatus: () => Promise<{
      configured: boolean;
      orchestratorPath?: string;
      orchestratorExists?: boolean;
      currentConfig?: unknown;
      reason?: string;
      error?: string;
    }>;
    setup: () => Promise<{
      success: boolean;
      path?: string;
      error?: string;
    }>;
    remove: () => Promise<{
      success: boolean;
      error?: string;
    }>;
  };

  // Custom MCP server config
  mcp?: {
    list: (params: { provider: string }) => Promise<{
      servers: Array<{ name: string; command: string; args: string[]; env: Record<string, string> }>;
      error?: string;
    }>;
    update: (params: {
      provider: string;
      name: string;
      command: string;
      args: string[];
      env: Record<string, string>;
    }) => Promise<{ success: boolean; error?: string }>;
    delete: (params: { provider: string; name: string }) => Promise<{ success: boolean; error?: string }>;
  };

  // CLI paths management
  cliPaths?: {
    detect: () => Promise<{
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
    }>;
    get: () => Promise<{
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
    }>;
    save: (paths: {
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
    }) => Promise<{ success: boolean; error?: string }>;
  };

  // Vault
  vault?: {
    listDocuments: (params?: { folder_id?: string; tags?: string[] }) => Promise<{ documents: VaultDocumentElectron[]; error?: string }>;
    getDocument: (id: string) => Promise<{ document?: VaultDocumentElectron; attachments?: VaultAttachmentElectron[]; error?: string }>;
    createDocument: (params: {
      title: string;
      content: string;
      folder_id?: string;
      author: string;
      agent_id?: string;
      tags?: string[];
    }) => Promise<{ success: boolean; document?: VaultDocumentElectron; error?: string }>;
    updateDocument: (params: {
      id: string;
      title?: string;
      content?: string;
      tags?: string[];
      folder_id?: string | null;
    }) => Promise<{ success: boolean; document?: VaultDocumentElectron; error?: string }>;
    deleteDocument: (id: string) => Promise<{ success: boolean; error?: string }>;
    search: (params: { query: string; limit?: number }) => Promise<{ results: VaultDocumentElectron[]; error?: string }>;
    listFolders: () => Promise<{ folders: VaultFolderElectron[]; error?: string }>;
    createFolder: (params: { name: string; parent_id?: string }) => Promise<{ success: boolean; folder?: VaultFolderElectron; error?: string }>;
    deleteFolder: (params: { id: string; recursive?: boolean }) => Promise<{ success: boolean; error?: string }>;
    attachFile: (params: { document_id: string; file_path: string }) => Promise<{ success: boolean; attachment?: VaultAttachmentElectron; error?: string }>;
    onDocumentCreated: (callback: (doc: VaultDocumentElectron) => void) => () => void;
    onDocumentUpdated: (callback: (doc: VaultDocumentElectron) => void) => () => void;
    onDocumentDeleted: (callback: (event: { id: string }) => void) => () => void;
  };

  // Kanban board
  kanban?: {
    list: () => Promise<{ tasks: KanbanTaskElectron[]; error?: string }>;
    get: (id: string) => Promise<{ success: boolean; task?: KanbanTaskElectron; error?: string }>;
    create: (params: {
      title: string;
      description: string;
      projectId: string;
      projectPath: string;
      requiredSkills?: string[];
      priority?: 'low' | 'medium' | 'high';
      labels?: string[];
    }) => Promise<{ success: boolean; task?: KanbanTaskElectron; error?: string }>;
    update: (params: {
      id: string;
      title?: string;
      description?: string;
      requiredSkills?: string[];
      priority?: 'low' | 'medium' | 'high';
      labels?: string[];
      progress?: number;
      assignedAgentId?: string | null;
    }) => Promise<{ success: boolean; task?: KanbanTaskElectron; error?: string }>;
    move: (params: {
      id: string;
      column: 'backlog' | 'planned' | 'ongoing' | 'done';
      order?: number;
    }) => Promise<{
      success: boolean;
      task?: KanbanTaskElectron;
      agentSpawned?: boolean;
      agentId?: string;
      error?: string;
    }>;
    delete: (id: string) => Promise<{ success: boolean; error?: string }>;
    reorder: (params: {
      taskIds: string[];
      column: 'backlog' | 'planned' | 'ongoing' | 'done';
    }) => Promise<{ success: boolean; error?: string }>;
    generate: (params: {
      prompt: string;
      availableProjects: Array<{ path: string; name: string }>;
    }) => Promise<{
      success: boolean;
      task?: {
        title: string;
        description: string;
        projectPath: string;
        projectId: string;
        priority: 'low' | 'medium' | 'high';
        labels: string[];
        requiredSkills: string[];
      };
      error?: string;
    }>;
    onTaskCreated: (callback: (task: KanbanTaskElectron) => void) => () => void;
    onTaskUpdated: (callback: (task: KanbanTaskElectron) => void) => () => void;
    onTaskDeleted: (callback: (event: { id: string }) => void) => () => void;
  };

  // Agent templates
  template?: {
    list: () => Promise<{ templates: AgentTemplate[]; error?: string }>;
    get: (id: string) => Promise<{ template: AgentTemplate | null }>;
    create: (input: AgentTemplateInput) => Promise<{ success: boolean; template?: AgentTemplate; error?: string }>;
    update: (patch: AgentTemplatePatch) => Promise<{ success: boolean; template?: AgentTemplate; error?: string }>;
    delete: (id: string) => Promise<{ success: boolean; error?: string }>;
    duplicate: (id: string) => Promise<{ success: boolean; template?: AgentTemplate; error?: string }>;
    export: (ids: string[]) => Promise<{ success: boolean; payload?: TemplateExport; error?: string }>;
    import: (payload: unknown) => Promise<{ success: boolean; imported?: number; skipped?: number; errors?: string[]; templates?: AgentTemplate[]; error?: string }>;
  };

  // Hermes integration (remote scheduler wiring)
  hermes?: {
    getConnection: () => Promise<{ connection: HermesConnection; baseUrl: string; desktopConfigAvailable: boolean }>;
    saveConnection: (connection: HermesConnection) => Promise<{ success: boolean; error?: string }>;
    importDesktopConnection: () => Promise<{ success: boolean; connection?: HermesConnection; baseUrl?: string; error?: string }>;
    testConnection: (connection: HermesConnection) => Promise<{
      success: boolean;
      baseUrl?: string;
      status?: number;
      version?: string;
      gatewayState?: string;
      authRequired?: boolean;
      authFlows?: string[];
      authProviders?: string[];
      needsSignIn?: boolean;
      signedIn?: boolean;
      error?: string;
    }>;
    signIn: (params: { connection: HermesConnection; username: string; password: string; provider?: string }) => Promise<{ success: boolean; version?: string; gatewayState?: string; error?: string }>;
    signOut: (connection: HermesConnection) => Promise<{ success: boolean }>;
    crons: () => Promise<{ success: boolean; jobs?: unknown; error?: string; needsSignIn?: boolean }>;
    cronAction: (params: { action: 'pause' | 'resume' | 'trigger'; jobId: string; profile?: string }) => Promise<{ success: boolean; job?: unknown; error?: string }>;
    cronUpdate: (params: { jobId: string; updates: Record<string, unknown>; profile?: string }) => Promise<{ success: boolean; job?: unknown; error?: string; needsSignIn?: boolean }>;
    cronDelete: (params: { jobId: string; profile?: string }) => Promise<{ success: boolean; error?: string }>;
    kanbanBoard: (params?: { board?: string }) => Promise<{ success: boolean; board?: unknown; error?: string; needsSignIn?: boolean }>;
    kanbanCreateTask: (task: Record<string, unknown>) => Promise<{ success: boolean; task?: unknown; error?: string }>;
    kanbanUpdateTask: (params: { taskId: string; patch: Record<string, unknown> }) => Promise<{ success: boolean; task?: unknown; error?: string }>;
    getConnectionInfo: () => Promise<{
      apiPort: number;
      webhookPath: string;
      webhookLocalUrl: string;
      webhookTailnetUrl?: string;
      apiToken: string;
      tailscale: { installed: boolean; running: boolean; dnsName?: string; ip?: string; serveConfigured: boolean };
      serveCommand: string;
    }>;
    testWebhook: (params: { agentName?: string; agentId?: string; projectPath?: string }) => Promise<{ success: boolean; status?: number; response?: unknown; error?: string }>;
    testGateway: (url: string) => Promise<{ success: boolean; status?: number; error?: string }>;
  };

  // Team templates (sets of agents deployed onto a project in one click)
  teamTemplate?: {
    list: () => Promise<{ teams: TeamTemplate[]; error?: string }>;
    create: (input: TeamTemplateInput) => Promise<{ success: boolean; team?: TeamTemplate; error?: string }>;
    delete: (id: string) => Promise<{ success: boolean; error?: string }>;
  };

  // Updates
  updates?: {
    check: () => Promise<{ devMode?: boolean; error?: boolean; fallback?: boolean; currentVersion?: string } | null>;
    download: () => Promise<unknown>;
    quitAndInstall: () => Promise<void>;
    openExternal: (url: string) => Promise<{ success: boolean }>;
    onUpdateAvailable: (callback: (info: {
      currentVersion: string;
      latestVersion: string;
      releaseNotes: string;
      hasUpdate: boolean;
      downloadUrl?: string;
      releaseUrl?: string;
    }) => void) => () => void;
    onUpdateNotAvailable: (callback: (info: {
      currentVersion: string;
      latestVersion: string;
    }) => void) => () => void;
    onDownloadProgress: (callback: (progress: {
      percent: number;
      bytesPerSecond: number;
      transferred: number;
      total: number;
    }) => void) => () => void;
    onUpdateDownloaded: (callback: () => void) => () => void;
    onUpdateError: (callback: (error: string) => void) => () => void;
  };

  // Obsidian vault browsing & editing
  obsidian?: {
    scan: () => Promise<{
      vaults: Array<{
        vaultPath: string;
        name: string;
        files: (Omit<ObsidianFile, 'content'> & { preview?: string })[];
        tree: ObsidianFolder;
      }>;
    }>;
    readFile: (filePath: string, vaultPath: string) => Promise<{ file?: ObsidianFile; error?: string }>;
    writeFile: (filePath: string, content: string, vaultPath: string) => Promise<{ success?: boolean; error?: string }>;
    getVaultInfo: () => Promise<{ configured: boolean; vaultPaths: string[] }>;
    detectVault: (projectPath: string) => Promise<{ detected: boolean; vaultPath: string | null }>;
    addVault: (vaultPath: string) => Promise<{ success: boolean; error?: string }>;
    removeVault: (vaultPath: string) => Promise<{ success: boolean; error?: string }>;
  };

  // Native Claude memory (reads ~/.claude/projects/*/memory/)
  memory?: {
    listProjects: (extraProjectPaths?: string[]) => Promise<{ projects: ProjectMemory[]; error: string | null }>;
    readFile: (filePath: string) => Promise<{ content: string; error?: string }>;
    writeFile: (filePath: string, content: string) => Promise<{ success: boolean; error?: string }>;
    createFile: (memoryDir: string, fileName: string, content?: string) => Promise<{ success: boolean; file?: MemoryFile; error?: string }>;
    deleteFile: (filePath: string) => Promise<{ success: boolean; error?: string }>;
  };

  // API
  api?: {
    getToken: () => Promise<string>;
  };

  // Tray menu events
  tray?: {
    onFocusAgent: (callback: (agentId: string) => void) => () => void;
    showMainWindow: () => Promise<{ success: boolean }>;
    quit: () => Promise<{ success: boolean }>;
  };

  // Get home path helper
  getHomePath?: () => string;

  // Platform info
  platform: string;
}

declare global {
  interface Window {
    electronAPI?: ElectronAPI;
  }
}

export {};
