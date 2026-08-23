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
} from './core/agent-manager';

import {
  ptyProcesses,
  quickPtyProcesses,
  skillPtyProcesses,
  pluginPtyProcesses,
  killAllPty,
  writeProgrammaticInput,
} from './core/pty-manager';

import { initTray, destroyTray } from './core/tray-manager';
import { broadcastToAllWindows } from './utils/broadcast';
import { extractStatusLine } from './utils/ansi';
import { scheduleTick } from './utils/agents-tick';

// Services
import { startApiServer } from './services/api-server';
import { startVeniceShimServer, stopVeniceShimServer } from './services/venice-shim';
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
import { registerVaultHandlers } from './handlers/vault-handlers';
import { registerTemplateHandlers } from './handlers/template-handlers';
import { registerTeamTemplateHandlers } from './handlers/team-template-handlers';
import { registerHermesHandlers } from './handlers/hermes-handlers';
import { registerOverseerHandlers } from './handlers/overseer-handlers';
import { startOverseerWatch, stopOverseerWatch } from './services/overseer';
import { initVaultDb, closeVaultDb } from './services/vault-db';
import { initAutoUpdater, checkForUpdates, setMainWindowGetter } from './services/update-checker';
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
  ensureTarsClaudeMd,
  migrateFromClaudeManager,
} from './utils';

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
    statusLineEnabled: false,
    chromeEnabled: false,
    autoCheckUpdates: true,
    autoStartAgentsOnLaunch: true,
    opencodeEnabled: false,
    opencodeDefaultModel: '',
    defaultProvider: 'claude',
    cliPaths: {
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
      // Import from agent-manager state
      const { superAgentTelegramTask } = require('./core/agent-manager');
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
  // Loopback-only, always on: it is a no-op until a venice agent's PTY is
  // spawned with the shim's URL baked into ANTHROPIC_BASE_URL. See
  // services/venice-shim.ts for why this cannot just be another /api/* route.
  startVeniceShimServer();
}

// ============== App Initialization ==============

// Register protocol schemes before app is ready
registerProtocolSchemes();

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

  // Write Tars's CLAUDE.md to ~/.dorothy/ so all spawned agents can load it
  ensureTarsClaudeMd();

  // Install/update statusline script if enabled (ensures script is always up-to-date after app updates)
  // statusLineEnabled defaults to true for new users
  try {
    const { enableStatusLine, disableStatusLine } = await import('./utils/statusline');
    if (appSettings.statusLineEnabled !== false) {
      enableStatusLine();
    } else {
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
  registerOverseerHandlers();

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
      const pty = await import('node-pty');

      const id = uuidv4();
      const shell = process.env.SHELL || '/bin/zsh';
      let cwd = config.projectPath;

      if (!fs.existsSync(cwd)) {
        cwd = os.homedir();
      }

      const allSkills = [...new Set(config.skills)];

      const ptyProcess = pty.spawn(shell, ['-l'], {
        name: 'xterm-256color',
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

      // Build final prompt with skills
      let finalPrompt = prompt;
      if (agent.skills && agent.skills.length > 0) {
        const skillsList = agent.skills.join(', ');
        finalPrompt = `[IMPORTANT: Use these skills for this session: ${skillsList}. Invoke them with /<skill-name> when relevant to the task.] ${prompt}`;
      }

      const escapedPrompt = finalPrompt.replace(/'/g, "'\\''");
      command += ` '${escapedPrompt}'`;

      // Update status
      agent.status = 'running';
      agent.currentTask = prompt.slice(0, 100);
      agent.lastActivity = new Date().toISOString();

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

  // Auto-check for updates on startup (electron-updater sends 'app:update-available' automatically)
  if (appSettings.autoCheckUpdates !== false) {
    setTimeout(() => {
      checkForUpdates().catch((err) => {
        console.error('Auto-update check failed:', err);
      });
    }, 5000);
  }

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
  destroyTray();
  stopAgentAutosave();
  stopOverseerWatch();
  saveAgents();
  killAllPty();
  closeVaultDb();
  stopVeniceShimServer();
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
