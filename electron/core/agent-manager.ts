import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { v4 as uuidv4 } from 'uuid';
import { BrowserWindow, Notification } from 'electron';
import { AgentStatus, AppSettings } from '../types';
import { broadcastToAllWindows } from '../utils/broadcast';
import { AGENTS_FILE, DATA_DIR, dataPath, API_PORT } from '../constants';
import { ensureDataDir, isSuperAgent } from '../utils';
import { ptyProcesses } from './pty-manager';
import { spawnAgentPty } from './agent-pty';
import { buildFullPath } from '../utils/path-builder';
import { getProvider } from '../providers';
import { extractStatusLine } from '../utils/ansi';
import { scheduleTick } from '../utils/agents-tick';
import { getTasmaniaStatus } from '../services/tasmania-client';
import { emitAgentStatus } from '../services/agent-events';

export const agents: Map<string, AgentStatus> = new Map();

/**
 * Pre-populate Claude Code's workspace trust record for a given directory.
 *
 * BUG 6 fix: `--dangerously-skip-permissions` skips *runtime* permission
 * prompts (Edit/Write/Bash confirmations), but Claude Code has a SEPARATE
 * "workspace trust" dialog that fires on first launch in an unknown directory.
 * That dialog is gated by `~/.claude.json`'s
 * `projects[<absolute-path>].hasTrustDialogAccepted` flag: NOT by the
 * runtime permission mode. So even a bypass-mode agent hits the trust prompt
 * on first launch in a new project.
 *
 * Writing the flag ourselves before we spawn the claude process makes the
 * trust dialog never appear. Safe to call repeatedly and idempotent.
 */
export function ensureProjectTrusted(projectPath: string): void {
  if (!projectPath) return;
  const claudeJsonPath = path.join(os.homedir(), '.claude.json');
  type ClaudeConfig = {
    projects?: Record<string, {
      hasTrustDialogAccepted?: boolean;
      projectOnboardingSeenCount?: number;
      [key: string]: unknown;
    }>;
    [key: string]: unknown;
  };
  let config: ClaudeConfig = {};
  try {
    if (fs.existsSync(claudeJsonPath)) {
      const raw = fs.readFileSync(claudeJsonPath, 'utf-8');
      if (raw.trim()) {
        config = JSON.parse(raw) as ClaudeConfig;
      }
    }
  } catch (err) {
    console.warn(`ensureProjectTrusted: failed to read ${claudeJsonPath}:`, err);
    // If the file exists but is unreadable/corrupt, don't overwrite it.
    if (fs.existsSync(claudeJsonPath)) return;
  }

  if (!config.projects) config.projects = {};
  const existing = config.projects[projectPath] ?? {};
  if (existing.hasTrustDialogAccepted === true) return;

  config.projects[projectPath] = {
    ...existing,
    hasTrustDialogAccepted: true,
    projectOnboardingSeenCount: existing.projectOnboardingSeenCount ?? 1,
  };

  try {
    fs.writeFileSync(claudeJsonPath, JSON.stringify(config, null, 2));
    console.log(`ensureProjectTrusted: marked ${projectPath} trusted in ~/.claude.json`);
  } catch (err) {
    console.warn(`ensureProjectTrusted: failed to write ${claudeJsonPath}:`, err);
  }
}

export let agentsLoaded = false;
export let superAgentTelegramTask = false;
export let superAgentOutputBuffer: string[] = [];

export function setSuperAgentTelegramTask(value: boolean) {
  superAgentTelegramTask = value;
}

export function getSuperAgentOutputBuffer(): string[] {
  return superAgentOutputBuffer;
}

export function clearSuperAgentOutputBuffer() {
  superAgentOutputBuffer = [];
}

/**
 * Kill the agent's PTY if its recorded cwd no longer matches the agent's
 * current logical working directory (worktreePath ?? projectPath). Returns
 * true if the PTY was killed (caller should respawn before writing to it).
 *
 * This prevents the BUG 4 scenario where an agent has a worktree added
 * after its PTY was created: the running PTY keeps its old cwd, so
 * subsequent messages land in the main workspace instead of the worktree.
 */
