export interface WorktreeConfig {
  enabled: boolean;
  branchName: string;
}

export type AgentCharacter = 'robot' | 'ninja' | 'wizard' | 'astronaut' | 'knight' | 'pirate' | 'alien' | 'viking';

export type AgentProvider =
  | 'amp'
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
  /** True while a program, the CLI above all, runs in the agent's PTY rather
   *  than its shell (cliRunningIn in core/agent-pty.ts). Never stored: set on
   *  the copies sent to the renderer by agent:list, agent:get and agents:tick. */
  cliRunning?: boolean;
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
  /**
   * The agent that asked for this one's current work, from the
   * X-Tars-Caller-Id header the MCP client sends on every call.
   *
   * Bound to the PTY it was recorded against, and not merely to the agent,
   * because clearing it correctly cannot be left to a list of callers. There
   * are three separate places that spawn a session (initAgentPty,
   * spawnAgentSession, and the local-provider path in ipc-handlers), the
   * interface reaches none of them through the API, and a fourth can be added
   * tomorrow. Every one of them assigns a fresh `ptyId`, so a link whose
   * `ptyId` is not the live one is simply not this session's link and is
   * ignored. Nothing has to remember to clear it.
   *
   * It is also consumed once delivered, so it can never speak for a later
   * piece of work. Read by services/agent-watch.ts.
   */
  requestedBy?: { agentId: string; ptyId: string };
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
  /**
   * When the current session last began a turn, from the UserPromptSubmit hook.
   *
   * Distinct from `currentSessionId`, which only says that a session registered.
   * A session that never received its task registers in exactly the same way,
   * which is what made a lost dispatch look like an agent at work.
   */
  lastTurnStartedAt?: string;
  /** When a session last claimed this agent through the SessionStart hook.
   *  The task-start watch reads this to ask "has a session registered since I
   *  armed", which it used to ask by emptying `currentSessionId` and seeing
   *  whether anything filled it back in. */
  sessionRegisteredAt?: string;
  /** Which pty that session claimed the agent from. It is how "the session
   *  that owns this agent is still alive" can be told from "this id is left
   *  over from a session that died with an older pty", which look identical
   *  on the agent otherwise. */
  sessionPtyId?: string;
  /**
   * A task handed to a session that has not started a turn yet, cleared the
   * moment one starts. If none does within the bound, the task is typed into
   * the live session once and the agent is marked failed if that fails too.
   * Runtime state: reset on load, like ptyId.
   */
  pendingDelivery?: { ptyId: string; task: string; dispatchedAt: string; retried?: boolean; checkArmed?: boolean };
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

/**
 * Every binary Tars locates for the user, and whose directory goes on the PATH
 * of an agent's PTY.
 *
 * A runtime list and not only an interface, because four places in the main
 * process walked these keys and each carried its own copy of them. They had
 * already drifted: one forgot opencode and pi, two forgot grok and minimax,
 * and the preload's save signature forgot grok before Amp was ever added. Each
 * was silent, and each grew by one more omission per provider.
 *
 * This is deliberately NOT derived from the provider registry. It is a superset
 * of it: gh, node, gws and gcloud are tools an agent needs on its PATH and are
 * nobody's provider, while qwencode and minimax are path keys whose providers
 * run the claude binary under another name. Deriving from getAllProviders would
 * have quietly dropped four working entries.
 */
export const CLI_PATH_KEYS = [
  'amp',
  'claude',
  'codex',
  'gemini',
  'grok',
  'qwencode',
  'opencode',
  'pi',
  'gws',
  'gcloud',
  'gh',
  'node',
  'minimax',
] as const;

export type CLIPathKey = typeof CLI_PATH_KEYS[number];

export type CLIPaths = Record<CLIPathKey, string> & {
  /** Extra directories the user added by hand, already directories not files. */
  additionalPaths: string[];
};

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
  ampEnabled?: boolean;
  ampDefaultModel?: string;
  /** Amp access token (sgamp_...), passed to the PTY as AMP_API_KEY. */
  ampApiKey?: string;
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
  /**
   * Sent as the X-Honcho-Workspace-ID header on every Honcho call.
   *
   * Not a nicety: none of Honcho's tools declares workspace_id as required
   * in its schema, so an agent reads it as optional and omits it, and the
   * server then refuses the call at execution time. list_workspaces, the
   * one way out, answers 502. The header is the only clean way to bind a
   * workspace, and the server's own error message asks for it by name.
   *
   * Empty means no header, which is exactly today's behaviour.
   */
  memoryHonchoWorkspaceId?: string;
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

/* ── The agent bus ─────────────────────────────────────────────────────────
 * The shared contract, read by the Backend that implements it, the Frontend
 * that builds the Chat page on it and the QA that tests it. A room holds
 * threads, a thread anchors messages, and a delivery is the only thing the
 * interface may show as proof that a message reached an agent.
 */

