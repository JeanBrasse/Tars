/**
 * Tars - Main Electron Entry Point
 *
 * This file initializes and wires together all the modular components:
 * - Window management and protocol handling
 * - Agent state and PTY management
 * - IPC handlers for renderer communication
 * - External services (Telegram, Slack, HTTP API)
 * - MCP orchestrator integration
 */

import { app, BrowserWindow } from 'electron';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

// Types
import type { AppSettings, AgentStatus } from './types';

// Constants
import { APP_SETTINGS_FILE, API_TOKEN_FILE } from './constants';
import { promptOperand } from './providers/cli-provider';

// Core modules
import {
  createWindow,
  registerProtocolSchemes,
  setupProtocolHandler,
  getMainWindow,
  isDevBuild,
} from './core/window-manager';

import {
  agents,
  loadAgents,
  saveAgents,
  initAgentPty,
  handleStatusChangeNotification,
  getSuperAgentOutputBuffer,
  clearSuperAgentOutputBuffer,
  killStalePty,
  superAgentTelegramTask,
  armTaskStartWatch,
} from './core/agent-manager';

import {
  ptyProcesses,
  quickPtyProcesses,
  skillPtyProcesses,
  pluginPtyProcesses,
  killAllPty,
  writeProgrammaticInput,
} from './core/pty-manager';

import { runShutdownSteps } from './core/shutdown';
import { initTray, destroyTray } from './core/tray-manager';
import { broadcastToAllWindows } from './utils/broadcast';
import { extractStatusLine } from './utils/ansi';
import { scheduleTick } from './utils/agents-tick';

// Services
import { startApiServer } from './services/api-server';
import { startOpenAIBridgeServer, stopOpenAIBridgeServer } from './services/openai-bridge';
import {
  initTelegramBotService,
  initTelegramBot as initTelegramBotHandlers,
  getTelegramBot,
  sendTelegramMessage,
  sendSuperAgentResponseToTelegram,
} from './services/telegram-bot';
import {
  initSlackBot,
  getSlackApp,
  getSlackResponseChannel,
  getSlackResponseThreadTs,
} from './services/slack-bot';
import {
  getClaudeSettings,
  getClaudeStats,
  getClaudeProjects,
  getClaudePlugins,
  getClaudeSkills,
  getClaudeHistory,
} from './services/claude-service';
import { configureStatusHooks } from './services/hooks-manager';
import { loadCatalog } from './services/model-catalog';
import { startAgentAutosave, stopAgentAutosave, appendAgentOutput } from './core/agent-manager';
import {
  setupMcpOrchestrator,
  setupMemoryBackends,
  registerMcpOrchestratorHandlers,
  getMcpOrchestratorPath,
} from './services/mcp-orchestrator';

// Handlers
import { registerIpcHandlers, IpcHandlerDependencies } from './handlers/ipc-handlers';
import { registerCLIPathsHandlers } from './handlers/cli-paths-handlers';
import { registerKanbanHandlers } from './handlers/kanban-handlers';
import { registerBusHandlers } from './handlers/bus-handlers';
import { flushBus } from './services/bus-store';
import { registerVaultHandlers } from './handlers/vault-handlers';
import { registerTemplateHandlers } from './handlers/template-handlers';
import { registerTeamTemplateHandlers } from './handlers/team-template-handlers';
import { registerHermesHandlers } from './handlers/hermes-handlers';
import { registerTranscriptHandlers } from './handlers/transcript-handlers';
import { registerOverseerHandlers } from './handlers/overseer-handlers';
import { startOverseerWatch, stopOverseerWatch, migrateOverseerOutOfAgentReach } from './services/overseer';
import { migrateWebhookSecretOutOfAgentReach } from './services/hermes-webhook-secret';
import { startAgentWatch } from './services/agent-watch';
import { initVaultDb, closeVaultDb } from './services/vault-db';
import { initAutoUpdater, checkForUpdates, setMainWindowGetter } from './services/update-checker';
import { startCliUpdates } from './services/cli-updater';
import { initKanbanAutomation, findMatchingAgent, createAgentForTask, startAgentForTask } from './services/kanban-automation';
import { writeSecretFileSync, ensureSecretFileMode } from './utils/secret-file';
import { HERMES_CONNECTION_FILE } from './services/hermes-config';

