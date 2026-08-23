import * as path from 'path';
import { AcpSession, type TurnResult } from './client';
import { acpLaunchFor, loadAcpRegistry } from './registry';
import { getMcpOrchestratorPath, getMcpMemoryPath } from '../mcp-orchestrator';
import { getProvider } from '../../providers';
import type { AgentStatus, AppSettings } from '../../types';
import * as fs from 'fs';
import { recordUsage } from '../usage-ledger';

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

/** Tools an orchestrator must not use itself, whatever CLI it runs. */
const ORCHESTRATOR_DENY = ['write', 'edit', 'create file', 'multiedit', 'notebook'];

function mcpServersFor(agent: AgentStatus): { name: string; command: string; args: string[]; env: { name: string; value: string }[] }[] {
  const env = [
    { name: 'CLAUDE_AGENT_ID', value: agent.id },
    { name: 'CLAUDE_PROJECT_PATH', value: agent.projectPath },
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
  const session = new AcpSession(launch, {
    cwd,
    env: {
      ...provider.getPtyEnvVars(agent.id, agent.projectPath, agent.skills ?? [], appSettings),
      CLAUDE_AGENT_ID: agent.id,
      CLAUDE_PROJECT_PATH: agent.projectPath,
    },
    mcpServers: mcpServersFor(agent),
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
  }
}

/** Where the ACP launch commands are cached, for diagnostics. */
export function acpCachePath(dataDir: string): string {
  return path.join(dataDir, 'acp-registry.json');
}
