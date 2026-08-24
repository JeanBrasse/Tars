import * as path from 'path';
import * as fs from 'fs';
import * as pty from 'node-pty';
import { app } from 'electron';
import { v4 as uuidv4 } from 'uuid';
import { agents, saveAgents, killStalePty, ensureProjectTrusted, appendAgentOutput } from '../../core/agent-manager';
import { ptyProcesses, writeProgrammaticInput } from '../../core/pty-manager';
import { getProvider, isValidProvider } from '../../providers';
import { buildFullPath } from '../../utils/path-builder';
import { AgentStatus, AgentCharacter } from '../../types';
import { RouteApp, RouteContext, RouteRequest, SendJson } from './types';
import { getSuperAgentInstructionsPath } from '../../utils';
import { assembleDigest, needsPromptInjection, wrapDigestForPrompt } from '../memory-hub';
import { canDelegateOverAcp, delegateOverAcp } from '../acp/delegate';
import { usableHermesConnection } from '../hermes-config';
import { consumeResumeSessionId } from '../../utils/resume-session';
import { getTasmaniaStatus } from '../tasmania-client';

/**
 * The orchestrator instructions, or nothing for a regular agent. The UI start
 * path attached this file; the API path (every MCP delegate_task, start_agent
 * and send_message) did not, so an orchestrator driven by the MCP ran without
 * the rules that tell it to delegate rather than code.
 */
function orchestratorInstructionsFile(isOrchestrator: boolean | undefined): string | undefined {
  if (!isOrchestrator) return undefined;
  const file = getSuperAgentInstructionsPath();
  return fs.existsSync(file) ? file : undefined;
}

type SpawnOpts = {
  model?: string;
  permissionMode?: 'normal' | 'auto' | 'bypass';
  printMode?: boolean;
};

/**
 * Spawn a fresh one-shot claude PTY for `agent` with `prompt` as the task.
 *
 * Shared by /start, the /message reconnect path, and /dispatch so every entry
 * point gets identical behavior: skills prefix, MCP config for orchestrators,
 * model flag, orchestrator tool restrictions (BUG 5), trust pre-acceptance
 * (BUG 6), stale-PTY kill and ptyCwd invariant (BUG 4), and session-ownership
 * reset so hooks of the killed session can't flip the new task's status.
 *
 * Returns false if validation failed. An error response has already been sent.
 */
