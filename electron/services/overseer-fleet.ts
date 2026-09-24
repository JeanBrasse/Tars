import { agents } from '../core/agent-manager';
import { AgentStatus } from '../types';
import { stripAnsi } from '../utils/ansi';
import { repoSummary } from './git-review';

// ── Fleet snapshot ──────────────────────────────────────────────────────

interface FleetAgentSnapshot {
  id: string;
  name: string;
  projectPath: string;
  worktreePath?: string;
  branchName?: string;
  provider: string;
  model?: string;
  status: string;
  statusDurationMs: number;
  /** What it was asked to do, as the agent record holds it. The snapshot
   *  carried its recent output but never the task behind it. */
  currentTask?: string;
  recentOutput: string;
  outputTruncated: boolean;
}

interface FleetProjectSnapshot {
  path: string;
  branch: string;
  dirty: boolean;
  agentCount: number;
}

export interface FleetSnapshot {
  takenAt: string;
  agents: FleetAgentSnapshot[];
  projects: FleetProjectSnapshot[];
  /** Agents that exist but were dropped to keep the snapshot within budget. */
  agentsOmitted: number;
}

const OUTPUT_TAIL_CHARS = 600;
const MAX_AGENTS_IN_SNAPSHOT = 60;
const MAX_PROJECTS_IN_SNAPSHOT = 24;
const SNAPSHOT_CHAR_BUDGET = 16_000;

/**
 * How long each agent has been in its current status, tracked here rather
 * than read from disk: agents.json deliberately does not persist a
 * status-changed-at timestamp (status itself is reset to 'idle' on every
 * load). A restart therefore restarts this clock too - the cost is that a
 * long-running agent takes up to LONG_RUNNING_MS again after a Tars restart
 * before watchTick re-flags it, which is a acceptable trade against adding
 * a new persisted field to AgentStatus for one lightly-used feature.
 */
const statusSince = new Map<string, { status: string; since: number }>();

function trackStatusDurationMs(agent: AgentStatus, now: number): number {
  const prev = statusSince.get(agent.id);
  if (!prev || prev.status !== agent.status) {
    statusSince.set(agent.id, { status: agent.status, since: now });
    return 0;
  }
  return now - prev.since;
}

/**
 * Everything the overseer needs to see, gathered locally - Tars builds this
 * and pushes it into the Hermes prompt; Hermes cannot reach back into Tars
 * (its API is 127.0.0.1-only), so there is no other way for the overseer to
 * know the fleet's state.
 */
export async function buildFleetSnapshot(): Promise<FleetSnapshot> {
  const now = Date.now();
  const all = Array.from(agents.values());
  const detailed = all.slice(0, MAX_AGENTS_IN_SNAPSHOT);
  const agentsOmitted = Math.max(0, all.length - detailed.length);

  const agentSnapshots: FleetAgentSnapshot[] = detailed.map(agent => {
    const statusDurationMs = trackStatusDurationMs(agent, now);
    // Prefer the hook-captured clean transcript text over the raw ANSI PTY
    // buffer: it's already legible. Fall back to the last few raw chunks,
    // stripped, for CLIs/situations where hooks never ran.
    const rawTail = (agent.lastCleanOutput && agent.lastCleanOutput.trim())
      ? agent.lastCleanOutput
      : stripAnsi(agent.output.slice(-6).join(''));
    const outputTruncated = rawTail.length > OUTPUT_TAIL_CHARS;
    return {
      id: agent.id,
      name: agent.name || agent.id,
      projectPath: agent.projectPath,
      worktreePath: agent.worktreePath,
      branchName: agent.branchName,
      provider: agent.provider || 'claude',
      model: agent.model,
      status: agent.status,
      statusDurationMs,
      currentTask: agent.currentTask ? agent.currentTask.slice(0, 160) : undefined,
      recentOutput: (outputTruncated ? rawTail.slice(-OUTPUT_TAIL_CHARS) : rawTail).trim(),
      outputTruncated,
    };
  });

  const projectPaths = Array.from(new Set(all.map(a => a.projectPath))).slice(0, MAX_PROJECTS_IN_SNAPSHOT);
  const projects = await Promise.all(projectPaths.map(async (p): Promise<FleetProjectSnapshot> => {
    const agentCount = all.filter(a => a.projectPath === p).length;
    try {
      const summary = await repoSummary(p);
      return { path: p, branch: summary.branch, dirty: summary.status.length > 0, agentCount };
    } catch {
      // Not a git repo, or the path is gone - still worth listing so the
      // overseer knows the agent count even without branch/dirty info.
      return { path: p, branch: 'unknown', dirty: false, agentCount };
    }
  }));

  return { takenAt: new Date(now).toISOString(), agents: agentSnapshots, projects, agentsOmitted };
}

export function formatDuration(ms: number): string {
  if (ms <= 0) return 'just now';
  const mins = Math.round(ms / 60_000);
  if (mins < 1) return '<1m';
  if (mins < 60) return `${mins}m`;
  const hours = Math.floor(mins / 60);
  const rem = mins % 60;
  return `${hours}h${rem ? ` ${rem}m` : ''}`;
}

export function serializeSnapshot(snapshot: FleetSnapshot): string {
  const lines: string[] = [`Fleet snapshot taken at ${snapshot.takenAt}.`, '', 'PROJECTS:'];
  if (!snapshot.projects.length) lines.push('(no projects with agents)');
  for (const p of snapshot.projects) {
    lines.push(`- ${p.path} | branch ${p.branch} | ${p.dirty ? 'dirty (uncommitted changes)' : 'clean'} | ${p.agentCount} agent(s)`);
  }
  lines.push('', 'AGENTS:');
  if (!snapshot.agents.length) lines.push('(no agents)');
  for (const a of snapshot.agents) {
    lines.push(`- id: ${a.id}`);
    lines.push(`  name: ${a.name}`);
    lines.push(`  project: ${a.projectPath}${a.worktreePath ? ` (worktree: ${a.worktreePath})` : ''}${a.branchName ? `, branch ${a.branchName}` : ''}`);
    lines.push(`  provider/model: ${a.provider}${a.model ? `/${a.model}` : ''}`);
    lines.push(`  status: ${a.status}, in this status for ${formatDuration(a.statusDurationMs)}`);
    if (a.recentOutput) {
      lines.push(`  recent output${a.outputTruncated ? ' (truncated)' : ''}: ${a.recentOutput.replace(/\s+/g, ' ')}`);
    }
  }
  if (snapshot.agentsOmitted > 0) {
    lines.push('', `(${snapshot.agentsOmitted} more agent(s) omitted to keep this snapshot within budget)`);
  }
  let text = lines.join('\n');
  if (text.length > SNAPSHOT_CHAR_BUDGET) {
    text = `${text.slice(0, SNAPSHOT_CHAR_BUDGET)}\n… snapshot truncated to stay within the prompt budget`;
  }
  return text;
}
