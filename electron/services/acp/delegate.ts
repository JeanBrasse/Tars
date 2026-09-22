import * as path from 'path';
import { AcpSession, type TurnResult } from './client';
import { acpLaunchFor, loadAcpRegistry } from './registry';
import { getMcpOrchestratorPath, getMcpMemoryPath } from '../mcp-orchestrator';
import { getProvider } from '../../providers';
import { safeEffort } from '../../providers/cli-provider';
import type { AgentStatus, AppSettings } from '../../types';
import * as fs from 'fs';
import { recordUsage } from '../usage-ledger';
import { mintRunToken } from '../../core/agent-tokens';
import { buildFullPath } from '../../utils/path-builder';
import { cliPathDirs } from '../../utils/cli-path-dirs';
import { API_PORT } from '../../constants';

/**
 * Running a delegated task over ACP instead of typing it into a terminal.
 *
 * The difference that matters: this returns. The caller gets the agent's
 * answer, why the turn ended, which tools it used and what the turn cost,
 * for any CLI that speaks the protocol, not just for Claude.
 */

export interface DelegationResult {
  ok: boolean;
  transport: 'acp';
  stopReason?: string;
  text: string;
  toolCalls: string[];
  usage?: { inputTokens?: number; outputTokens?: number; totalTokens?: number };
  costUSD?: number;
  error?: string;
}

/** This Tars, for the child to call back on. The constant, not the live
 *  socket: the server retries the same port and never moves to another. */
function apiUrl(): string {
  return `http://127.0.0.1:${API_PORT}`;
}

/** Tools an orchestrator must not use itself, whatever CLI it runs. */
const ORCHESTRATOR_DENY = ['write', 'edit', 'create file', 'multiedit', 'notebook'];

function mcpServersFor(agent: AgentStatus, apiToken: string): { name: string; command: string; args: string[]; env: { name: string; value: string }[] }[] {
  // Handed over by name, since a CLI may start these servers with this list
  // and nothing else. The token is what the API takes the caller from; the id
  // alone would make every call from this run nobody's.
  const env = [
    { name: 'CLAUDE_AGENT_ID', value: agent.id },
    { name: 'CLAUDE_PROJECT_PATH', value: agent.projectPath },
    { name: 'CLAUDE_MGR_API_TOKEN', value: apiToken },
    // Which Tars to call back. These servers get the list below and nothing
    // else, and mcp-orchestrator falls back to 31415 without it.
    { name: 'CLAUDE_MGR_API_URL', value: apiUrl() },
  ];

  const servers: { name: string; command: string; args: string[]; env: typeof env }[] = [];
  for (const [name, serverPath] of [
    ['tars-memory', getMcpMemoryPath()],
    ['claude-mgr-orchestrator', getMcpOrchestratorPath()],
  ] as const) {
    if (fs.existsSync(serverPath)) {
      servers.push({ name, command: 'node', args: [serverPath], env });
    }
  }
  return servers;
}

export function canDelegateOverAcp(agent: AgentStatus): boolean {
  return !!acpLaunchFor(agent.provider ?? 'claude');
}

/**
 * Runs one task to completion. The session lives for the task and is torn
 * down after: a delegated task is a unit of work, not a conversation.
 */