export function killStalePty(agent: AgentStatus): boolean {
  if (!agent.ptyId) return false;
  const expectedCwd = agent.worktreePath || agent.projectPath;
  if (agent.ptyCwd === expectedCwd) return false;
  const existing = ptyProcesses.get(agent.ptyId);
  if (existing) {
    try {
      existing.kill();
    } catch (err) {
      console.warn(`Failed to kill stale PTY for agent ${agent.id}:`, err);
    }
    ptyProcesses.delete(agent.ptyId);
  }
  console.log(
    `Killed stale PTY for agent ${agent.id}: ptyCwd=${agent.ptyCwd} expected=${expectedCwd}`
  );
  agent.ptyId = undefined;
  agent.ptyCwd = undefined;
  return true;
}

const previousAgentStatus: Map<string, string> = new Map();

const pendingStatusChanges: Map<string, {
  newStatus: string;
  scheduledAt: number;
  timeoutId: NodeJS.Timeout;
}> = new Map();

export function handleStatusChangeNotification(
  agent: AgentStatus,
  newStatus: string,
  appSettings: AppSettings,
  sendNotification: (title: string, body: string, agentId?: string, settings?: { notificationsEnabled: boolean }) => void,
  sendTelegramMessage?: (text: string) => void,
  sendSuperAgentResponseToTelegram?: (agent: AgentStatus) => void
) {
  const prevStatus = previousAgentStatus.get(agent.id);

  if (!prevStatus) {
    previousAgentStatus.set(agent.id, newStatus);
    return;
  }

  if (prevStatus === newStatus) {
    return;
  }

  if (newStatus === 'running') {
    const pending = pendingStatusChanges.get(agent.id);
    if (pending) {
      clearTimeout(pending.timeoutId);
      pendingStatusChanges.delete(agent.id);
    }
    previousAgentStatus.set(agent.id, newStatus);
    return;
  }

  const pending = pendingStatusChanges.get(agent.id);

  if (pending && pending.newStatus === newStatus) {
    return;
  }

  if (pending) {
    clearTimeout(pending.timeoutId);
  }

  const timeoutId = setTimeout(() => {
    pendingStatusChanges.delete(agent.id);

    const currentAgent = agents.get(agent.id);
    if (!currentAgent || currentAgent.status !== newStatus) {
      return;
    }

    previousAgentStatus.set(agent.id, newStatus);

    const agentName = currentAgent.name || `Agent ${currentAgent.id.slice(0, 6)}`;
    const isSuper = isSuperAgent(currentAgent);

    if (newStatus === 'waiting') {
      if (!isSuper && appSettings.notifyOnWaiting) {
        sendNotification(
          `${agentName} needs your attention`,
          'The agent is waiting for your input.',
          currentAgent.id,
          appSettings
        );
      }
      if (isSuper && superAgentTelegramTask && sendSuperAgentResponseToTelegram) {
        sendSuperAgentResponseToTelegram(currentAgent);
        superAgentTelegramTask = false;
      }
    } else if (newStatus === 'completed' && appSettings.notifyOnComplete) {
      if (!isSuper) {
        sendNotification(
          `${agentName} completed`,
          currentAgent.currentTask ? `Finished: ${currentAgent.currentTask.slice(0, 50)}...` : 'Task completed successfully.',
          currentAgent.id,
          appSettings
        );
      }
      if (isSuper && superAgentTelegramTask && sendSuperAgentResponseToTelegram) {
        sendSuperAgentResponseToTelegram(currentAgent);
        superAgentTelegramTask = false;
      }
    } else if (newStatus === 'error' && appSettings.notifyOnError) {
      if (!isSuper) {
        sendNotification(
          `${agentName} encountered an error`,
          currentAgent.error || 'An error occurred while running.',
          currentAgent.id,
          appSettings
        );
      }
      if (isSuper && superAgentTelegramTask && sendTelegramMessage) {
        sendTelegramMessage(`🔴 Super Agent error: ${currentAgent.error || 'An error occurred.'}`);
        superAgentTelegramTask = false;
      }
    }
  }, 5000);

  pendingStatusChanges.set(agent.id, {
    newStatus,
    scheduledAt: Date.now(),
    timeoutId,
  });
}