// Utils
import {
  setMainWindow as setUtilsMainWindow,
  sendNotification,
  isSuperAgent,
  getSuperAgent,
  ensureDataDir,
  ensureAgentInstructions,
  migrateFromClaudeManager,
} from './utils';
import { spawnAgentPty } from './core/agent-pty';
import { getProvider } from './providers';

// ============== App Settings Management ==============

// A closed stdout/stderr pipe (e.g. the launching shell exited) must never
// crash the app: console.log would otherwise throw an uncaught EPIPE.
for (const stream of [process.stdout, process.stderr]) {
  stream.on('error', (err: NodeJS.ErrnoException) => {
    if (err.code !== 'EPIPE') throw err;
  });
}

let appSettings: AppSettings = loadAppSettings();

function loadAppSettings(): AppSettings {
  const defaults: AppSettings = {
    notificationsEnabled: true,
    notifyOnWaiting: true,
    notifyOnComplete: true,
    notifyOnStop: true,
    notifyOnError: true,
    telegramEnabled: false,
    telegramBotToken: '',
    telegramChatId: '',
    telegramAuthToken: '',
    telegramAuthorizedChatIds: [],
    telegramRequireMention: false,
    slackEnabled: false,
    slackBotToken: '',
    slackAppToken: '',
    slackSigningSecret: '',
    slackChannelId: '',
    jiraEnabled: false,
    jiraDomain: '',
    jiraEmail: '',
    jiraApiToken: '',
    socialDataEnabled: false,
    socialDataApiKey: '',
    xPostingEnabled: false,
    xApiKey: '',
    xApiSecret: '',
    xAccessToken: '',
    xAccessTokenSecret: '',
    tasmaniaEnabled: false,
    tasmaniaServerPath: '',
    gwsEnabled: false,
    gwsSkillsInstalled: false,
    verboseModeEnabled: false,
    // statusLineEnabled is deliberately absent. It used to default to false,
    // two lines above a check reading `!== false` and a comment saying it
    // defaults to true for new users, so for everyone who had never touched
    // the switch the app took the disable branch on every launch and deleted
    // `statusLine` out of ~/.claude/settings.json. Absent means unchosen, and
    // unchosen means Tars leaves that file alone.
    chromeEnabled: false,
    autoCheckUpdates: true,
    autoStartAgentsOnLaunch: true,
    opencodeEnabled: false,
    opencodeDefaultModel: '',
    ampEnabled: false,
    ampDefaultModel: '',
    defaultProvider: 'claude',
    cliPaths: {
      amp: '',
      claude: '',
      codex: '',
      gemini: '',
      grok: '',
      qwencode: '',
      opencode: '',
      pi: '',
      gws: '',
      gcloud: '',
      gh: '',
      node: '',
      minimax: '',
      additionalPaths: [],
    },
  };
  try {
    if (fs.existsSync(APP_SETTINGS_FILE)) {
      const saved = JSON.parse(fs.readFileSync(APP_SETTINGS_FILE, 'utf-8'));
      return { ...defaults, ...saved };
    }
  } catch (err) {
    console.error('Failed to load app settings:', err);
  }
  return defaults;
}

function saveAppSettingsToFile(settings: AppSettings) {
  try {
    ensureDataDir();
    // 0600 and atomic: this file carries every provider API key, the Hermes
    // gateway token and the memory-backend credentials.
    writeSecretFileSync(APP_SETTINGS_FILE, JSON.stringify(settings, null, 2));
  } catch (err) {
    console.error('Failed to save app settings:', err);
  }
}

// ============== Telegram Bot Initialization ==============

function initTelegramBot() {
  // First inject dependencies into the Telegram bot service
  initTelegramBotService(
    agents,
    ptyProcesses,
    appSettings,
    getMainWindow(),
    () => getSuperAgent(agents),
    saveAgents,
    getClaudeStats,
    (agent: AgentStatus) => initAgentPty(
      agent,
      getMainWindow(),
      handleStatusChangeNotificationWrapper,
      saveAgents
    ),
    saveAppSettingsToFile
  );

  // Then initialize the bot with handlers
  initTelegramBotHandlers();
}

// ============== Notification Handler Wrapper ==============

function handleStatusChangeNotificationWrapper(agent: AgentStatus, newStatus: string) {
  handleStatusChangeNotification(
    agent,
    newStatus,
    appSettings,
    sendNotification,
    (text: string) => sendTelegramMessage(text),
    sendSuperAgentResponseToTelegram
  );
}

// ============== IPC Handler Dependencies ==============