/** `global` is today's super chat, watching every project; `project` is one
 *  room per project, whose members are that project's agents. */
export type BusRoomKind = 'global' | 'project';

export interface BusRoom {
  /** `global`, or `project:<project path>`. */
  id: string;
  kind: BusRoomKind;
  projectPath?: string;
  title: string;
  memberIds: string[];
  createdAt: string;
  /** The newest message in this room, for sorting the conversation list and
   *  showing a line under each. Absent on the global room, whose history is
   *  the overseer's own conversation and is not in this journal. */
  lastMessageAt?: string;
  lastMessagePreview?: string;
}

/**
 * A thread is the anchor, and the bounds are per anchor.
 *
 * `open` is live, `bounded` hit three rounds or ten agent messages and only a
 * human message reopens it, `stopped` was stopped by hand, and `superseded`
 * was closed by a newer human message or by a change of members. Late replies
 * to anything but `open` are dropped with that reason.
 */
export type BusThreadState = 'open' | 'bounded' | 'stopped' | 'superseded';

export interface BusThread {
  id: string;
  roomId: string;
  anchorMessageId: string;
  state: BusThreadState;
  round: number;
  agentMessageCount: number;
  openedAt: string;
}

export type BusMessageAuthorKind = 'human' | 'agent' | 'system';

/**
 * What a machine line is about.
 *
 * The Chat page draws these as distinct rows, and with only `text` they all
 * collapse into one grey line. Each value here has a producer in this process;
 * a kind nobody emits would be a row the page can never show, which is the
 * same mistake as a state with no way out.
 *
 * There is deliberately no `passed`: an agent with nothing to add is refused
 * before anything is stored, so a silence has no row and no source of data.
 */
export type BusSystemKind = 'thread_stopped' | 'members_changed' | 'queue_released';

export interface BusMessage {
  id: string;
  roomId: string;
  threadId: string;
  authorKind: BusMessageAuthorKind;
  /** Agent id, or `human` for Noah. */
  authorId: string;
  authorName: string;
  text: string;
  /** Agent ids named in the text: after the first round, only a mentioned
   *  agent that has not spoken since gets a turn. */
  mentions: string[];
  /** Set only when `authorKind` is `system`: which machine event this is. */
  systemKind?: BusSystemKind;
  createdAt: string;
}

/**
 * Where a message got to, per target.
 *
 * `queued` waits for the target to leave `running`, `delivered` was written
 * into its session, `dropped` will never be sent and says why. `not_sent` is
 * the fourth state and the one that needs saying: amp, codex, grok, opencode
 * and pi never leave `running` in an interactive session, so nothing can be
 * delivered to them at rest. A message aimed at one of those is neither queued
 * nor delivered on its own: it is kept, shown as NOT SENT with its reason, and
 * moves only on an explicit human action. Never inferred from silence, which
 * is idleness detection and deliberately out of v1.
 */
export type BusDeliveryState = 'queued' | 'not_sent' | 'delivered' | 'dropped';

/**
 * Why a delivery is not going anywhere, as a value rather than a sentence.
 *
 * The interface has to render this, and matching on English prose is how a
 * wording change silently turns a visible state invisible. The sentence stays
 * beside it for a human to read.
 *
 * `no_end_of_turn` is the one that names the five: amp, codex, grok, opencode
 * and pi never leave `running` in an interactive session. `session_replaced`
 * is a message queued for a session that was killed before it drained: it
 * belongs to that session and is not handed to whatever took its place.
 */
export type BusDeliveryReason =
  | 'no_end_of_turn'
  | 'no_live_session'
  | 'session_replaced'
  | 'thread_stopped'
  | 'thread_replaced'
  | 'members_changed';

export interface BusDelivery {
  messageId: string;
  targetAgentId: string;
  state: BusDeliveryState;
  reasonCode?: BusDeliveryReason;
  reason?: string;
  queuedAt: string;
  deliveredAt?: string;
  /** When this stopped being on its way: set with `dropped` and with
   *  `not_sent`. Without it the page can say a message is refused but not
   *  when, which for `not_sent` is the whole of how old a held message is. */
  refusedAt?: string;
}

/**
 * A member of a room, as the page needs to draw it.
 *
 * `hasEndOfTurn` is derived here from the provider's hook configuration, the
 * same read the delivery path makes. It is exposed because the renderer was
 * otherwise copying the list of five CLIs by hand, and a hand-written copy of
 * a derived value is a copy that goes stale the day a provider gains hooks.
 */
export interface BusMember {
  id: string;
  name: string;
  provider?: string;
  hasEndOfTurn: boolean;
}

/** What `bus:getRoom` answers: the room and its journal, newest last. */
export interface BusRoomSnapshot {
  room: BusRoom;
  members: BusMember[];
  threads: BusThread[];
  messages: BusMessage[];
  deliveries: BusDelivery[];
}