export async function delegateOverAcp(opts: {
  agent: AgentStatus;
  task: string;
  appSettings: AppSettings;
  isOrchestrator?: boolean;
  timeoutMs?: number;
  onEvent?: (event: { type: string; payload: unknown }) => void;
}): Promise<DelegationResult> {
  const { agent, task, appSettings, isOrchestrator, onEvent } = opts;

  await loadAcpRegistry().catch(() => undefined);
  const launch = acpLaunchFor(agent.provider ?? 'claude');
  if (!launch) {
    return { ok: false, transport: 'acp', text: '', toolCalls: [], error: 'provider has no ACP mode' };
  }

  const cwd = agent.worktreePath || agent.projectPath;
  if (!cwd || !fs.existsSync(cwd)) {
    return { ok: false, transport: 'acp', text: '', toolCalls: [], error: `working directory is missing: ${cwd}` };
  }

  const provider = getProvider(agent.provider ?? 'claude');
  // This run's own token. spawnAgentPty, which gives a terminal its token, is
  // not on this path, and without one the run's MCP servers would fall back to
  // the shared token, on which a call has no agent behind it: no room on the
  // bus, no delegation onward. Its own rather than the terminal's, so that
  // neither can cut the other off, and revoked when the run is over.
  const { token: apiToken, revoke } = mintRunToken(agent.id);
  const session = new AcpSession(launch, {
    cwd,
    env: {
      // The PATH every other launch of the main process gets, the folders set
      // in Settings > CLI Paths first. Without it the launch had the app's own,
      // and an app opened from the Dock has launchd's, where npx is not: the
      // "spawn npx ENOENT" of 2026-09-18. The agent inherits it too, which is
      // how npx finds node and the agent finds its MCP servers' node.
      PATH: buildFullPath(cliPathDirs(appSettings.cliPaths)),
      ...provider.getPtyEnvVars(agent.id, agent.projectPath, agent.skills ?? [], appSettings),
      CLAUDE_AGENT_ID: agent.id,
      CLAUDE_PROJECT_PATH: agent.projectPath,
      CLAUDE_MGR_API_TOKEN: apiToken,
      // Which Tars this run answers to, as spawnAgentPty gives every terminal
      // (agent-pty.ts). It was missing here, so the hooks of an ACP run posted
      // to 31415 whatever port this Tars was on: three posts from a sandbox on
      // 31493 reached the live app and were refused as `Agent not found`.
      // Nothing was written, but the port stopped being the boundary it is
      // everywhere else.
      CLAUDE_MGR_API_URL: apiUrl(),
    },
    mcpServers: mcpServersFor(agent, apiToken),
    permissionMode: agent.permissionMode === 'bypass' ? 'bypass'
      : agent.permissionMode === 'auto' ? 'auto' : 'normal',
    // An orchestrator delegates; it does not edit. Enforced here by the
    // protocol rather than by a flag only one CLI understands.
    denyTools: isOrchestrator || agent.orchestratorMode ? ORCHESTRATOR_DENY : undefined,
  });

  if (onEvent) {
    session.on('text', chunk => onEvent({ type: 'text', payload: chunk }));
    session.on('tool', tool => onEvent({ type: 'tool', payload: tool }));
    session.on('plan', plan => onEvent({ type: 'plan', payload: plan }));
    session.on('permission', p => onEvent({ type: 'permission', payload: p }));
  }

  try {
    await session.start();
    // The agent's own model and effort. A launch in a terminal puts them on the
    // command line; this one has none, so the session is configured once open,
    // through the options the agent offers, model first because the effort
    // levels on offer depend on the model. Without this every delegation ran
    // on the adapter's default model and effort, whatever the agent was set to.
    const model = agent.model && agent.model !== 'default' ? agent.model : undefined;
    if (model && !(await session.setConfigOption('model', model))) {
      console.warn(`[acp] ${agent.name || agent.id}: this run is not on ${model}, the agent did not take it`);
    }
    const effort = safeEffort(agent.effort);
    if (effort && !(await session.setConfigOption('effort', effort))) {
      console.warn(`[acp] ${agent.name || agent.id}: this run is not at ${effort} effort, the agent did not take it`);
    }
    const turn: TurnResult = await session.prompt(task, opts.timeoutMs);

    // Every provider reports its tokens over ACP, which is the only place
    // non-Claude usage can be captured at all.
    if (turn.usage || turn.costUSD != null) {
      recordUsage({
        agentId: agent.id,
        provider: agent.provider ?? 'claude',
        model: agent.model,
        inputTokens: turn.usage?.inputTokens ?? 0,
        outputTokens: turn.usage?.outputTokens ?? 0,
        cachedReadTokens: turn.usage?.cachedReadTokens,
        cachedWriteTokens: turn.usage?.cachedWriteTokens,
        costUSD: turn.costUSD,
        transport: 'acp',
      });
    }

    return {
      ok: turn.stopReason === 'end_turn',
      transport: 'acp',
      stopReason: turn.stopReason,
      text: turn.text,
      toolCalls: turn.toolCalls.map(t => t.title),
      usage: turn.usage,
      costUSD: turn.costUSD,
    };
  } catch (err) {
    return {
      ok: false,
      transport: 'acp',
      text: '',
      toolCalls: [],
      error: err instanceof Error ? err.message : String(err),
    };
  } finally {
    session.stop();
    revoke();
  }
}

/** Where the ACP launch commands are cached, for diagnostics. */
export function acpCachePath(dataDir: string): string {
  return path.join(dataDir, 'acp-registry.json');
}