function createIpcDependencies(): IpcHandlerDependencies {
  return {
    // State
    ptyProcesses,
    agents,
    skillPtyProcesses,
    quickPtyProcesses,
    pluginPtyProcesses,

    // Functions
    getMainWindow,
    getAppSettings: () => appSettings,
    setAppSettings: (settings: AppSettings) => { appSettings = settings; },
    saveAppSettings: saveAppSettingsToFile,
    saveAgents,
    initAgentPty: (agent: AgentStatus) => initAgentPty(
      agent,
      getMainWindow(),
      handleStatusChangeNotificationWrapper,
      saveAgents
    ),
    handleStatusChangeNotification: handleStatusChangeNotificationWrapper,
    isSuperAgent,
    getMcpOrchestratorPath,
    initTelegramBot,
    initSlackBot: () => initSlackBot(appSettings, (settings) => {
      appSettings = settings;
      saveAppSettingsToFile(settings);
    }, getMainWindow()),
    getTelegramBot,
    getSlackApp,
    getSuperAgentTelegramTask: () => {
      // Read at call time, not at wire-up time: this is a mutable module
      // binding, and TypeScript's CommonJS output dereferences it on each
      // access, so the import gives the current value the require gave.
      return superAgentTelegramTask;
    },
    getSuperAgentOutputBuffer,
    setSuperAgentOutputBuffer: (buffer: string[]) => {
      // This is handled internally by agent-manager
      clearSuperAgentOutputBuffer();
      buffer.forEach(item => getSuperAgentOutputBuffer().push(item));
    },

    // Claude data functions
    getClaudeSettings,
    getClaudeStats,
    getClaudeProjects,
    getClaudePlugins,
    getClaudeSkills,
    getClaudeHistory,
  };
}

// ============== API Server Initialization ==============

function initApiServer() {
  startApiServer(
    getMainWindow(),
    appSettings,
    getTelegramBot,
    getSlackApp,
    getSlackResponseChannel(),
    getSlackResponseThreadTs(),
    handleStatusChangeNotificationWrapper,
    sendNotification,
    (agent: AgentStatus) => initAgentPty(
      agent,
      getMainWindow(),
      handleStatusChangeNotificationWrapper,
      saveAgents
    ),
    () => appSettings
  );
  // Loopback-only, always on: it is a no-op until a Venice or custom-vendor
  // agent's PTY is spawned with the bridge's URL baked into ANTHROPIC_BASE_URL.
  // See services/openai-bridge.ts for why this cannot just be another /api/*
  // route, and for the addressing scheme that lets one server serve both.
  startOpenAIBridgeServer();
}

// ============== App Initialization ==============

// Register protocol schemes before app is ready
registerProtocolSchemes();

/** How often the app looks for a new version while it is running. */
const UPDATE_CHECK_INTERVAL_MS = 30 * 60 * 1000;