/**
 * On-disk format version. Bumping it lets loadAgents migrate old records
 * deliberately instead of hoping every field happens to still line up.
 */
const AGENTS_SCHEMA_VERSION = 2;

/** Retained terminal chunks per agent: enough to redraw a screen, bounded. */
const OUTPUT_CHUNK_CAP = 600;
const OUTPUT_RETAIN = 400;

/**
 * Appends a terminal chunk and keeps the buffer bounded.
 *
 * Five PTY handlers pushed into agent.output and none of them capped it, so a
 * chatty CLI grew that array for the life of the app, once per agent.
 */
export function appendAgentOutput(agent: AgentStatus, chunk: string): void {
  agent.output.push(chunk);
  if (agent.output.length > OUTPUT_CHUNK_CAP) {
    agent.output.splice(0, agent.output.length - OUTPUT_RETAIN);
  }
  markAgentsDirty();
}

interface AgentsFile {
  version: number;
  savedAt: string;
  agents: AgentStatus[];
}

function backupFile(): string {
  return path.join(DATA_DIR, 'agents.backup.json');
}

/** Runtime-only fields, stripped before writing. */
function persistable(agent: AgentStatus): AgentStatus {
  return {
    ...agent,
    ptyId: undefined,
    pathMissing: undefined,
    output: agent.output.slice(-100),
    status: agent.status === 'running' ? 'idle' : agent.status,
  } as AgentStatus;
}

function parseAgentsFile(raw: string): AgentStatus[] | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (Array.isArray(parsed)) return parsed as AgentStatus[];       // v1: bare array
  const file = parsed as Partial<AgentsFile>;
  return Array.isArray(file?.agents) ? file.agents : null;
}

/**
 * Writes the agent list.
 *
 * Atomic: a temp file renamed into place, so a crash mid-write leaves the
 * previous file intact rather than a truncated one. The backup is taken from
 * content we have just parsed successfully, so a corrupt current file can no
 * longer overwrite the last good copy.
 */
