import { agents } from '../core/agent-manager';
import { ptyProcesses } from '../core/pty-manager';
import { terminalText, replayText, panelSizeOf } from '../core/terminal-mirror';
import { stripAnsi } from '../utils/ansi';
import type { AgentStatus } from '../types';

/**
 * Searching across the whole fleet.
 *
 * Every agent's output lived only in its own terminal, so answering "which
 * agent hit this error" meant opening 29 terminals and scrolling. This reads
 * the retained buffers in one pass.
 *
 * Each agent is read as a terminal shows it, never as its raw stream split on
 * line breaks: Claude Code draws with cursor moves and carriage returns, and
 * the stream with its codes stripped read as one run of glued words (Noah,
 * 2026-10-01). A running agent is read from its terminal's mirror, the screen
 * it shows now; one that is not, from its kept output replayed headless.
 */

export interface LogLine {
  agentId: string;
  agentName: string;
  projectPath: string;
  branch?: string;
  status: string;
  line: string;
  /** Index within that agent's retained output, newest last. */
  position: number;
}

export interface LogSearchResult {
  lines: LogLine[];
  scannedAgents: number;
  truncated: boolean;
}

const MAX_RESULTS = 500;

/** The size a replay is made at when no panel has shown the agent: the size its terminal is spawned at. */
const REPLAY_SIZE = { cols: 120, rows: 40 };

/**
 * The last replay of each agent's kept output. Kept output only changes at its
 * ends (a chunk pushed, the oldest dropped), so it is the same output while
 * its count and the chunks at both ends are the same strings.
 */
const replays = new Map<string, { first?: string; last?: string; count: number; cols: number; rows: number; lines: string[] }>();

function replayed(agent: AgentStatus): string[] | undefined {
  const output = agent.output;
  const size = panelSizeOf(agent.id) ?? REPLAY_SIZE;
  const first = output[0];
  const last = output[output.length - 1];
  const kept = replays.get(agent.id);
  if (kept && kept.count === output.length && kept.first === first && kept.last === last
    && kept.cols === size.cols && kept.rows === size.rows) {
    return kept.lines;
  }
  const lines = replayText(output, size);
  if (lines) replays.set(agent.id, { first, last, count: output.length, ...size, lines });
  return lines;
}

/** Without xterm-headless: the stream with its codes stripped, as before, rather than nothing. */
function stripped(agent: AgentStatus): string[] {
  // Chunks split mid-line, so join before splitting.
  return stripAnsi(agent.output.join(''))
    .split('\n')
    .map(line => line.replace(/\r/g, '').trimEnd())
    .filter(line => line.trim().length > 0);
}

function agentLines(agentId: string): { line: string; position: number }[] {
  const agent = agents.get(agentId);
  if (!agent) return [];
  const live = agent.ptyId ? terminalText(ptyProcesses.get(agent.ptyId)) : undefined;
  const lines = live ?? replayed(agent) ?? stripped(agent);
  return lines.map((line, position) => ({ line, position }));
}

/**
 * Case-insensitive substring, or a regex when the query is /…/ delimited.
 * A bad regex falls back to a literal search rather than throwing at the user.
 */
function matcher(query: string): (line: string) => boolean {
  const asRegex = query.match(/^\/(.*)\/([gimsu]*)$/);
  if (asRegex) {
    try {
      const re = new RegExp(asRegex[1], asRegex[2].replace('g', ''));
      return line => re.test(line);
    } catch {
      // fall through to literal
    }
  }
  const needle = query.toLowerCase();
  return line => line.toLowerCase().includes(needle);
}

export function searchLogs(opts: {
  query: string;
  agentIds?: string[];
  projectPath?: string;
  limit?: number;
}): LogSearchResult {
  const limit = Math.min(opts.limit ?? 200, MAX_RESULTS);
  const matches = matcher(opts.query);
  const lines: LogLine[] = [];
  let scanned = 0;

  const candidates = opts.agentIds?.length
    ? opts.agentIds.map(id => agents.get(id)).filter(Boolean)
    : Array.from(agents.values());

  for (const agent of candidates) {
    if (!agent) continue;
    if (opts.projectPath && agent.projectPath !== opts.projectPath) continue;
    scanned++;

    for (const entry of agentLines(agent.id)) {
      if (!matches(entry.line)) continue;
      lines.push({
        agentId: agent.id,
        agentName: agent.name || agent.id,
        projectPath: agent.projectPath,
        branch: agent.branchName,
        status: agent.status,
        line: entry.line.slice(0, 600),
        position: entry.position,
      });
      if (lines.length >= limit) {
        return { lines, scannedAgents: scanned, truncated: true };
      }
    }
  }

  return { lines, scannedAgents: scanned, truncated: false };
}

/** The tail of one agent's output, for reading around a hit. */
export function agentTail(agentId: string, lineCount = 200): { lines: string[]; agentName: string } | null {
  const agent = agents.get(agentId);
  if (!agent) return null;
  const all = agentLines(agentId).map(e => e.line);
  return { lines: all.slice(-lineCount), agentName: agent.name || agent.id };
}

/** Fleet overview: who is running, who errored, who has been quiet. */
export function fleetSummary(): {
  agentId: string;
  agentName: string;
  projectPath: string;
  branch?: string;
  provider?: string;
  status: string;
  lastActivity?: string;
  lines: number;
}[] {
  return Array.from(agents.values())
    .map(agent => ({
      agentId: agent.id,
      agentName: agent.name || agent.id,
      projectPath: agent.projectPath,
      branch: agent.branchName,
      provider: agent.provider,
      status: agent.status,
      lastActivity: agent.lastActivity,
      lines: agent.output.length,
    }))
    .sort((a, b) => (b.lastActivity || '').localeCompare(a.lastActivity || ''));
}