app.whenReady().then(async () => {
  console.log('App ready, initializing...');

  // Ensure data directory exists
  ensureDataDir();

  // Narrow the credential files on installs that predate the 0600 write.
  // A `mode` passed to writeFileSync only applies at creation, so an
  // app-settings.json already sitting at 0644 would keep it forever.
  for (const secret of [APP_SETTINGS_FILE, HERMES_CONNECTION_FILE, API_TOKEN_FILE]) {
    ensureSecretFileMode(secret);
  }

  // Take Noah's conversation with the super chat out of ~/.dorothy, which is
  // the directory every agent is handed. Here rather than on the first read of
  // it: a run in which the Chat is never opened would otherwise leave the file
  // sitting there for its whole length.
  migrateOverseerOutOfAgentReach();
  // And the Hermes webhook secret, for the same reason: through the webhook it
  // gives any agent of any project work, and ~/.dorothy is one `cat` away.
  migrateWebhookSecretOutOfAgentReach();

  // Write Tars's CLAUDE.md to ~/.dorothy/ so all spawned agents can load it
  ensureAgentInstructions();

  // Install/update statusline script if enabled (ensures script is always up-to-date after app updates)
  // statusLineEnabled defaults to true for new users
  try {
    const { enableStatusLine, disableStatusLine } = await import('./utils/statusline');
    // Only an explicit choice acts here. This runs on every launch and is not
    // a user action: it exists to refresh the script after an update. Reading
    // an absent setting as "off" turned that refresh into a deletion in
    // another program's configuration file, once per launch, for anyone who
    // had never opened that switch.
    if (appSettings.statusLineEnabled === true) {
      enableStatusLine();
    } else if (appSettings.statusLineEnabled === false) {
      disableStatusLine();
    }
  } catch {
    // ignore statusline errors on startup
  }

  // Migrate data from ~/.claude-manager if it exists (rebrand migration)
  migrateFromClaudeManager();

  // Load agents from disk
  loadAgents();
  // Bound how much a crash can lose: PTY-driven fields reach disk on a timer.
  startAgentAutosave();

  // Setup protocol handler for production
  setupProtocolHandler();

  // Create the main window
  createWindow();

  // Set the main window reference in utils
  setUtilsMainWindow(getMainWindow());

  // Initialize macOS menu bar tray with custom popup panel
  initTray();

  // Register all IPC handlers
  const deps = createIpcDependencies();
  registerIpcHandlers(deps);
  registerMcpOrchestratorHandlers();
  registerCLIPathsHandlers({
    getAppSettings: () => appSettings,
    setAppSettings: (settings) => { appSettings = settings; },
    saveAppSettings: saveAppSettingsToFile,
  });

  // Register agent template handlers (no deps, self-contained)
  registerTemplateHandlers();
  registerTeamTemplateHandlers();
  registerHermesHandlers();
  registerTranscriptHandlers();
  registerOverseerHandlers();
  registerBusHandlers();

  // The overseer's watch timer: an unprompted briefing reaches the Chat page
  // through the same broadcast channel every other live update uses.
  startOverseerWatch((message) => broadcastToAllWindows('overseer:briefing', message));

  // Register kanban handlers
  registerKanbanHandlers({
    getMainWindow,
    findMatchingAgent,
    createAgentForTask,
    startAgent: startAgentForTask,
    stopAgent: async (agentId: string) => {
      const agent = agents.get(agentId);
      if (agent?.ptyId) {
        const ptyProcess = ptyProcesses.get(agent.ptyId);
        if (ptyProcess) {
          // Send Ctrl+C to interrupt
          ptyProcess.write('\x03');
        }
        agent.status = 'idle';
        agent.currentTask = undefined;
        agent.lastActivity = new Date().toISOString();
        saveAgents();

        broadcastToAllWindows('agent:status', {
          type: 'status',
          agentId,
          status: 'idle',
          timestamp: new Date().toISOString(),
        });
      }
    },
    deleteAgent: async (agentId: string) => {
      const agent = agents.get(agentId);
      if (agent) {
        // Stop PTY if running
        if (agent.ptyId) {
          const ptyProcess = ptyProcesses.get(agent.ptyId);
          if (ptyProcess) {
            ptyProcess.kill();
          }
          ptyProcesses.delete(agent.ptyId);
        }
        // Remove agent
        agents.delete(agentId);
        saveAgents();
        console.log(`Agent ${agentId} deleted`);
      }
    },
    getAgentOutput: (agentId: string) => {
      const agent = agents.get(agentId);
      return agent?.output || [];
    },
  });

  // Initialize vault database
  initVaultDb();

  // Register vault handlers
  registerVaultHandlers({ getMainWindow });


  // Initialize kanban automation service
  initKanbanAutomation({
    agents,
    createAgent: async (config) => {
      // Create agent directly - similar to agent:create handler
      const { v4: uuidv4 } = await import('uuid');

      const id = uuidv4();
      const shell = process.env.SHELL || '/bin/zsh';
      let cwd = config.projectPath;

      if (!fs.existsSync(cwd)) {
        cwd = os.homedir();
      }

      const allSkills = [...new Set(config.skills)];

      // Through spawnAgentPty, like every other agent pty. This is the kanban
      // automation creating an agent by itself, and the comment above says it
      // duplicates the agent:create handler: it duplicated the defect too,
      // setting CLAUDE_AGENT_ID with no API address beside it, so an agent a
      // sandbox created from a board posted its hooks into the live Tars.
      const ptyProcess = spawnAgentPty({
        binaryName: getProvider('claude').binaryName,
        shell,
        args: ['-l'],
        cols: 120,
        rows: 30,
        cwd,
        env: {
          ...process.env as { [key: string]: string },
          CLAUDE_SKILLS: allSkills.join(','),
          CLAUDE_AGENT_ID: id,
          CLAUDE_PROJECT_PATH: config.projectPath,
        },
      });

      const ptyId = uuidv4();
      ptyProcesses.set(ptyId, ptyProcess);

      const status: AgentStatus = {
        id,
        status: 'idle',
        projectPath: config.projectPath,
        skills: allSkills,
        output: [],
        lastActivity: new Date().toISOString(),
        ptyId,
        ptyCwd: cwd,
        character: config.character || 'robot',
        name: config.name || `Agent ${id.slice(0, 4)}`,
        permissionMode: config.permissionMode || 'auto',
      };

      agents.set(id, status);
      saveAgents();

      // Setup PTY event handlers
      ptyProcess.onData((data) => {
        const agent = agents.get(id);
        if (agent) {
          appendAgentOutput(agent, data);
          agent.lastActivity = new Date().toISOString();
          agent.statusLine = extractStatusLine(agent.output);
        }
        broadcastToAllWindows('agent:output', {
          type: 'output',
          agentId: id,
          ptyId,
          data,
          timestamp: new Date().toISOString(),
        });
        scheduleTick();
      });

      ptyProcess.onExit(({ exitCode }) => {
        const agent = agents.get(id);
        if (agent) {
          const newStatus = exitCode === 0 ? 'completed' : 'error';
          agent.status = newStatus;
          agent.lastActivity = new Date().toISOString();
          handleStatusChangeNotificationWrapper(agent, newStatus);
        }
        ptyProcesses.delete(ptyId);
        // Emit status event so kanban sync can detect completion
        broadcastToAllWindows('agent:status', {
          type: 'status',
          agentId: id,
          status: exitCode === 0 ? 'completed' : 'error',
          timestamp: new Date().toISOString(),
        });
        broadcastToAllWindows('agent:complete', {
          type: 'complete',
          agentId: id,
          ptyId,
          exitCode,
          timestamp: new Date().toISOString(),
        });
        scheduleTick();
      });

      return status;
    },
    startAgent: async (agentId, prompt) => {
      const agent = agents.get(agentId);
      if (!agent) throw new Error('Agent not found');

      // BUG 4 guard: kill stale PTY if worktreePath changed after spawn.
      killStalePty(agent);

      // Initialize PTY if needed
      if (!agent.ptyId || !ptyProcesses.has(agent.ptyId)) {
        const ptyId = await initAgentPty(
          agent,
          getMainWindow(),
          handleStatusChangeNotificationWrapper,
          saveAgents
        );
        agent.ptyId = ptyId;
      }

      const ptyProcess = ptyProcesses.get(agent.ptyId);
      if (!ptyProcess) throw new Error('PTY not found');

      // Build Claude command - always use dangerous mode for kanban tasks
      let command = 'claude --dangerously-skip-permissions';
      if (appSettings.verboseModeEnabled) {
        command += ' --verbose';
      }

      // Build final prompt with skills, and no operand at all without a task.
      let finalPrompt = prompt?.trim() ? prompt : '';
      if (finalPrompt && agent.skills && agent.skills.length > 0) {
        const skillsList = agent.skills.join(', ');
        finalPrompt = `[IMPORTANT: Use these skills for this session: ${skillsList}. Invoke them with /<skill-name> when relevant to the task.] ${prompt}`;
      }

      command += promptOperand(finalPrompt);

      // Update status
      agent.status = 'running';
      agent.currentTask = prompt.slice(0, 100);
      agent.lastActivity = new Date().toISOString();
      // Started by the Kanban automation, which carries a task like any other.
      armTaskStartWatch(agent, agent.ptyId, finalPrompt);

      const workingPath = (agent.worktreePath || agent.projectPath).replace(/'/g, "'\\''");
      const fullCommand = `cd '${workingPath}' && ${command}`;

      // For long commands, write to a temp script to avoid PTY line-wrapping mangling
      if (fullCommand.length > 100) {
        const tmpScript = path.join(os.tmpdir(), `claude-agent-${agentId}.sh`);
        fs.writeFileSync(tmpScript, `#!/bin/bash\n${fullCommand}\n`, { mode: 0o755 });
        writeProgrammaticInput(ptyProcess, `bash '${tmpScript}'`);
      } else {
        writeProgrammaticInput(ptyProcess, fullCommand);
      }

      saveAgents();
    },
    saveAgents,
  });

  // Initialize services
  initTelegramBot();
  initSlackBot(appSettings, (settings) => {
    appSettings = settings;
    saveAppSettingsToFile(settings);
  }, getMainWindow());
  initApiServer();
  // Delegation reports back on its own from here: an agent that finishes tells
  // whoever dispatched it, without the orchestrator having to ask.
  startAgentWatch();

  // Setup MCP orchestrator and hooks
  // Warm the model/price catalogue without blocking the window: a stale disk
  // copy answers immediately, the network refresh lands whenever it lands.
  loadCatalog().catch(() => { /* cached or floor prices carry the app */ });

  // Registration only has to finish before an agent starts, not before the
  // window paints. It used to hold the main thread through the first render.
  void setupMcpOrchestrator(appSettings).catch(err =>
    console.error('MCP registration failed:', err));
  setupMemoryBackends(appSettings);
  await configureStatusHooks();

  // Initialize electron-updater (wires up IPC events for progress, downloaded, error)
  initAutoUpdater(getMainWindow);
  setMainWindowGetter(getMainWindow);

  // Updates: once shortly after launch, then on a timer.
  //
  // It used to be the launch check alone, which is the one moment it helps
  // least: Tars is left open for days at a time, so someone who never quits
  // never learned there was a new version. Half an hour is well inside
  // GitHub's unauthenticated rate limit and the check itself is one request.
  if (appSettings.autoCheckUpdates !== false) {
    const check = () => {
      checkForUpdates().catch((err) => {
        console.error('Auto-update check failed:', err);
      });
    };
    setTimeout(check, 5000);
    const timer = setInterval(check, UPDATE_CHECK_INTERVAL_MS);
    // Never hold the process open for a version check.
    timer.unref?.();
  }

  // And the CLIs the agents run, which Tars keeps from updating themselves:
  // claude and Amp, 5 s after launch and every half hour, logged to
  // ~/.dorothy/cli-updates.log. See services/cli-updater.ts.
  startCliUpdates(() => appSettings);

  console.log('App initialization complete');
});

// Quit when all windows are closed (except on macOS)
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

// Re-create window on macOS when dock icon is clicked
app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    createWindow();
    setUtilsMainWindow(getMainWindow());
  }
});