export function saveAgents() {
  try {
    if (!agentsLoaded) {
      console.log('Skipping save - agents not loaded yet');
      return;
    }

    ensureDataDir();
    const payload: AgentsFile = {
      version: AGENTS_SCHEMA_VERSION,
      savedAt: new Date().toISOString(),
      agents: Array.from(agents.values()).map(persistable),
    };

    if (fs.existsSync(AGENTS_FILE)) {
      try {
        const existing = fs.readFileSync(AGENTS_FILE, 'utf-8');
        const existingAgents = parseAgentsFile(existing);
        if (existingAgents && existingAgents.length > 0) {
          fs.writeFileSync(backupFile(), existing);
        }
      } catch {
        // An unreadable current file is exactly what the backup protects
        // against: leave the old backup alone.
      }
    }

    const tmp = `${AGENTS_FILE}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(payload, null, 2));
    fs.renameSync(tmp, AGENTS_FILE);
    agentsDirty = false;
  } catch (err) {
    console.error('Failed to save agents:', err);
  }
}

/* ── Periodic flush ────────────────────────────────────────
 * Fields mutated on every PTY chunk (output, statusLine, lastActivity) used
 * to reach disk only when some other action happened to call saveAgents, so
 * a crash lost them. markAgentsDirty + this timer bound that loss.
 */
let agentsDirty = false;
let flushTimer: NodeJS.Timeout | null = null;
const FLUSH_INTERVAL_MS = 30_000;

export function markAgentsDirty(): void {
  agentsDirty = true;
}

export function startAgentAutosave(intervalMs = FLUSH_INTERVAL_MS): void {
  if (flushTimer) return;
  flushTimer = setInterval(() => {
    if (agentsDirty) saveAgents();
  }, intervalMs);
  flushTimer.unref?.();
}

export function stopAgentAutosave(): void {
  if (flushTimer) clearInterval(flushTimer);
  flushTimer = null;
}

export function loadAgents() {
  try {
    if (!fs.existsSync(AGENTS_FILE)) {
      console.log('No agents file found, starting fresh');
      agentsLoaded = true;
      return;
    }

    const data = fs.readFileSync(AGENTS_FILE, 'utf-8');
    let agentsArray = parseAgentsFile(data);

    // Unparseable or empty: fall back to the backup rather than carrying on
    // with an empty map, which the next save would then write over the file.
    if (!agentsArray || agentsArray.length === 0) {
      const backup = backupFile();
      if (fs.existsSync(backup)) {
        const restored = parseAgentsFile(fs.readFileSync(backup, 'utf-8'));
        if (restored && restored.length > 0) {
          console.warn(`agents.json unusable - restoring ${restored.length} agents from backup`);
          agentsArray = restored;
        }
      }
    }

    if (!agentsArray) {
      // Keep the unreadable file for inspection instead of silently replacing it.
      try {
        fs.copyFileSync(AGENTS_FILE, `${AGENTS_FILE}.corrupt`);
      } catch { /* best effort */ }
      console.error('agents.json could not be parsed; kept a copy at agents.json.corrupt');
      agentsLoaded = true;
      return;
    }

    for (const agent of agentsArray) {
      const workingPath = agent.worktreePath || agent.projectPath;
      if (!fs.existsSync(workingPath)) {
        console.warn(`Agent ${agent.id} has missing path: ${workingPath} - marking as pathMissing`);
        agent.pathMissing = true;
      } else {
        agent.pathMissing = false;
      }

      agent.status = 'idle';
      agent.ptyId = undefined;
      agent.ptyCwd = undefined;
      // `output` is typed as required but is runtime state: nothing writes it
      // to agents.json, so every agent read back from disk arrives without it.
      // Consumers that trusted the type crashed - fleetSummary did
      // `agent.output.length`, which took down the whole Logs page for anyone
      // who had agents and restarted the app.
      agent.output = Array.isArray(agent.output) ? agent.output : [];
      // `skills` has the same shape of problem and was left out of that fix.
      // It IS written to agents.json, but only by versions that had the field,
      // so a file from an older build, a hand edit, or a restored backup
      // arrives without it. Every provider's getPtyEnvVars opens with
      // `skills.join(',')`, so `agent:start` threw "Cannot read properties of
      // undefined (reading 'join')" and the agent simply never started, with
      // the reason buried in an IPC rejection.
      agent.skills = Array.isArray(agent.skills) ? agent.skills : [];
      // Session ownership is runtime state: any persisted session died with
      // the previous app run, and keeping it would make the stale-session
      // guard reject the next real session's hooks (and /health lie).
      agent.currentSessionId = undefined;
      agent.lastKilledSessionId = undefined;
      // resumableSessionId is deliberately kept: it is not ownership, it is
      // the only record of where this agent's conversation got to, and losing
      // it on load is what made every restart throw the work away.
      agent.waitingReason = undefined;

      // Migrate legacy skipPermissions boolean → permissionMode
      if (!agent.permissionMode) {
        agent.permissionMode = agent.skipPermissions ? 'auto' : 'normal';
      }

      // Migrate name-substring orchestrator detection → persistent role field.
      // Name-only on purpose: orchestratorMode is a tool-restriction toggle
      // and must not promote agents into the Telegram/Slack super-agent pool.
      if (!agent.role) {
        const name = agent.name?.toLowerCase() || '';
        agent.role = (name.includes('super agent') || name.includes('orchestrator'))
          ? 'orchestrator'
          : 'worker';
      }

      // Backfill createdAt for legacy agents using lastActivity
      if (!agent.createdAt) {
        agent.createdAt = agent.lastActivity || new Date().toISOString();
      }

      agents.set(agent.id, agent);
    }

    console.log(`Loaded ${agents.size} agents from disk`);
    agentsLoaded = true;
  } catch (err) {
    console.error('Failed to load agents:', err);
    agentsLoaded = true;
  }
}

/**
 * One spawn at a time, per agent.
 *
 * Seven places do the same thing: check `!agent.ptyId || !ptyProcesses.has(...)`,
 * await initAgentPty, then set agent.ptyId. The await is a genuine suspension
 * point (spawnAgentSession waits on the memory digest for every non-Claude CLI),
 * so two callers can both pass the check before either has set the id and both
 * spawn, orphaning the first process. A double-clicked Start button does it; so
 * does a renderer resume racing an MCP delegate_task.
 *
 * That was fixed once, on the three HTTP routes, with a lock local to
 * agent-routes.ts. The IPC handler, the Super Agent path, the Telegram bot and
 * the Slack bot were left with the same shape, which a verifying agent then
 * reproduced: two concurrent `agent:start` calls, two spawns.
 *
 * So the lock lives here instead, around the one function that actually spawns.
 * Every caller gets it whether or not it knows to ask, and a caller that arrives
 * while a live PTY already exists is handed that one rather than a second.
 */
const ptyInitLocks = new Map<string, Promise<string>>();


/**
 * How long a session has to actually begin its task before it is disbelieved.
 *
 * Ten minutes, and the number is measured rather than picked. A warm start
 * registers in about 1.4 seconds. A start with the network unreachable takes
 * 77 seconds. And a start against a socket that accepts but never answers, the
 * "Checking for updates" case Noah actually hit, had still not registered
 * after 400 seconds while being perfectly healthy. Ninety seconds would have
 * accused that agent, which is the error this whole check calls the worse one.
 *
 * Ten minutes is 400 times a normal start and about 8 times the worst slow
 * start that does eventually arrive. The failure it looks for lasted hours, so
 * waiting ten minutes to name it gives up almost none of the value.
 */
const TASK_START_GRACE_MS = 600_000;

/**
 * Notice a session that came up and never took its task.
 *
 * Noah watched an agent sit at a Claude Code banner with an empty prompt,
 * marked `running`, for hours. Nothing was wrong with the process: it was
 * alive, it had a pty. It simply had no task, and every surface that could
 * have said so was reporting that it was working. That is the half that makes
 * the failure expensive: an agent that is stuck and an agent that is thinking
 * look identical from outside, so nobody looks.
 *
 * Lives here rather than beside one spawn site because the fault belongs to
 * the agent, not to the route that started it. An agent started from the
 * Agents page, from Telegram or from Slack goes nowhere near the API, and was
 * left unwatched while being exactly as capable of sitting there doing
 * nothing.
 *
 * Only for the CLIs that register at all. A session that has started its work
 * registers through the SessionStart hook, which is what sets
 * `currentSessionId`. The thirteen alternative providers run the same claude
 * binary with a different base url, so they register too; the handful that do
 * not are left alone rather than accused of a fault this cannot see. Being
 * wrong that way costs a missed report, being wrong the other way marks a
 * working agent broken.
 */
export function armTaskStartWatch(agent: AgentStatus, ptyId: string | undefined): void {
  if (!ptyId) return;
  if (getProvider(agent.provider).binaryName !== 'claude') return;

  // The precondition this check rests on, established here rather than trusted.
  //
  // The whole test below is "did a session register since this one started",
  // read as `currentSessionId` being unset when the grace period expires. Only
  // spawnAgentSession cleared it, for its own reason, so on the three paths
  // that did not, an agent that had already registered once in this run kept
  // the old id and the check quietly cancelled itself. Noah starts his agents
  // from the Agents page and they run all day with ptys dying and coming back,
  // so in his actual use it would almost never have fired: armed everywhere,
  // triggering nowhere, which is the shape of bug this exists to catch.
  //
  // Owned by the watch, so a fifth path added tomorrow inherits it without
  // knowing it exists. It is also the right thing on its own terms: a session
  // is starting, so nothing before it is authoritative any more, which is the
  // same reason spawnAgentSession clears it a few statements earlier.
  agent.currentSessionId = undefined;

  const timer = setTimeout(() => {
    const live = agents.get(agent.id);
    // Replaced by a newer start, or gone: not this session's business.
    if (!live || live.ptyId !== ptyId) return;
    // Already exited: onExit owns that outcome and knows the exit code.
    if (!ptyProcesses.has(ptyId)) return;
    // It registered, so it took its task.
    if (live.currentSessionId) return;
    // It moved on by itself, to waiting or completed or error.
    if (live.status !== 'running') return;

    console.error(
      `[agent] ${live.name || live.id} has been running for `
      + `${Math.round(TASK_START_GRACE_MS / 1000)}s without starting a turn: the task never reached the CLI`,
    );
    live.status = 'error';
    live.error = 'The CLI started but never began the task, so nothing was run. '
      + 'The session is open and idle; send the task again.';
    live.lastActivity = new Date().toISOString();
    saveAgents();
    // Two audiences, two channels, and the interface is the one that was
    // missing. scheduleTick is what the Agents page and the tray read, so
    // without it the card kept saying "working", which is the whole of what
    // Noah was looking at. emitAgentStatus is what /wait and the orchestrator
    // that dispatched it hang off.
    scheduleTick();
    emitAgentStatus(live.id);
  }, TASK_START_GRACE_MS);
  // A pending check must never be the reason the app cannot quit.
  timer.unref();
}

export async function initAgentPty(
  agent: AgentStatus,
  mainWindow: BrowserWindow | null,
  handleStatusChangeNotificationCallback: (agent: AgentStatus, newStatus: string) => void,
  saveAgentsCallback: () => void
): Promise<string> {
  const inFlight = ptyInitLocks.get(agent.id);
  if (inFlight) return inFlight;

  const run = initAgentPtyLocked(agent, mainWindow, handleStatusChangeNotificationCallback, saveAgentsCallback);
  // Cleared however it ends, so a failed spawn does not wedge the agent.
  ptyInitLocks.set(agent.id, run);
  try {
    return await run;
  } finally {
    if (ptyInitLocks.get(agent.id) === run) ptyInitLocks.delete(agent.id);
  }
}

async function initAgentPtyLocked(
  agent: AgentStatus,
  mainWindow: BrowserWindow | null,
  handleStatusChangeNotificationCallback: (agent: AgentStatus, newStatus: string) => void,
  saveAgentsCallback: () => void
): Promise<string> {
  // Re-check under the lock: the caller's check happened before it queued here,
  // and the call it was queued behind may have just created the PTY it wanted.
  if (agent.ptyId && ptyProcesses.has(agent.ptyId)) return agent.ptyId;

  const shell = '/bin/bash';
  let cwd = agent.worktreePath || agent.projectPath;

  if (!fs.existsSync(cwd)) {
    console.warn(`Agent ${agent.id} cwd does not exist: ${cwd}. Falling back to home directory`);
    cwd = os.homedir();
  }

  // BUG 6: pre-accept Claude Code's workspace trust dialog for this cwd so
  // bypass-mode agents never see the first-launch prompt.
  ensureProjectTrusted(cwd);

  console.log(`Initializing PTY for restored agent ${agent.id} in ${cwd}`);

  // Build PATH that includes user-configured paths, nvm, and other common locations for claude
  const cliExtraPaths: string[] = [];
  let savedSettings: Record<string, unknown> = {};
  try {
    const settingsFile = dataPath('app-settings.json');
    if (fs.existsSync(settingsFile)) {
      savedSettings = JSON.parse(fs.readFileSync(settingsFile, 'utf-8'));
      const cliPaths = savedSettings.cliPaths as Record<string, unknown> | undefined;
      if (cliPaths) {
        for (const key of ['claude', 'codex', 'gemini', 'grok', 'gws', 'gh', 'node']) {
          if (cliPaths[key]) {
            cliExtraPaths.push(path.dirname(cliPaths[key] as string));
          }
        }
        if (cliPaths.additionalPaths) {
          cliExtraPaths.push(...(cliPaths.additionalPaths as string[]).filter(Boolean));
        }
      }
    }
  } catch {
    // Ignore settings load errors
  }
  const fullPath = buildFullPath(cliExtraPaths);

  // For local provider, bake Tasmania env vars into the PTY process environment
  let tasmaniaEnv: Record<string, string> = {};
  if (agent.provider === 'local') {
    try {
      const tasmaniaStatus = await getTasmaniaStatus();
      if (tasmaniaStatus.status === 'running' && tasmaniaStatus.endpoint) {
        const localModel = agent.localModel || tasmaniaStatus.modelName || 'default';
        // Strip /v1 suffix: Claude Code SDK appends /v1/messages itself
        const baseUrl = tasmaniaStatus.endpoint!.replace(/\/v1\/?$/, '');
        tasmaniaEnv = {
          ANTHROPIC_BASE_URL: baseUrl,
          ANTHROPIC_MODEL: localModel,
          CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
        };
      } else {
        console.warn(`Agent ${agent.id} is local provider but Tasmania is not running. PTY created without Tasmania env vars`);
      }
    } catch (err) {
      console.warn(`Failed to get Tasmania status for agent ${agent.id}:`, err);
    }
  }

  // Get provider-specific env vars. Pass loaded savedSettings so alt
  // providers (OpenRouter, DeepSeek, etc.) can inject ANTHROPIC_BASE_URL
  // and ANTHROPIC_API_KEY from the configured API keys.
  const agentProvider = getProvider(agent.provider);
  const providerEnvVars = agentProvider.getPtyEnvVars(
    agent.id,
    agent.projectPath,
    agent.skills,
    savedSettings as unknown as AppSettings,
  );

  const ptyProcess = spawnAgentPty({
    binaryName: agentProvider.binaryName,
    shell,
    args: ['-l'],
    cols: 120,
    rows: 30,
    cwd,
    env: {
      ...process.env as { [key: string]: string },
      PATH: fullPath,
      ...providerEnvVars,
      // Which Tars the bundled MCP servers call back into. They default to
      // 127.0.0.1:31415, and nothing set this, so an app started on another
      // port (DOROTHY_API_PORT, the sandbox, or a second install running
      // beside the first) had its agents delegating into whichever app owned
      // 31415 instead of their own.
      CLAUDE_MGR_API_URL: `http://127.0.0.1:${API_PORT}`,
      // Load CLAUDE.md from --add-dir directories (e.g. ~/.dorothy)
      CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD: '1',
      ...tasmaniaEnv,
    },
  });

  const ptyId = uuidv4();
  ptyProcesses.set(ptyId, ptyProcess);
  agent.ptyCwd = cwd;

  ptyProcess.onData((data) => {
    const agentData = agents.get(agent.id);
    if (agentData) {
      appendAgentOutput(agentData, data);
      agentData.lastActivity = new Date().toISOString();
      agentData.statusLine = extractStatusLine(agentData.output);

      if (superAgentTelegramTask && isSuperAgent(agentData)) {
        superAgentOutputBuffer.push(data);
        if (superAgentOutputBuffer.length > 200) {
          superAgentOutputBuffer = superAgentOutputBuffer.slice(-100);
        }
      }
    }
    broadcastToAllWindows('agent:output', {
      type: 'output',
      agentId: agent.id,
      ptyId,
      data,
      timestamp: new Date().toISOString(),
    });
    scheduleTick();
  });

  ptyProcess.onExit(({ exitCode }) => {
    console.log(`Agent ${agent.id} PTY exited with code ${exitCode}`);
    const agentData = agents.get(agent.id);
    // Guard: only mutate if this PTY is still the active one (prevents race on restart/stop)
    if (agentData && agentData.ptyId === ptyId) {
      const newStatus = exitCode === 0 ? 'completed' : 'error';
      agentData.status = newStatus;
      agentData.lastActivity = new Date().toISOString();
      handleStatusChangeNotificationCallback(agentData, newStatus);
      saveAgentsCallback();
    }
    ptyProcesses.delete(ptyId);
    broadcastToAllWindows('agent:complete', {
      type: 'complete',
      agentId: agent.id,
      ptyId,
      exitCode,
      timestamp: new Date().toISOString(),
    });
    scheduleTick();
  });

  return ptyId;
}