async function spawnAgentSession(
  agent: AgentStatus,
  prompt: string,
  opts: SpawnOpts,
  ctx: RouteContext,
  sendJson: SendJson
): Promise<boolean> {
  // Raw cwd for pty.spawn, shell-escaped form for the `cd` command. These
  // must be separate: passing the shell-escaped form to pty.spawn would
  // break when the path legitimately contains a single quote.
  const rawWorkingDir = agent.worktreePath || agent.projectPath;
  const workingDir = rawWorkingDir.replace(/'/g, "'\\''");

  // Resolve provider and binary: honours the per-agent CLI override, custom
  // CLI paths in Settings, and the agent's provider (claude / codex / gemini /
  // grok / openrouter / deepseek / moonshot / etc.).
  const appSettings = ctx.getAppSettings();
  const cliProvider = getProvider(agent.provider);
  const binaryPath = agent.cliPath || cliProvider.resolveBinaryPath(appSettings);

  const usePrintMode = opts.printMode;

  const isSuperAgentApi = agent.role === 'orchestrator' ||
                          agent.name?.toLowerCase().includes('super agent') ||
                          agent.name?.toLowerCase().includes('orchestrator');

  // Provider env vars: CLAUDE_* tracking vars + ANTHROPIC_BASE_URL /
  // ANTHROPIC_API_KEY for alt providers (OpenRouter, DeepSeek, Moonshot...).
  const providerEnvVars = cliProvider.getPtyEnvVars(agent.id, agent.projectPath, agent.skills || [], appSettings);

  // Alt providers re-point the claude binary at another vendor. Without a key
  // there is no ANTHROPIC_BASE_URL and the session would silently run on the
  // user's Anthropic account. Refuse instead.
  const isAltProvider = cliProvider.binaryName === 'claude' &&
                        !!agent.provider && agent.provider !== 'claude' && agent.provider !== 'local';
  if (isAltProvider && !providerEnvVars.ANTHROPIC_BASE_URL) {
    sendJson({
      error: `No API key configured for provider "${agent.provider}". Add it (or an OpenRouter key) in Settings > AI Providers.`,
    }, 400);
    return false;
  }

  // Local provider (Tasmania): point the claude binary at the local server,
  // mirroring initAgentPty. Reject cleanly when Tasmania isn't running.
  // Otherwise the session silently runs on Anthropic cloud.
  let tasmaniaEnv: Record<string, string> = {};
  if (agent.provider === 'local') {
    try {
      const tasmaniaStatus = await getTasmaniaStatus();
      if (tasmaniaStatus.status === 'running' && tasmaniaStatus.endpoint) {
        tasmaniaEnv = {
          // Strip /v1 suffix: Claude Code SDK appends /v1/messages itself
          ANTHROPIC_BASE_URL: tasmaniaStatus.endpoint.replace(/\/v1\/?$/, ''),
          ANTHROPIC_MODEL: agent.localModel || tasmaniaStatus.modelName || 'default',
          CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
        };
      } else {
        sendJson({ error: 'Local provider (Tasmania) is not running. Start it before dispatching to this agent.' }, 409);
        return false;
      }
    } catch (err) {
      sendJson({ error: `Local provider (Tasmania) unavailable: ${err instanceof Error ? err.message : String(err)}` }, 409);
      return false;
    }
  }

  // Identity header: agents must know who they are without the orchestrator
  // having to explain it in every delegation ("les agents ne comprennent pas
  // qui ils sont"). The SessionStart bootstrap injection adds the full team
  // roster; this header guarantees the essentials even if hooks are absent.
  // (The provider builder handles the skills prefix itself.)
  const identityHeader =
    `[Tars: you are agent "${agent.name || agent.id}" (id ${agent.id}), ` +
    `${agent.role || 'worker'} of project ${agent.projectPath}` +
    (agent.worktreePath
      ? `, working in worktree ${agent.worktreePath}${agent.branchName ? ` (branch ${agent.branchName})` : ''}: stay inside this directory`
      : '') +
    `. Work autonomously without asking for confirmation and end with a clear report of your results` +
    (isSuperAgentApi ? '' : ': an orchestrator reads your final message') +
    `.]`;

  // MCP config for flag-strategy providers (all claude-based ones).
  let mcpConfigPath: string | undefined;
  if (cliProvider.getMcpConfigStrategy() === 'flag') {
    const candidate = path.join(app.getPath('home'), '.claude', 'mcp.json');
    if (fs.existsSync(candidate)) mcpConfigPath = candidate;
  }

  const resolvedModel = opts.model || agent.model;
  const effectiveMode = opts.permissionMode ?? agent.permissionMode ?? (agent.skipPermissions ? 'auto' : 'normal');


  // CLIs without Claude's SessionStart hook get the project's memory in the
  // prompt instead - otherwise those agents start knowing nothing.
  let memoryBlock = '';
  if (needsPromptInjection(cliProvider.configDir)) {
    try {
      const digest = await assembleDigest({
        projectPath: agent.projectPath,
        settings: appSettings as never,
        hermes: usableHermesConnection(),
        budgetMs: 3000,
      });
      const wrapped = wrapDigestForPrompt(digest);
      if (wrapped) memoryBlock = `\n\n${wrapped}`;
    } catch {
      // Memory is context, not a precondition: never block a start on it.
    }
  }

  // Build the CLI command through the provider so non-claude CLIs (codex,
  // gemini, grok, opencode, pi) get their own syntax instead of claude flags.
  let cliCommand: string;
  try {
    cliCommand = cliProvider.buildInteractiveCommand({
      resumeSessionId: consumeResumeSessionId(agent) ?? undefined,
      binaryPath,
      prompt: `${identityHeader}${memoryBlock}\n\n${prompt}`,
      model: resolvedModel && resolvedModel !== 'default' ? resolvedModel : undefined,
      permissionMode: effectiveMode,
      effort: agent.effort,
      secondaryProjectPath: agent.secondaryProjectPath,
      obsidianVaultPaths: agent.obsidianVaultPaths,
      mcpConfigPath,
      skills: agent.skills,
      // Without this an orchestrator restarted through the API or by another
      // orchestrator woke up with no orchestration rules and did the work
      // itself instead of delegating.
      systemPromptFile: orchestratorInstructionsFile(isSuperAgentApi),
      isSuperAgent: isSuperAgentApi,
      // BUG 5: orchestrator-mode agents cannot edit files directly.
      orchestratorMode: isSuperAgentApi || agent.orchestratorMode,
      verbose: appSettings.verboseModeEnabled,
      chrome: appSettings.chromeEnabled,
    });
  } catch (err) {
    sendJson({ error: err instanceof Error ? err.message : 'Invalid agent configuration' }, 400);
    return false;
  }

  // Print mode: inject -p right after the binary token.
  if (usePrintMode) {
    const binToken = `'${binaryPath.replace(/'/g, "'\\''")}'`;
    if (cliCommand.startsWith(binToken)) {
      cliCommand = `${binToken} -p${cliCommand.slice(binToken.length)}`;
    }
  }

  const command = `cd '${workingDir}' && ${cliCommand}`;

  const shell = '/bin/bash';
  // Include user-configured CLI dirs so non-claude binaries resolve too.
  const cliExtraPaths: string[] = [];
  const cliPaths = appSettings.cliPaths as unknown as Record<string, unknown> | undefined;
  if (cliPaths) {
    for (const key of ['claude', 'codex', 'gemini', 'grok', 'qwencode', 'opencode', 'pi', 'gws', 'gh', 'node']) {
      if (typeof cliPaths[key] === 'string' && cliPaths[key]) {
        cliExtraPaths.push(path.dirname(cliPaths[key] as string));
      }
    }
    if (Array.isArray(cliPaths.additionalPaths)) {
      cliExtraPaths.push(...(cliPaths.additionalPaths as string[]).filter(Boolean));
    }
  }
  const fullPath = buildFullPath(cliExtraPaths);

  // Kill any existing PTY for this agent before spawning a new one.
  // Agents started via the API use one-shot PTYs that stay alive (the claude
  // process waits at a prompt after each task). Without this, every dispatch
  // orphans the previous PTY+claude process, eventually exhausting resources.
  if (agent.ptyId) {
    const existingPty = ptyProcesses.get(agent.ptyId);
    if (existingPty) {
      existingPty.kill();
      ptyProcesses.delete(agent.ptyId);
    }
  }
  // Tombstone the killed session: its hook scripts (separate processes that
  // survive the PTY kill) may still POST status/output for several seconds.
  // Without this, the session-adoption fallback in hooks-routes would adopt
  // the dead session during the window before the new SessionStart registers.
  if (agent.currentSessionId) {
    agent.lastKilledSessionId = agent.currentSessionId;
  }

  // BUG 6: pre-accept Claude Code's workspace trust dialog for this cwd.
  ensureProjectTrusted(rawWorkingDir);

  // Assemble the environment. Identity vars are re-asserted explicitly
  // (MCP project scoping and the hooks depend on them), and provider-specified
  // vars (e.g. CLAUDECODE) are purged so nested sessions don't inherit them.
  const spawnEnv: Record<string, string | undefined> = {
    ...process.env,
    PATH: fullPath,
    TERM: 'xterm-256color',
    ...providerEnvVars,
    ...tasmaniaEnv,
    CLAUDE_SKILLS: agent.skills?.join(',') || '',
    CLAUDE_AGENT_ID: agent.id,
    CLAUDE_PROJECT_PATH: agent.projectPath,
    // Load CLAUDE.md from --add-dir directories (e.g. ~/.dorothy)
    CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD: '1',
  };
  for (const key of cliProvider.getEnvVarsToDelete()) {
    delete spawnEnv[key];
  }

  const ptyProcess = pty.spawn(shell, ['-l', '-c', command], {
    name: 'xterm-256color',
    cols: 120,
    rows: 40,
    cwd: rawWorkingDir,
    env: spawnEnv as { [key: string]: string },
  });

  const ptyId = uuidv4();
  ptyProcesses.set(ptyId, ptyProcess);

  agent.ptyId = ptyId;
  agent.ptyCwd = rawWorkingDir;
  agent.status = 'running';
  agent.currentTask = prompt;
  agent.output = [];
  agent.lastCleanOutput = undefined;  // Clear stale output from previous task
  agent.error = undefined;            // Clear previous error state
  agent.waitingReason = undefined;
  // The old session (if any) died with its PTY. The fresh claude session
  // re-registers itself via the SessionStart hook; clearing now lets the
  // hooks-routes stale-session guard reject in-flight posts from the killed
  // session that would otherwise flip this new task's status.
  agent.currentSessionId = undefined;
  agent.lastActivity = new Date().toISOString();
  saveAgents();

  ptyProcess.onData((data: string) => {
    appendAgentOutput(agent, data);
    if (agent.output.length > 10000) {
      agent.output = agent.output.slice(-5000);
    }
    agent.lastActivity = new Date().toISOString();

    if (ctx.mainWindow && !ctx.mainWindow.isDestroyed()) {
      ctx.mainWindow.webContents.send('agent:output', { agentId: agent.id, data });
    }
  });

  ptyProcess.onExit(({ exitCode }) => {
    // Remove from the live map IMMEDIATELY: node-pty write() on a dead PTY is
    // a silent no-op, so leaving it registered lets /dispatch and /message
    // "successfully" type a task into a corpse during the status-delay below.
    ptyProcesses.delete(ptyId);
    // Delay status change to let hooks (on-stop.sh, task-completed.sh) finish
    // capturing output before wait_for_agent resolves.
    setTimeout(() => {
      // Guard: only mutate if this PTY is still the active one, since a newer
      // dispatch may have replaced it during the delay.
      if (agent.ptyId !== ptyId) {
        return;
      }
      if (agent.status === 'running') {
        agent.status = exitCode === 0 ? 'completed' : 'error';
      } else if (agent.status === 'waiting') {
        // PTY exited while agent was waiting for input: the claude process
        // crashed. Mark as error so /wait is unblocked and the orchestrator
        // can retry rather than hanging until timeout.
        agent.status = 'error';
        agent.waitingReason = undefined;
      }
      if (exitCode !== 0) {
        agent.error = `Process exited with code ${exitCode}`;
      }
      agent.lastActivity = new Date().toISOString();
      saveAgents();
      ctx.agentStatusEmitter.emit(`status:${agent.id}`);
    }, 1500);
  });

  return true;
}

/** Serializable agent projection for API responses: excludes the raw ANSI
 *  `output` buffer (up to 10 000 chunks), which destroys LLM context windows
 *  when returned to MCP callers. Use /output or ?full=true when needed. */
function projectAgent(agent: AgentStatus) {
  const { output, ...rest } = agent;
  return { ...rest, outputChunks: output.length };
}

/** Project path of the calling agent, injected as a header by the MCP client
 *  from its PTY environment. Absent for the UI and other local callers.
 *
 *  Two names on purpose. The MCP client was renamed to send `X-Tars-Caller-*`
 *  while this reader still expected `x-dorothy-caller-project`; the bundles on
 *  disk predate the rename, so it worked by accident and would have broken the
 *  moment anyone rebuilt them - project scoping would have silently switched
 *  off, and every guarded route would 403. Accepting both is what makes the
 *  rename safe in either order. The old name can go once no shipped bundle
 *  sends it. */
function callerHeader(req: RouteRequest, suffix: 'project' | 'id'): string | undefined {
  const headers = req.raw?.headers;
  const value = headers?.[`x-tars-caller-${suffix}`] ?? headers?.[`x-dorothy-caller-${suffix}`];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function callerProject(req: RouteRequest): string | undefined {
  return callerHeader(req, 'project');
}

/**
 * Cross-project guard: an orchestrator may only act on agents of its own
 * project. This is what stops an orchestrator from delegating to another
 * project's agents when the LLM picks a wrong ID from a global listing.
 * Callers without identity headers (UI, curl) are unrestricted, and a caller
 * can explicitly override with allowCrossProject: true.
 */
function assertSameProject(req: RouteRequest, agent: AgentStatus, sendJson: SendJson): boolean {
  const caller = callerProject(req);

  // An agent's MCP always announces itself. If it does so without an identity
  // its calls cannot be scoped, and defaulting to "allow" would let it drive
  // every project's agents - which is the confusion this guard exists to stop.
  if (!caller && req.raw?.headers?.['x-tars-client'] === 'mcp') {
    sendJson({
      error: 'This agent has no identity, so its calls cannot be scoped to a project. '
        + 'Restart the agent from Tars so it is spawned with CLAUDE_AGENT_ID and CLAUDE_PROJECT_PATH.',
    }, 403);
    return false;
  }

  if (!caller || agent.projectPath === caller) return true;
  if ((req.body as { allowCrossProject?: boolean } | undefined)?.allowCrossProject === true) return true;
  // DELETE requests have no parsed body. Accept the override as a query param.
  if (req.url.searchParams.get('allowCrossProject') === 'true') return true;
  sendJson({
    error: `Cross-project access denied: agent "${agent.name || agent.id}" belongs to project ${agent.projectPath}, but you are the orchestrator of ${caller}. Use list_agents to see YOUR project's agents, or pass allowCrossProject: true if this is intentional.`,
  }, 403);
  return false;
}

/**
 * Serializes everything that reads-then-mutates one agent's live-session
 * state (ptyId, status) so two callers deciding "message vs spawn" for the
 * same agent at once can't both observe "no live session" and both spawn a
 * fresh PTY.
 *
 * The race is real, not theoretical: spawnAgentSession awaits the memory
 * digest for every non-Claude CLI (needsPromptInjection), which is a genuine
 * suspension point. Two orchestrators (or one orchestrator retried by a
 * caller) dispatching to the same idle agent within that window each pass
 * the "no live PTY" check before either has set agent.ptyId, so both spawn -
 * the second silently orphans the first's process and only the second
 * survives in the agent record. A resolved-promise-only await (the Claude
 * path) never yields far enough for this to happen, which is why it went
 * unnoticed: it only bites non-Claude agents.
 */
const agentDispatchLocks = new Map<string, Promise<unknown>>();

async function withAgentLock<T>(agentId: string, fn: () => Promise<T>): Promise<T> {
  const prior = agentDispatchLocks.get(agentId) ?? Promise.resolve();
  const run = prior.then(fn, fn);
  // Chain for the next caller regardless of outcome; a failed dispatch must
  // not wedge the queue for agents that dispatch to this id afterward.
  agentDispatchLocks.set(agentId, run.catch(() => undefined));
  return run;
}

/**
 * Core of the atomic dispatch: message a live session or spawn a fresh one,
 * decided server-side. Shared by POST /api/agents/:id/dispatch and the Hermes
 * webhook so both entry points get identical semantics.
 */
export async function performDispatch(
  agent: AgentStatus,
  opts: { message: string; model?: string; permissionMode?: 'normal' | 'auto' | 'bypass' },
  ctx: RouteContext,
  sendJson: SendJson,
): Promise<void> {
  return withAgentLock(agent.id, () => performDispatchLocked(agent, opts, ctx, sendJson));
}

async function performDispatchLocked(
  agent: AgentStatus,
  opts: { message: string; model?: string; permissionMode?: 'normal' | 'auto' | 'bypass' },
  ctx: RouteContext,
  sendJson: SendJson,
): Promise<void> {
  // BUG 4 guard: kill the PTY if its cwd no longer matches the agent's
  // worktree so the spawn path below restarts it in the right directory.
  killStalePty(agent);

  const previousStatus = agent.status;
  const livePty = agent.ptyId ? ptyProcesses.get(agent.ptyId) : undefined;
  if (livePty && agent.status === 'waiting' && agent.waitingReason === 'permission') {
    // A blocking permission dialog expects arrow keys/enter, not text: a
    // typed message is useless and the delayed \r could ACCEPT the pending
    // permission. Refuse and surface the reason instead.
    sendJson({
      error: `Agent "${agent.name || agent.id}" is blocked on a permission dialog; a typed message cannot answer it. Resolve it in the Tars UI, or stop the agent and re-dispatch.`,
      waitingReason: 'permission',
    }, 409);
    return;
  }
  if (livePty && (agent.status === 'running' || agent.status === 'waiting')) {
    // Live claude session mid-task or at a prompt: type the message into it.
    writeProgrammaticInput(livePty, opts.message, true);
    agent.status = 'running';
    agent.waitingReason = undefined;
    // This message starts a new piece of work in the same session; the
    // previous task's captured output must not be mistaken for its result.
    agent.lastCleanOutput = undefined;
    agent.lastActivity = new Date().toISOString();
    saveAgents();
    sendJson({ success: true, mode: 'message', previousStatus, agent: { id: agent.id, name: agent.name, status: agent.status } });
    return;
  }

  // No usable session: spawn a fresh one with the message as the prompt.
  if (!(await spawnAgentSession(agent, opts.message, { model: opts.model, permissionMode: opts.permissionMode }, ctx, sendJson))) {
    return;
  }
  sendJson({ success: true, mode: 'start', previousStatus, agent: { id: agent.id, name: agent.name, status: agent.status } });
}

export function registerAgentRoutes(app_: RouteApp, ctx: RouteContext): void {
  // GET /api/agents/:id/wait: long-poll until agent status changes
  app_.get(/^\/api\/agents\/([^/]+)\/wait$/, (req, sendJson) => {
    const agent = agents.get(req.params.id);
    if (!agent) {
      sendJson({ error: 'Agent not found' }, 404);
      return;
    }

    const timeoutSec = parseInt(req.url.searchParams.get('timeout') || '300', 10);
    const currentStatus = agent.status;

    // Return immediately if already in terminal state
    if (currentStatus === 'completed' || currentStatus === 'error' || currentStatus === 'idle' || currentStatus === 'waiting') {
      sendJson({
        status: agent.status,
        lastCleanOutput: agent.lastCleanOutput,
        error: agent.error,
        waitingReason: agent.waitingReason,
      });
      return;
    }

    // Long-poll: wait for status change event
    const agentId = req.params.id;
    let resolved = false;

    const cleanup = () => {
      clearTimeout(timeout);
      ctx.agentStatusEmitter.off(`status:${agentId}`, onStatusChange);
    };

    const respond = () => {
      if (resolved) return;
      resolved = true;
      cleanup();
      const a = agents.get(agentId);
      sendJson({
        status: a?.status || 'idle',
        lastCleanOutput: a?.lastCleanOutput,
        error: a?.error,
        waitingReason: a?.waitingReason,
      });
    };

    const onStatusChange = () => respond();
    ctx.agentStatusEmitter.on(`status:${agentId}`, onStatusChange);

    const timeout = setTimeout(() => {
      if (!resolved) {
        resolved = true;
        ctx.agentStatusEmitter.off(`status:${agentId}`, onStatusChange);
        const a = agents.get(agentId);
        sendJson({
          status: a?.status || 'running',
          lastCleanOutput: a?.lastCleanOutput,
          timeout: true,
        });
      }
    }, timeoutSec * 1000);

    // Clean up if client disconnects
    req.raw.on('close', () => {
      if (!resolved) {
        resolved = true;
        cleanup();
      }
    });
  });

  // GET /api/agents: scoped to the caller's project by default (?all=true
  // for the global view). An orchestrator that only ever SEES its own team
  // cannot pick another project's agent ID by mistake.
  app_.get('/api/agents', (req, sendJson) => {
    const caller = callerProject(req);
    const showAll = req.url.searchParams.get('all') === 'true';
    let agentValues = Array.from(agents.values());
    if (caller && !showAll) {
      agentValues = agentValues.filter(a => a.projectPath === caller);
    }
    const agentList = agentValues.map(a => ({
      id: a.id,
      name: a.name,
      status: a.status,
      projectPath: a.projectPath,
      secondaryProjectPath: a.secondaryProjectPath,
      skills: a.skills,
      currentTask: a.currentTask,
      lastActivity: a.lastActivity,
      character: a.character,
      branchName: a.branchName,
      role: a.role,
      error: a.error,
    }));
    sendJson({ agents: agentList, scopedToProject: caller && !showAll ? caller : undefined });
  });

  // GET /api/agents/:id
  app_.get(/^\/api\/agents\/([^/]+)$/, (req, sendJson) => {
    const agent = agents.get(req.params.id);
    if (!agent) {
      sendJson({ error: 'Agent not found' }, 404);
      return;
    }
    const full = req.url.searchParams.get('full') === 'true';
    sendJson({ agent: full ? agent : projectAgent(agent) });
  });

  // GET /api/agents/:id/bootstrap: identity + team roster context, injected
  // into every fresh claude session by session-start.sh. This is what makes
  // the "who am I / who is my team" handshake automatic instead of a manual
  // ritual at the start of every working session.
  app_.get(/^\/api\/agents\/([^/]+)\/bootstrap$/, (req, sendJson) => {
    const agent = agents.get(req.params.id);
    if (!agent) {
      sendJson({ error: 'Agent not found' }, 404);
      return;
    }

    const isOrchestrator = agent.role === 'orchestrator' ||
                           agent.name?.toLowerCase().includes('super agent') ||
                           agent.name?.toLowerCase().includes('orchestrator');

    const teammates = Array.from(agents.values())
      .filter(a => a.projectPath === agent.projectPath && a.id !== agent.id)
      .map(a => `- "${a.name || a.id}" (id: ${a.id}): ${a.role || 'worker'}, status: ${a.status}` +
                (a.branchName ? `, branch: ${a.branchName}` : '') +
                (a.skills?.length ? `, skills: ${a.skills.join(', ')}` : ''));

    const lines = [
      `# Tars agent identity`,
      ``,
      `You are "${agent.name || agent.id}" (agent id: ${agent.id}), ${agent.role || 'worker'} of project ${agent.projectPath}.`,
    ];
    if (agent.worktreePath) {
      lines.push(`You work in the worktree ${agent.worktreePath}${agent.branchName ? ` (branch ${agent.branchName})` : ''}: stay inside this directory.`);
    }
    if (agent.savedPrompt) {
      lines.push(``, `## Your role`, agent.savedPrompt);
    }
    lines.push(``, `## Your team (project ${agent.projectPath})`);
    lines.push(teammates.length ? teammates.join('\n') : '(no other agents in this project)');
    if (isOrchestrator) {
      lines.push(
        ``,
        `## Orchestration rules`,
        `- Delegate ONLY to the agents listed above: they are your project's team. Other projects' agents are off-limits and the API rejects cross-project actions.`,
        `- Use delegate_task with the agent id for one-shot delegation; list_agents already returns only your project's agents.`,
        `- No greeting ritual is needed: this roster is current as of session start, and each agent receives its own identity automatically when you delegate.`
      );
    } else {
      lines.push(
        ``,
        `## Working rules`,
        `- You may receive tasks from your project's orchestrator. Work autonomously, never ask for confirmation, and end with a clear report: the orchestrator reads your final message.`
      );
    }

    sendJson({ context: lines.join('\n') });
  });

  // GET /api/agents/:id/health: liveness of the agent's PTY and session,
  // so orchestrators/tools can distinguish "working" from "ghost status".
  app_.get(/^\/api\/agents\/([^/]+)\/health$/, (req, sendJson) => {
    const agent = agents.get(req.params.id);
    if (!agent) {
      sendJson({ error: 'Agent not found' }, 404);
      return;
    }
    const ptyAlive = !!(agent.ptyId && ptyProcesses.has(agent.ptyId));
    const lastActivityMs = Date.parse(agent.lastActivity || '') || 0;
    sendJson({
      id: agent.id,
      status: agent.status,
      waitingReason: agent.waitingReason,
      ptyAlive,
      hasLiveSession: !!agent.currentSessionId,
      secondsSinceActivity: lastActivityMs ? Math.round((Date.now() - lastActivityMs) / 1000) : null,
    });
  });

  // GET /api/agents/:id/output
  app_.get(/^\/api\/agents\/([^/]+)\/output$/, (req, sendJson) => {
    const agent = agents.get(req.params.id);
    if (!agent) {
      sendJson({ error: 'Agent not found' }, 404);
      return;
    }
    const lines = parseInt(req.url.searchParams.get('lines') || '100', 10);
    const output = agent.output.slice(-lines).join('');
    sendJson({ output, status: agent.status });
  });

  // POST /api/agents
  app_.post('/api/agents', (req, sendJson) => {
    const { projectPath, name, skills = [], character, permissionMode, secondaryProjectPath, orchestratorMode, provider, model, effort, cliPath } = req.body as {
      projectPath: string;
      name?: string;
      skills?: string[];
      character?: AgentCharacter;
      permissionMode?: 'normal' | 'auto' | 'bypass';
      secondaryProjectPath?: string;
      orchestratorMode?: boolean;
      provider?: string;
      model?: string;
      effort?: 'low' | 'medium' | 'high' | 'xhigh' | 'max';
      cliPath?: string;
    };

    if (!projectPath) {
      sendJson({ error: 'projectPath is required' }, 400);
      return;
    }
    if (provider !== undefined && !isValidProvider(provider)) {
      sendJson({ error: `Unknown provider "${provider}"` }, 400);
      return;
    }
    if (model !== undefined && !/^[a-zA-Z0-9._:\/\[\]-]+$/.test(model)) {
      sendJson({ error: 'Invalid model name' }, 400);
      return;
    }
    if (effort !== undefined && !['low', 'medium', 'high', 'xhigh', 'max'].includes(effort)) {
      sendJson({ error: 'Invalid effort level' }, 400);
      return;
    }

    const id = uuidv4();
    const resolvedName = name || `Agent ${id.slice(0, 6)}`;
    const lowerName = resolvedName.toLowerCase();
    const agent: AgentStatus = {
      id,
      status: 'idle',
      projectPath,
      secondaryProjectPath,
      skills,
      output: [],
      lastActivity: new Date().toISOString(),
      character,
      name: resolvedName,
      permissionMode: permissionMode || 'auto',
      orchestratorMode: orchestratorMode || false,
      provider: provider as AgentStatus['provider'],
      model,
      effort,
      cliPath,
      // role mirrors the historical name-based isSuperAgent semantics.
      // orchestratorMode stays an independent tool-restriction toggle. It
      // must NOT promote an agent into the Telegram/Slack super-agent pool.
      role: (lowerName.includes('super agent') || lowerName.includes('orchestrator'))
        ? 'orchestrator'
        : 'worker',
    };
    agents.set(id, agent);
    saveAgents();
    sendJson({ agent });
  });

  // POST /api/agents/:id/start
  app_.post(/^\/api\/agents\/([^/]+)\/start$/, async (req, sendJson) => {
    const agent = agents.get(req.params.id);
    if (!agent) {
      sendJson({ error: 'Agent not found' }, 404);
      return;
    }

    if (!assertSameProject(req, agent, sendJson)) return;

    const { prompt, model, permissionMode: bodyPermissionMode, printMode } = req.body as {
      prompt: string; model?: string; permissionMode?: 'normal' | 'auto' | 'bypass'; printMode?: boolean;
    };
    if (!prompt) {
      sendJson({ error: 'prompt is required' }, 400);
      return;
    }

    const spawned = await withAgentLock(agent.id, () =>
      spawnAgentSession(agent, prompt, { model, permissionMode: bodyPermissionMode, printMode }, ctx, sendJson));
    if (!spawned) return;

    sendJson({ success: true, agent: { id: agent.id, status: agent.status } });
  });

  // POST /api/agents/:id/dispatch: atomic "send this task to the agent".
  // Decides message-vs-spawn server-side, under the single-threaded event
  // loop, eliminating the GET-status-then-POST race that MCP tools had when
  // they made that decision client-side on stale status.
  app_.post(/^\/api\/agents\/([^/]+)\/dispatch$/, async (req, sendJson) => {
    const agent = agents.get(req.params.id);
    if (!agent) {
      sendJson({ error: 'Agent not found' }, 404);
      return;
    }

    if (!assertSameProject(req, agent, sendJson)) return;

    const { message, model, permissionMode } = req.body as {
      message: string; model?: string; permissionMode?: 'normal' | 'auto' | 'bypass';
    };
    if (!message) {
      sendJson({ error: 'message is required' }, 400);
      return;
    }

    await performDispatch(agent, { message, model, permissionMode }, ctx, sendJson);
  });

  /**
   * POST /api/agents/:id/run-task
   *
   * Delegation with a receipt. Where /dispatch types a message into the
   * target's terminal and returns before the agent has even read it, this runs
   * the task over the Agent Client Protocol and answers with what the agent
   * actually did: its reply, why the turn ended, which tools it used and what
   * the turn cost. Works on every CLI with an ACP mode.
   */
  app_.post(/^\/api\/agents\/([^/]+)\/run-task$/, async (req, sendJson) => {
    const agent = agents.get(req.params.id);
    if (!agent) {
      sendJson({ error: 'Agent not found' }, 404);
      return;
    }
    if (!assertSameProject(req, agent, sendJson)) return;

    const { task, timeoutSeconds } = req.body as { task?: string; timeoutSeconds?: number };
    if (!task?.trim()) {
      sendJson({ error: 'task is required' }, 400);
      return;
    }

    if (!canDelegateOverAcp(agent)) {
      sendJson({ error: `${agent.provider ?? 'this provider'} has no ACP mode; use /dispatch`, retryWithDispatch: true }, 409);
      return;
    }

    const wasStatus = agent.status;
    agent.status = 'running';
    agent.currentTask = task.slice(0, 100);
    agent.lastActivity = new Date().toISOString();
    // Per-agent channel, not a bare 'status': /wait subscribes with
    // `status:${agentId}` (see the .on below), so an emit on 'status' reached
    // nobody and a caller waiting on this agent hung until its timeout.
    ctx.agentStatusEmitter.emit(`status:${agent.id}`);

    const result = await delegateOverAcp({
      agent,
      task,
      appSettings: ctx.getAppSettings(),
      isOrchestrator: agent.role === 'orchestrator',
      timeoutMs: Math.min(Math.max((timeoutSeconds ?? 900) * 1000, 30_000), 3_600_000),
    });

    agent.status = result.ok ? 'idle' : wasStatus === 'running' ? 'idle' : wasStatus;
    agent.lastActivity = new Date().toISOString();
    if (result.text) agent.lastCleanOutput = result.text.slice(-8000);
    saveAgents();
    ctx.agentStatusEmitter.emit(`status:${agent.id}`);

    sendJson(result, result.ok ? 200 : 502);
  });

  // POST /api/agents/:id/stop
  app_.post(/^\/api\/agents\/([^/]+)\/stop$/, (req, sendJson) => {
    const agent = agents.get(req.params.id);
    if (!agent) {
      sendJson({ error: 'Agent not found' }, 404);
      return;
    }

    if (!assertSameProject(req, agent, sendJson)) return;

    if (agent.ptyId) {
      const ptyProcess = ptyProcesses.get(agent.ptyId);
      if (ptyProcess) {
        ptyProcess.kill();
        ptyProcesses.delete(agent.ptyId);
      }
    }
    agent.status = 'idle';
    agent.currentTask = undefined;
    agent.waitingReason = undefined;
    // Tombstone the stopped session so its in-flight hooks can't resurrect
    // status/output after the stop.
    if (agent.currentSessionId) {
      agent.lastKilledSessionId = agent.currentSessionId;
    }
    agent.currentSessionId = undefined;
    agent.lastActivity = new Date().toISOString();
    saveAgents();
    ctx.agentStatusEmitter.emit(`status:${agent.id}`);
    sendJson({ success: true });
  });

  // POST /api/agents/:id/message
  app_.post(/^\/api\/agents\/([^/]+)\/message$/, async (req, sendJson) => {
    const agent = agents.get(req.params.id);
    if (!agent) {
      sendJson({ error: 'Agent not found' }, 404);
      return;
    }

    if (!assertSameProject(req, agent, sendJson)) return;

    const { message } = req.body as { message: string };
    if (!message) {
      sendJson({ error: 'message is required' }, 400);
      return;
    }

    await withAgentLock(agent.id, async () => {
      // BUG 4 guard: if the agent's worktreePath changed after the PTY was
      // spawned, the existing PTY is stuck in the wrong cwd. Kill it so the
      // reconnect path below spawns fresh with the correct working directory.
      killStalePty(agent);

      if (agent.ptyId && ptyProcesses.has(agent.ptyId) &&
          agent.status === 'waiting' && agent.waitingReason === 'permission') {
        // Same guard as /dispatch: never type into a blocking permission dialog.
        sendJson({
          error: `Agent "${agent.name || agent.id}" is blocked on a permission dialog; a typed message cannot answer it. Resolve it in the Tars UI, or stop the agent and re-dispatch.`,
          waitingReason: 'permission',
        }, 409);
        return;
      }

      if (!agent.ptyId || !ptyProcesses.has(agent.ptyId)) {
        // No live PTY: the claude process exited (e.g. crashed while 'waiting').
        // Auto-respawn: start a fresh one-shot claude session using the message
        // as the prompt, identical to the /start path.  This ensures send_message
        // and delegate_task reconnect transparently instead of timing out.
        if (!(await spawnAgentSession(agent, message, {}, ctx, sendJson))) {
          return;
        }
        sendJson({ success: true });
        return;
      }

      const ptyProcess = ptyProcesses.get(agent.ptyId);
      if (ptyProcess) {
        writeProgrammaticInput(ptyProcess, message, true);
        agent.status = 'running';
        agent.waitingReason = undefined;
        agent.lastActivity = new Date().toISOString();
        saveAgents();
        sendJson({ success: true });
        return;
      }
      sendJson({ error: 'Failed to send message - PTY not available' }, 500);
    });
  });

  // DELETE /api/agents/:id
  app_.delete(/^\/api\/agents\/([^/]+)$/, (req, sendJson) => {
    const agent = agents.get(req.params.id);
    if (!agent) {
      sendJson({ error: 'Agent not found' }, 404);
      return;
    }

    if (!assertSameProject(req, agent, sendJson)) return;

    if (agent.ptyId) {
      const ptyProcess = ptyProcesses.get(agent.ptyId);
      if (ptyProcess) {
        ptyProcess.kill();
        ptyProcesses.delete(agent.ptyId);
      }
    }
    agents.delete(req.params.id);
    saveAgents();
    sendJson({ success: true });
  });
}