// Save agents and kill all PTY processes before quitting
app.on('before-quit', () => {
  console.log('App quitting, saving agents and killing all PTY processes...');
  // Each step guarded, and the two that write to disk first: see shutdown.ts.
  // The bus journal writes once per turn of the event loop rather than once
  // per row, so a turn that ends in a quit is the one that never gets there.
  runShutdownSteps([
    ['flushBus', flushBus],
    ['saveAgents', saveAgents],
    ['destroyTray', destroyTray],
    ['stopAgentAutosave', stopAgentAutosave],
    ['stopOverseerWatch', stopOverseerWatch],
    ['killAllPty', killAllPty],
    ['closeVaultDb', closeVaultDb],
    ['stopOpenAIBridgeServer', stopOpenAIBridgeServer],
  ]);
});

/**
 * Loopback hosts whose TLS errors may be waived, and only in a dev build.
 *
 * This used to be `url.startsWith('https://localhost')` - a raw prefix test on
 * the whole URL, not a host comparison. `https://localhost.attacker.example/x`
 * and `https://localhostess.example` both match that prefix, so Chromium was
 * told to accept an expired, self-signed or wrong-host certificate for a host
 * the attacker owns; any subresource the renderer pulls from it (an <img> in a
 * note whose markdown an agent wrote, say) then travels over a connection whose
 * certificate was never validated, with no interstitial. The handler also had
 * no build guard despite its "in development" comment, so it shipped enabled in
 * the signed release. Now: parse the URL, compare the hostname exactly, and
 * only ever waive in an unpackaged build - see isDevBuild().
 */
const TLS_WAIVER_HOSTS = new Set(['localhost', '127.0.0.1', '::1']);

function mayWaiveCertificateError(url: string): boolean {
  if (!isDevBuild()) return false;
  let hostname: string;
  try {
    ({ hostname } = new URL(url));
  } catch {
    return false;
  }
  // URL keeps IPv6 literals bracketed ("[::1]"); strip so the set matches.
  if (hostname.startsWith('[') && hostname.endsWith(']')) {
    hostname = hostname.slice(1, -1);
  }
  return TLS_WAIVER_HOSTS.has(hostname.toLowerCase());
}

// Handle certificate errors in development
app.on('certificate-error', (event, webContents, url, error, certificate, callback) => {
  if (mayWaiveCertificateError(url)) {
    event.preventDefault();
    callback(true);
  } else {
    callback(false);
  }
});

export { appSettings, getTelegramBot };
