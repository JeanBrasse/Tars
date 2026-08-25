import * as fs from 'fs';
import * as http from 'http';
import { v4 as uuidv4 } from 'uuid';
import { agents } from '../core/agent-manager';
import { AgentStatus } from '../types';
import { dataPath, API_PORT } from '../constants';
import { writeAtomicSync } from '../utils/secret-file';
import { stripAnsi } from '../utils/ansi';
import { repoSummary } from './git-review';
import { usableHermesConnection } from './hermes-config';
import { agentStatusEmitter } from './agent-events';
import { recordRunEvents, summariseRuns, type RunEvent } from './overseer-runs';
import { AUTO_ACTION_RULES, findAutoRule } from './overseer-auto';
import {
  LiveSession,
  askLiveSession,
  createLiveSession,
  liveTransportAvailable,
} from './hermes-session';
import {
  probeHermes,
  createHermesCron,
  updateHermesCron,
  setHermesModel,
  hermesCronAction,
  fetchHermesCronRuns,
  fetchHermesSessionMessages,
} from './hermes-client';
import { HermesConnection } from '../types/hermes';

/**
 * The Overseer: a Hermes agent that watches every Tars agent in every
 * project, reports on what they're doing, challenges questionable choices,
 * and can propose - but never itself perform - a message to one agent.
 *
 * Why this lives in the main process rather than as an ACP delegate like
 * everything else in electron/services/acp/: the overseer isn't a Tars agent
 * with a PTY, it's a *client* of Hermes' own cron/session machinery (see the
 * probe notes at the top of the task this file was built from). There is no
 * REST "ask a question" route on the gateway, only cron jobs that can be
 * triggered and polled, so askOverseer() below drives that machinery by hand:
 * PUT a fresh prompt into a standing job, POST /trigger, poll for the run it
 * created, read the run's session transcript back.
 *
 * ── The envelope ──────────────────────────────────────────────────────────
 * The overseer is asked to reply with exactly one JSON object so Tars can act
 * on it without parsing prose:
 *   { "say": string, "action": null | { "kind": "message_agent", "agent_id": string, "text": string } }
 * "say" is what reaches the chat. "action" is a PROPOSAL, never a command:
 * see the write gate below for why naming an id is as far as the model's
 * authority goes.
 *
 * ── The write gate ───────────────────────────────────────────────────────
 * The single most important safety property this feature has is "never
 * writes to the wrong CLI". That is enforced structurally, not by trusting
 * the model:
 *   1. The overseer may only NAME an agent by an id that was present in the
 *      fleet snapshot it was just given (composeTurn's instructions say so,
 *      but the enforcement is step 2, not the model's compliance).
 *   2. resolveTarget() looks that id up in the LIVE agents map - taken NOW,
 *      not from the snapshot the model saw, which may be stale by the time
 *      the answer comes back - and only a real, currently-known agent
 *      resolves to a target at all.
 *   3. sendToAgent() calls resolveTarget() again, and confirmPendingAction()
 *      calls it a third time immediately before writing, because Noah's
 *      approval can land minutes after the proposal and the fleet can have
 *      changed in between.
 *   4. Nothing is written until confirmPendingAction() is called with
 *      approve:true - which only happens when Noah presses send in the UI.
 * The model never picks the destination. It names an id, Tars resolves it
 * (repeatedly, at the point that matters), and Noah confirms. That is what
 * makes writing to the wrong CLI impossible rather than merely unlikely.
 */

// ── Persistence ─────────────────────────────────────────────────────────
// Conversation + job id live in ~/.dorothy/overseer.json, written the way
// projects.json is: a plain state file, atomic, no secret-mode chmod (it
// holds no credential - the Hermes token itself stays in hermes-connection.json).

const OVERSEER_FILE = dataPath('overseer.json');
const OVERSEER_JOB_NAME = 'tars-overseer';

export interface OverseerAction {
  actionId: string;
  agentId: string;
  agentName: string;
  projectPath: string;
  provider: string;
  model?: string;
  pane: string;
  text: string;
  /** ISO timestamp of the resolveTarget() call this action was built from -
   *  the UI shows "resolved Ns ago" from this so approving something stale
   *  is a visible choice, not a silent one. */
  resolvedAt: string;
}

/** A file already on the gateway, named by the message that sent it. */
export interface OverseerAttachment {
  name: string;
  path: string;
  isImage: boolean;
}

export interface OverseerMessage {
  id: string;
  role: 'user' | 'overseer';
  text: string;
  action: OverseerAction | null;
  isBriefing?: boolean;
  timestamp: string;
  /** Files sent with this message. Kept beside the text rather than inside it
   *  so the bubble can show a chip and the text stays what was typed. */
  attachments?: OverseerAttachment[];
  /**
   * Set on read when this reply looks like the format template rather than an
   * answer. Never stored: it is recomputed from the text every time, so a
   * later, better rule re-judges old messages instead of inheriting the
   * verdict of the rule that happened to be shipped when they arrived.
   */
  templateEcho?: boolean;
}

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

interface OverseerState {
  jobId: string | null;
  messages: OverseerMessage[];
  previousSnapshot: FleetSnapshot | null;
  /** Agent ids already flagged as "running unusually long" for their current
   *  run, so watchTick doesn't re-flag the same agent every 5 minutes. */
  longRunningReported: string[];
  paused: boolean;
  settings: OverseerSettings;
}

/**
 * What the overseer runs on, and how often it looks.
 *
 * All three were constants. The watch interval was a fixed five minutes, which
 * is too eager for a fleet left running overnight and too slow when you are
 * watching a migration land; and the model was whatever the Hermes gateway
 * happened to have selected globally, which on a fresh install is a small fast
 * one. Reading a fleet and reasoning about what its agents are doing is the one
 * job here, so it is worth being able to point it at a better model.
 *
 * An empty model or provider means "whatever the gateway is set to", which is
 * the behaviour every existing install already has.
 */
export interface OverseerSettings {
  watchIntervalMs: number;
  /** Ids of the auto-action rules turned on. Empty by default: every proposal
   *  waits for Noah unless he has said in advance that this kind need not. */
  autoActions: string[];
  model: string;
  provider: string;
}

/** How often the watch looks at the fleet when nothing overrides it. */
export const DEFAULT_WATCH_INTERVAL_MS = 5 * 60 * 1000;

/** 1 minute floor, 6 hour ceiling. Below a minute the fleet cannot have changed
 *  meaningfully and every tick costs a Hermes run; above six hours the watch is
 *  not a watch. */
export const MIN_WATCH_INTERVAL_MS = 60 * 1000;
export const MAX_WATCH_INTERVAL_MS = 6 * 60 * 60 * 1000;

function defaultSettings(): OverseerSettings {
  return { watchIntervalMs: DEFAULT_WATCH_INTERVAL_MS, model: '', provider: '', autoActions: [] };
}

function defaultState(): OverseerState {
  return { jobId: null, messages: [], previousSnapshot: null, longRunningReported: [], paused: false, settings: defaultSettings() };
}

function loadState(): OverseerState {
  try {
    if (!fs.existsSync(OVERSEER_FILE)) return defaultState();
    const raw = JSON.parse(fs.readFileSync(OVERSEER_FILE, 'utf-8'));
    // Spreading `raw` over the defaults is a shallow merge, so a state file
    // written before settings existed - or one holding only some of them -
    // would otherwise arrive with `settings` undefined and crash the callers.
    return {
      ...defaultState(),
      ...raw,
      settings: { ...defaultSettings(), ...(raw?.settings ?? {}) },
    };
  } catch (err) {
    console.error('[overseer] could not read overseer.json, starting fresh:', err);
    return defaultState();
  }
}

function saveState(state: OverseerState): void {
  try {
    writeAtomicSync(OVERSEER_FILE, JSON.stringify(state, null, 2));
  } catch (err) {
    console.error('[overseer] could not persist overseer.json:', err);
  }
}

/**
 * The conversation, with the replies that look like the format template
 * flagged rather than removed.
 *
 * This used to drop them from disk on load, which was wrong twice over: the
 * loop is already broken by serializeHistory refusing to quote an echo back
 * to the model, so deleting bought nothing, and a heuristic that writes to
 * disk turns each of its own mistakes into permanent data loss. It flags
 * instead. The interface can hide a flagged message; nothing can lose one.
 */
export function getOverseerHistory(): OverseerMessage[] {
  return loadState().messages.map(m => (
    m.role === 'overseer' && isTemplateEcho(m.text) ? { ...m, templateEcho: true } : m
  ));
}

/**
 * Throw the conversation away and start a fresh one.
 *
 * The load-time purge handles the one failure that has actually happened, but
 * it only knows that shape. The conversation is the model's own context, so
 * anything that gets stuck in it stays stuck until something can empty it,
 * and without this the only way out of the next such loop would be another
 * release. Settings, the standing job and the fleet baseline are kept: this
 * clears what was said, not how the overseer is set up.
 */
export function clearOverseerHistory(): { cleared: number } {
  const state = loadState();
  const cleared = state.messages.length;
  if (cleared === 0) return { cleared: 0 };
  state.messages = [];
  saveState(state);
  return { cleared };
}

// ── Fleet snapshot ──────────────────────────────────────────────────────

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

function formatDuration(ms: number): string {
  if (ms <= 0) return 'just now';
  const mins = Math.round(ms / 60_000);
  if (mins < 1) return '<1m';
  if (mins < 60) return `${mins}m`;
  const hours = Math.floor(mins / 60);
  const rem = mins % 60;
  return `${hours}h${rem ? ` ${rem}m` : ''}`;
}

function serializeSnapshot(snapshot: FleetSnapshot): string {
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

// ── Prompt composition ───────────────────────────────────────────────────

const HISTORY_TURN_LIMIT = 24;
const HISTORY_CHAR_BUDGET = 6000;

function serializeHistory(history: OverseerMessage[]): string {
  // This is where the loop lived. Hermes was shown its own placeholder as
  // something it had already said, so it said it again, and the prompt for
  // the next turn then held two of them. Whatever the guard in finishTurn
  // let through, or an older build wrote before that guard existed, stops
  // here: an echo is never quoted back as an example to follow.
  const usable = history.filter(m => m.role !== 'overseer' || !isTemplateEcho(m.text));
  const recent = usable.slice(-HISTORY_TURN_LIMIT);
  let omitted = usable.length - recent.length;
  const kept: string[] = [];
  let used = 0;
  // Walk newest-first so the char budget favors the most recent context.
  for (let i = recent.length - 1; i >= 0; i--) {
    const m = recent[i];
    const speaker = m.role === 'user' ? 'NOAH' : 'OVERSEER';
    const actionNote = m.action ? ` [proposed messaging agent ${m.action.agentId}]` : '';
    const line = `${speaker}: ${m.text}${actionNote}`;
    if (used + line.length > HISTORY_CHAR_BUDGET) { omitted += i + 1; break; }
    kept.unshift(line);
    used += line.length;
  }
  const lines: string[] = [];
  if (omitted > 0) lines.push(`(${omitted} earlier message(s) omitted)`);
  lines.push(...kept);
  return lines.join('\n');
}

/**
 * The prompt sent to Hermes for one turn. Exported so it can be inspected
 * independently of the network round trip in askOverseer().
 */
export function composeTurn(
  snapshot: FleetSnapshot,
  history: OverseerMessage[],
  userMessage: string,
  opts: { isBriefing?: boolean } = {},
): string {
  const instructions = [
    'You are the Overseer: a Hermes agent embedded in Tars, watching every coding agent in every project for Noah.',
    'Your job is to report what the fleet is doing, the decisions in flight, challenge choices that look wrong, and propose next steps. You talk to orchestrator agents as a peer would, through Noah.',
    '',
    'Rules:',
    '- You never claim to have done anything yourself. You only report, challenge, and propose.',
    '- You may name an agent to message ONLY by an "id" value that literally appears in the FLEET SNAPSHOT below. Never invent an id, and never substitute a name for an id.',
    '- You never send anything directly. Tars shows Noah exactly what you propose to write, and to which agent, before anything is sent; nothing happens until he approves it.',
    '- Reply with EXACTLY one JSON object and nothing else, before or after it. "say" is what you tell Noah, plain text or light markdown. Example:',
    '  {"say": "Frontend has been waiting on your answer about the sidebar width for eleven minutes. Nothing else is blocked.", "action": null}',
    '  or, only when proposing to message one specific agent:',
    '  {"say": "Backend has retried the same failing test three times without changing anything. Worth asking it what it thinks is wrong.", "action": {"kind": "message_agent", "agent_id": "an id copied from the snapshot", "text": "What do you believe is making that test fail?"}}',
    '- Those two are illustrations of the shape only. Never repeat their wording, and never treat them as facts about the fleet: write your own sentence about the snapshot below.',
    '- If no agent in the snapshot is the right target, action must be null.',
  ].join('\n');

  const turnLabel = opts.isBriefing
    ? '=== AUTOMATIC CHECK-IN (Tars\' watch timer, not a message from Noah) ==='
    : '=== NOAH ===';
  const turnBody = opts.isBriefing
    ? `${userMessage}\nThis is an unprompted check-in triggered by a fleet change, not a question. If something is worth flagging, say it concisely; otherwise say something minimal like "Nothing worth flagging."`
    : userMessage;

  // What the fleet has been doing, when there is anything to say. A snapshot
  // answers "where is everyone"; this answers "how has it been going", which
  // is what makes "that is the third time it has restarted on this" possible.
  const history24h = summariseRuns();

  return [
    instructions,
    '',
    '=== FLEET SNAPSHOT ===',
    serializeSnapshot(snapshot),
    ...(history24h ? ['', `=== ${history24h}`] : []),
    '',
    '=== CONVERSATION SO FAR ===',
    history.length ? serializeHistory(history) : '(nothing yet, this is the first turn)',
    '',
    turnLabel,
    turnBody,
  ].join('\n');
}

export interface ParsedEnvelope {
  say: string;
  action: { agentId: string; text: string } | null;
}

/** The first balanced {...} in a string, ignoring braces inside JSON strings.
 *  Lets a reply that wraps its envelope in prose still be read. */
function firstJsonObject(text: string): string | null {
  const start = text.indexOf('{');
  if (start === -1) return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === '{') depth++;
    else if (ch === '}' && --depth === 0) return text.slice(start, i + 1);
  }
  return null;
}

/**
 * Read the `say` string out of an envelope that will not parse.
 *
 * A reply cut off mid-object still has everything the reader wants at the
 * front of it. Without this, a truncated envelope fell through whole and the
 * chat showed `"action": {"kind": "message_agent", "agent_id": "57f0..."` as
 * if it were the message.
 */
function salvageSay(text: string): string | null {
  const key = text.search(/"say"\s*:\s*"/);
  if (key === -1) return null;
  let i = text.indexOf('"', text.indexOf(':', key) + 1) + 1;
  let out = '';
  let escaped = false;
  for (; i < text.length; i++) {
    const ch = text[i];
    if (escaped) {
      out += ch === 'n' ? '\n' : ch === 't' ? '\t' : ch;
      escaped = false;
      continue;
    }
    if (ch === '\\') { escaped = true; continue; }
    if (ch === '"') break;
    out += ch;
  }
  return out.trim() || null;
}

function readEnvelope(candidate: string): ParsedEnvelope | null {
  try {
    const parsed = JSON.parse(candidate) as { say?: unknown; action?: unknown };
    if (!parsed || typeof parsed.say !== 'string') return null;
    const a = parsed.action as { kind?: unknown; agent_id?: unknown; text?: unknown } | null | undefined;
    if (a && a.kind === 'message_agent' && typeof a.agent_id === 'string' && typeof a.text === 'string') {
      return { say: parsed.say, action: { agentId: a.agent_id, text: a.text } };
    }
    return { say: parsed.say, action: null };
  } catch {
    return null;
  }
}

/**
 * A reply that is the format example rather than an answer.
 *
 * The prompt shows Hermes the envelope to fill in. When it copies the example
 * instead of filling it, the result is still valid JSON, so parseEnvelope
 * accepts it and `say` becomes the placeholder itself. That happened once on
 * Noah's install and then never stopped: every following turn was shown the
 * placeholder as something the overseer had already said, and copied it in
 * turn. Nineteen consecutive turns, none of which could recover on its own.
 *
 * The test is structural rather than a list of known strings, because a model
 * paraphrases its own template. Take out the placeholder spans, `<like this>`
 * and bare `[SENTINEL]` tokens, and see whether any actual message is left.
 * Prose that merely happens to contain angle brackets keeps its words and is
 * not touched; a reply built only of placeholders has nothing left.
 */
const PLACEHOLDER_SPAN = /<[^<>]{0,120}>/g;
/** `[SILENT]`, which the gateway emits for "produce no output" and which is
 *  not a message either. Uppercase only, so a markdown link survives. */
const BARE_SENTINEL = /\[[A-Z][A-Z_ ]{2,30}\]/g;
export function isTemplateEcho(say: string): boolean {
  const text = say.trim();
  if (!text) return true;

  const stripped = text.replace(PLACEHOLDER_SPAN, ' ').replace(BARE_SENTINEL, ' ');
  // Nothing was a placeholder, so there is nothing to accuse it of.
  if (stripped === text) return false;

  // Nothing at all, rather than "not much". This started as a threshold of a
  // dozen surviving characters, which is the kind of number that has to be
  // guessed and was guessed wrong: it swallowed "[URGENT] Build KO." and
  // "Voir <https://example.com/docs>.", which are messages, not templates.
  // The real distinction needs no tuning. A reply that is the template has
  // nothing left once the template is taken out of it; a reply that merely
  // uses brackets is still a sentence without them.
  return !/[\p{L}\p{N}]/u.test(stripped);
}

/**
 * What the model actually said, whatever shape it sent it in.
 *
 * The reply is asked for as one JSON object. When it is one, this reads it.
 * When it is not, the old behaviour was to hand the whole raw string through
 * as the message, so a reply with prose around its envelope, or one the model
 * cut off, arrived in the chat as visible JSON. Every path below now ends in
 * something a person can read.
 */
export function parseEnvelope(raw: string): ParsedEnvelope {
  const text = raw.trim();
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);

  for (const candidate of [fenced?.[1], text, firstJsonObject(text)]) {
    if (!candidate) continue;
    const read = readEnvelope(candidate.trim());
    if (read) return read;
  }

  // Nothing parsed. If there is a `say` in there, it is the message.
  const salvaged = salvageSay(text);
  if (salvaged) return { say: salvaged, action: null };

  // Still nothing, and it looks like a machine wrote it: say that, rather
  // than showing the reader an object.
  if (/"(say|action|kind|agent_id)"\s*:/.test(text)) {
    return {
      say: 'Hermes replied in a shape Tars could not read, so there is nothing to show. Ask again.',
      action: null,
    };
  }

  // Ordinary prose, which is a perfectly good answer.
  return { say: text, action: null };
}

// ── The write gate ───────────────────────────────────────────────────────
// See the file header. Every function below resolves against the LIVE
// `agents` map at call time - never against a snapshot the model was shown,
// which may already be stale by the time an answer or an approval arrives.

export interface ResolvedTarget {
  agent: AgentStatus;
  agentName: string;
  projectPath: string;
  provider: string;
  model?: string;
  pane: string;
}

export function resolveTarget(agentId: string): { ok: true; target: ResolvedTarget } | { ok: false; error: string } {
  if (!agentId) return { ok: false, error: 'No agent id given.' };
  const agent = agents.get(agentId);
  if (!agent) {
    return { ok: false, error: `No agent with id "${agentId}" in the current fleet. It may have been removed or renamed.` };
  }
  return {
    ok: true,
    target: {
      agent,
      agentName: agent.name || agent.id,
      projectPath: agent.worktreePath || agent.projectPath,
      provider: agent.provider || 'claude',
      model: agent.model,
      pane: agent.ptyId ? `live pane (${agent.ptyId.slice(0, 8)})` : 'no live pane, a fresh session will start',
    },
  };
}

function readApiToken(): string {
  try {
    return fs.readFileSync(dataPath('api-token'), 'utf-8').trim();
  } catch {
    return '';
  }
}

/**
 * POST to the local API's /dispatch route rather than writing to the PTY
 * directly. That route is what performDispatch() in agent-routes.ts already
 * implements (message a live session, or spawn one via spawnAgentSession if
 * none is live) - the one path an API-driven session is started, per the
 * backend spawn rule. Going through it here means sendToAgent gets that
 * behavior for free instead of a second copy of it.
 */
function postLocalDispatch(agentId: string, message: string): Promise<{ status: number; body: unknown }> {
  return new Promise((resolve, reject) => {
    const token = readApiToken();
    const payload = JSON.stringify({ message });
    const req = http.request({
      host: '127.0.0.1',
      port: API_PORT,
      path: `/api/agents/${encodeURIComponent(agentId)}/dispatch`,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload),
        Authorization: `Bearer ${token}`,
      },
      timeout: 15_000,
    }, res => {
      let raw = '';
      res.on('data', c => { raw += c; });
      res.on('end', () => {
        let body: unknown = raw;
        try { body = JSON.parse(raw); } catch { /* keep raw */ }
        resolve({ status: res.statusCode ?? 0, body });
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
    req.write(payload);
    req.end();
  });
}

export async function sendToAgent(agentId: string, text: string): Promise<{ success: boolean; error?: string; mode?: string }> {
  const resolved = resolveTarget(agentId);
  if (!resolved.ok) return { success: false, error: resolved.error };
  try {
    const { status, body } = await postLocalDispatch(agentId, text);
    if (status >= 300) {
      const err = (body && typeof body === 'object' && 'error' in body) ? String((body as { error: unknown }).error) : `HTTP ${status}`;
      return { success: false, error: err };
    }
    const mode = (body && typeof body === 'object' && 'mode' in body) ? String((body as { mode: unknown }).mode) : undefined;
    return { success: true, mode };
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/** actionIds already resolved (sent or cancelled), so a double-click on the
 *  UI's send button can't dispatch the same proposal twice. Memory-only and
 *  capped: this is a double-submit guard, not an audit log. */
const consumedActionIds = new Set<string>();
function markConsumed(id: string): void {
  consumedActionIds.add(id);
  if (consumedActionIds.size > 500) {
    const oldest = consumedActionIds.values().next().value;
    if (oldest) consumedActionIds.delete(oldest);
  }
}

/**
 * The user's decision on a proposed action. Nothing is written to any CLI
 * until this is called with approve:true - which only happens when Noah
 * presses send in the approval panel.
 */
export async function confirmPendingAction(
  action: OverseerAction,
  approve: boolean,
): Promise<{ success: boolean; error?: string; mode?: string }> {
  if (!action || !action.actionId || !action.agentId || !action.text) {
    return { success: false, error: 'Malformed action.' };
  }
  if (consumedActionIds.has(action.actionId)) {
    return { success: false, error: 'This action was already resolved.' };
  }
  markConsumed(action.actionId);
  if (!approve) return { success: true };

  // Re-resolve now, immediately before writing: the fleet may have changed
  // since the overseer proposed this (agent finished, was removed, moved
  // project) in the minutes it can take Noah to read and approve it.
  return sendToAgent(action.agentId, action.text);
}

// ── Talking to Hermes ────────────────────────────────────────────────────

const RUN_POLL_INTERVAL_MS = 3000;
// The probed gateway round-trips a triggered job in about 30s; give it double.
const RUN_POLL_TIMEOUT_MS = 60_000;

async function ensureOverseerJob(
  conn: HermesConnection,
  state: OverseerState,
): Promise<{ jobId: string } | { error: string; needsSignIn?: boolean }> {
  if (state.jobId) {
    // Trust the stored id until a call against it proves it gone (askOverseer
    // recreates on a "not found" PUT) - checking on every turn would cost a
    // round trip for the common case where nothing changed.
    return { jobId: state.jobId };
  }
  // The schedule only has to be syntactically valid, not meaningful: Tars
  // never lets the gateway's own scheduler fire this job, it always drives
  // it by hand (PUT prompt, then POST /trigger - see askOverseer). It MUST
  // be a real cron expression, not an ISO date string: verified against the
  // live gateway that a plain date is treated as one-shot and the job is
  // marked "completed" and deleted (404s on the next GET) the moment it is
  // triggered - even manually - which forced a brand new job to be created
  // on every single turn. "0 3 1 1 *" (once a year, Jan 1st 03:00) keeps the
  // job "scheduled" indefinitely after a manual trigger, confirmed live, so
  // the standing job this function's caller relies on actually stands.
  const created = await createHermesCron(conn, {
    name: OVERSEER_JOB_NAME,
    schedule: '0 3 1 1 *',
    prompt: '(idle - Tars overwrites this prompt before every trigger)',
    model: state.settings.model || undefined,
    provider: state.settings.provider || undefined,
  });
  if (!created.success) return { error: created.error, needsSignIn: created.needsSignIn };
  const jobId = typeof created.job?.id === 'string' ? created.job.id : '';
  if (!jobId) return { error: 'Hermes created the job but returned no id.' };
  state.jobId = jobId;
  saveState(state);
  return { jobId };
}

/** A run id looks like cron_{jobId}_{YYYYMMDD}_{HHMMSS}; recover the instant
 *  it was created so a fresh trigger can be matched against stale runs. */
function runCreatedAtMs(runId: string): number | null {
  const m = runId.match(/_(\d{8})_(\d{6})$/);
  if (!m) return null;
  const [, ymd, hms] = m;
  const iso = `${ymd.slice(0, 4)}-${ymd.slice(4, 6)}-${ymd.slice(6, 8)}T${hms.slice(0, 2)}:${hms.slice(2, 4)}:${hms.slice(4, 6)}Z`;
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? ms : null;
}

export type AskOverseerResult =
  | { ok: true; message: OverseerMessage }
  | { ok: false; reason: 'not_configured' | 'gateway_unreachable' | 'needs_sign_in' | 'run_timeout' | 'busy' | 'error'; error: string };

let turnInFlight = false;
/** Set by pause, read by the poll loop, cleared by resume and by every new
 *  turn. A turn already running gives up at its next poll. */
let abortTurn = false;

export function isOverseerBusy(): boolean {
  return turnInFlight;
}

/**
 * One full turn: compose the prompt, push it to Hermes, poll for the run it
 * creates, and read the answer back. Handles every failure mode called out
 * in the task this was built from: gateway down, not signed in, the job
 * missing (recreated once), a run that never appears (times out, says so),
 * and a reply that isn't valid JSON (falls back to prose, no action).
 */
/**
 * The message as the model should read it: what was typed, with any attached
 * files named above it by their path on the gateway.
 *
 * Paths rather than contents. The gateway's agent has file tools, so it can
 * open what it needs, more than once, without a megabyte of base64 having to
 * survive the prompt.
 */
function withAttachmentPaths(text: string, attachments: OverseerAttachment[] | undefined): string {
  if (!attachments || attachments.length === 0) return text;
  const lines = attachments.map(a => `- ${a.path}${a.isImage ? ' (image)' : ''}`);
  return `Files attached to this message, on your filesystem:\n${lines.join('\n')}\n\n${text}`;
}

export async function askOverseer(
  userMessage: string,
  opts: { isBriefing?: boolean; attachments?: OverseerAttachment[] } = {},
): Promise<AskOverseerResult> {
  if (turnInFlight) {
    return { ok: false, reason: 'busy', error: 'The overseer is already handling another turn; try again in a moment.' };
  }
  turnInFlight = true;
  abortTurn = false;
  try {
    const conn = usableHermesConnection();
    if (!conn) {
      return { ok: false, reason: 'not_configured', error: 'Hermes is not configured. Set it up in Settings → Hermes.' };
    }

    const probe = await probeHermes(conn);
    if (!probe.reachable) {
      return { ok: false, reason: 'gateway_unreachable', error: probe.error || 'The Hermes gateway is not reachable.' };
    }
    if (probe.authRequired && !probe.signedIn) {
      return { ok: false, reason: 'needs_sign_in', error: 'Sign in to Hermes in Settings to use the overseer.' };
    }

    const state = loadState();

    // Recorded before the round trip, not after it. It used to be pushed with
    // the reply, thirty seconds later, so anything that read the history in
    // between - another window, or this page after you navigated away and
    // back - saw a conversation that did not contain what you had just sent.
    if (!opts.isBriefing) {
      state.messages.push({
        id: uuidv4(),
        role: 'user',
        text: userMessage,
        action: null,
        timestamp: new Date().toISOString(),
        ...(opts.attachments?.length ? { attachments: opts.attachments } : {}),
      });
      saveState(state);
    }

    const snapshot = await buildFleetSnapshot();
    const prompt = composeTurn(
      snapshot,
      state.messages,
      withAttachmentPaths(userMessage, opts.attachments),
      opts,
    );

    // The live conversation first. It is what the gateway's own dashboard
    // uses, it answers in about nine seconds rather than thirty, and it does
    // not need a cron job to exist at all. Everything below it is the fallback
    // for a gateway that will not open a socket.
    const liveReply = await askViaLiveSession(conn, prompt);
    if (liveReply.aborted) {
      return { ok: false, reason: 'error', error: 'Stopped: you paused the overseer while it was answering.' };
    }
    if (liveReply.text !== null) {
      return finishTurn(state, liveReply.text, opts);
    }

    // Only now is a cron job worth creating: an install that never falls back
    // never grows one.
    let jobResult = await ensureOverseerJob(conn, state);
    if ('error' in jobResult) {
      return { ok: false, reason: jobResult.needsSignIn ? 'needs_sign_in' : 'error', error: jobResult.error };
    }
    let jobId = jobResult.jobId;

    // Sent on every turn rather than only at creation: the job is long-lived
    // and a model chosen in the Chat header has to reach a job that already
    // exists, which is every case after the first turn.
    const runOn = {
      ...(state.settings.model ? { model: state.settings.model } : {}),
      ...(state.settings.provider ? { provider: state.settings.provider } : {}),
    };
    let update = await updateHermesCron(conn, jobId, { prompt, ...runOn });
    if (!update.success && /not found|no such job|404/i.test(update.error || '')) {
      // The job was deleted out from under us (by hand, or gateway-side):
      // forget the stale id and create a replacement, once.
      state.jobId = null;
      jobResult = await ensureOverseerJob(conn, state);
      if ('error' in jobResult) {
        return { ok: false, reason: jobResult.needsSignIn ? 'needs_sign_in' : 'error', error: jobResult.error };
      }
      jobId = jobResult.jobId;
      update = await updateHermesCron(conn, jobId, { prompt, ...runOn });
    }
    if (!update.success) {
      return { ok: false, reason: update.needsSignIn ? 'needs_sign_in' : 'error', error: update.error || 'Could not send the prompt to Hermes.' };
    }

    const triggeredAt = Date.now();
    const trigger = await hermesCronAction(conn, 'trigger', jobId);
    if (!trigger.success) {
      return { ok: false, reason: 'error', error: trigger.error || 'Could not trigger the overseer job.' };
    }

    // The run record appears in /runs the instant the job is triggered - well
    // before the model has actually replied, since generation (confirmed
    // against the real gateway: several seconds with reasoning effort "high")
    // happens after that. So finding a "fresh" run is not the same as the run
    // having an answer yet: keep polling the transcript itself, not just the
    // run's existence, until either an assistant message shows up or the
    // deadline passes.
    let runId: string | null = null;
    let assistantMsg: { role: string; content: string } | undefined;
    const deadline = triggeredAt + RUN_POLL_TIMEOUT_MS;
    while (Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, RUN_POLL_INTERVAL_MS));
      if (abortTurn) {
        return { ok: false, reason: 'error', error: 'Stopped: you paused the overseer while it was answering.' };
      }

      if (!runId) {
        const runs = await fetchHermesCronRuns(conn, jobId, { limit: 3 });
        if (runs.success) {
          // 15s of slack for clock skew between this machine and the gateway.
          const fresh = runs.runs.find(r => {
            const createdAt = runCreatedAtMs(r.id);
            return createdAt !== null && createdAt >= triggeredAt - 15_000;
          });
          if (fresh) runId = fresh.id;
        }
        if (!runId) continue;
      }

      const transcript = await fetchHermesSessionMessages(conn, runId);
      if (!transcript.success) {
        if (transcript.needsSignIn) {
          return { ok: false, reason: 'needs_sign_in', error: transcript.error };
        }
        // Transient read failure - keep polling rather than failing the
        // whole turn on one bad response.
        continue;
      }
      assistantMsg = [...transcript.messages].reverse().find(m => m.role === 'assistant' && m.content.trim());
      if (assistantMsg) break;
    }
    if (!runId) {
      return { ok: false, reason: 'run_timeout', error: 'The overseer did not answer in time: no run appeared for this trigger.' };
    }
    if (!assistantMsg) {
      return { ok: false, reason: 'run_timeout', error: 'The overseer run did not answer in time.' };
    }

    return finishTurn(state, assistantMsg.content, opts);
  } finally {
    turnInFlight = false;
  }
}

/**
 * What happens to a reply once it exists, whichever transport produced it.
 *
 * Extracted so the live conversation and the cron fallback cannot drift: the
 * envelope parsing, the target re-resolution, the auto-action gate and the
 * history write are the parts that must behave identically no matter how the
 * words arrived.
 */
async function finishTurn(
  state: OverseerState,
  replyText: string,
  opts: { isBriefing?: boolean },
): Promise<AskOverseerResult> {
  const envelope = parseEnvelope(replyText);

  // Refused before anything else happens, and above all before it is written:
  // a placeholder in the history is what turns one bad turn into every turn.
  // Nothing is persisted, so the next turn is already the retry, composed
  // from a prompt this reply never entered.
  if (isTemplateEcho(envelope.say)) {
    console.warn('[overseer] discarded a reply that echoed the format template:', envelope.say.slice(0, 120));
    return {
      ok: false,
      reason: 'error',
      error: 'Hermes sent back the reply template instead of an answer, so Tars discarded it rather than recording it. Ask again.',
    };
  }

  let action: OverseerAction | null = null;
  if (envelope.action) {
    const resolved = resolveTarget(envelope.action.agentId);
    // If the id doesn't resolve, the proposal is silently dropped from the
    // structured side - envelope.say still reaches Noah as the overseer's
    // words, but there is nothing left to approve or send.
    if (resolved.ok) {
      action = {
        actionId: uuidv4(),
        agentId: envelope.action.agentId,
        agentName: resolved.target.agentName,
        projectPath: resolved.target.projectPath,
        provider: resolved.target.provider,
        model: resolved.target.model,
        pane: resolved.target.pane,
        text: envelope.action.text,
        resolvedAt: new Date().toISOString(),
      };
    }
  }

  // Pre-authorised? Decided here, against the live fleet, and sent through
  // the same gate Noah's own approval goes through: a rule is an approval
  // given in advance, not a way around the gate.
  let autoNote = '';
  if (action) {
    const rule = findAutoRule(state.settings.autoActions, { agentId: action.agentId });
    if (rule) {
      const sent = await confirmPendingAction(action, true);
      autoNote = sent.success
        ? `\n\n_Sent automatically to ${action.agentName}: ${rule.label.toLowerCase()}._`
        : `\n\n_Tried to send this automatically and could not: ${sent.error ?? 'unknown error'}._`;
      // Consumed either way, so the panel cannot offer to send it again.
      action = null;
    }
  }

  const overseerMsg: OverseerMessage = {
    id: uuidv4(),
    role: 'overseer',
    text: envelope.say + autoNote,
    action,
    isBriefing: opts.isBriefing,
    timestamp: new Date().toISOString(),
  };

  // The user's turn is already in `state.messages`, pushed before the round
  // trip. A briefing has no user turn at all: it was not asked for.
  state.messages.push(overseerMsg);
  // Bound the persisted history so overseer.json doesn't grow forever.
  if (state.messages.length > 400) state.messages = state.messages.slice(-400);
  saveState(state);

  return { ok: true, message: overseerMsg };
}

/* ── The live conversation ───────────────────────────────────────────────── */

/** Held between turns, so the conversation is one session rather than a new
 *  one per message. Dropped whenever a turn fails against it, so the next turn
 *  reconnects instead of retrying a socket the gateway has forgotten. */
let liveSession: LiveSession | null = null;
let liveControl: WebSocket | null = null;

/** Set once the gateway has refused to open a socket, so an install that
 *  genuinely has no live transport does not pay for the attempt on every
 *  single turn. Cleared whenever the connection settings change. */
let liveUnavailable = false;

export function resetLiveSession(): void {
  try { liveControl?.close(); } catch { /* already gone */ }
  liveSession = null;
  liveControl = null;
  liveUnavailable = false;
}

/**
 * Ask over the live conversation, or report that it could not be used.
 *
 * `text: null` is not a failure, it is "fall back to the cron": the caller
 * carries on down the old path. Only an abort is distinguished, because a
 * paused overseer must not then be asked the same question again by the
 * fallback.
 */
async function askViaLiveSession(
  conn: HermesConnection,
  prompt: string,
): Promise<{ text: string | null; aborted: boolean }> {
  if (liveUnavailable || !liveTransportAvailable()) return { text: null, aborted: false };

  try {
    if (!liveSession) {
      const opened = await createLiveSession(conn);
      liveSession = opened.session;
      liveControl = opened.control;
    }
  } catch (err) {
    console.error('[overseer] no live session, falling back to the cron transport:', err);
    liveUnavailable = true;
    return { text: null, aborted: false };
  }

  const result = await askLiveSession(conn, liveSession, prompt, {
    signal: { get aborted() { return abortTurn; } },
  });

  if (result.ok) return { text: result.envelope, aborted: false };
  if (result.error === 'aborted') return { text: null, aborted: true };

  // The session is suspect now: drop it so the next turn opens a fresh one.
  console.error('[overseer] live turn failed, falling back to the cron transport:', result.error);
  try { liveControl?.close(); } catch { /* already gone */ }
  liveSession = null;
  liveControl = null;
  return { text: null, aborted: false };
}

// ── The watch ─────────────────────────────────────────────────────────────

const LONG_RUNNING_MS = 20 * 60 * 1000;

/** What changed since the last snapshot, in one sentence, or null if nothing
 *  worth a briefing did. Mutates `longRunningReported` in place. */
function detectFleetChange(prev: FleetSnapshot | null, next: FleetSnapshot, longRunningReported: Set<string>): string | null {
  // No previous snapshot (first tick, or first tick after a restart): there
  // is nothing to diff against yet, so this tick can only ever be a false
  // "everything changed" - skip it rather than replaying the whole fleet.
  if (!prev) return null;

  const prevById = new Map(prev.agents.map(a => [a.id, a]));
  const notes: string[] = [];
  // Every transition seen here is also written to the run ledger, which is
  // what lets a later turn say "that is the third time" rather than only
  // "it is waiting". The diff already knows; it used to discard it.
  const observed: RunEvent[] = [];
  for (const a of next.agents) {
    const before = prevById.get(a.id);
    if (before && before.status !== a.status) {
      observed.push({
        at: Date.now(),
        agentId: a.id,
        agentName: a.name,
        project: a.projectPath,
        from: before.status,
        to: a.status,
        task: a.currentTask ? a.currentTask.slice(0, 120) : undefined,
      });
      if (a.status === 'completed') notes.push(`"${a.name}" (${a.id}) finished in ${a.projectPath}`);
      else if (a.status === 'error') notes.push(`"${a.name}" (${a.id}) errored in ${a.projectPath}`);
      else if (a.status === 'waiting') notes.push(`"${a.name}" (${a.id}) is now waiting for input in ${a.projectPath}`);
      if (a.status !== 'running') longRunningReported.delete(a.id);
    }
    if (a.status === 'running' && a.statusDurationMs > LONG_RUNNING_MS && !longRunningReported.has(a.id)) {
      notes.push(`"${a.name}" (${a.id}) has been running for ${formatDuration(a.statusDurationMs)} in ${a.projectPath}`);
      longRunningReported.add(a.id);
    }
  }
  recordRunEvents(observed);
  return notes.length ? notes.join('; ') : null;
}

/**
 * Build a snapshot, compare it with the last one, and only spend a Hermes
 * round trip when something actually changed. Returns the resulting briefing
 * message, or null when there was nothing to ask about (including: paused,
 * or a user turn is already in flight - the timer must never race a live
 * conversation for the one standing cron job).
 */
export async function watchTick(): Promise<OverseerMessage | null> {
  const state = loadState();
  if (state.paused || turnInFlight) return null;

  const snapshot = await buildFleetSnapshot();
  const longRunningReported = new Set(state.longRunningReported);
  const reason = detectFleetChange(state.previousSnapshot, snapshot, longRunningReported);

  // Persisted every tick, changed or not, so a restart resumes the diff from
  // here instead of replaying every agent as "new" on the next tick.
  state.previousSnapshot = snapshot;
  state.longRunningReported = Array.from(longRunningReported);
  saveState(state);

  if (!reason) return null;

  const result = await askOverseer(`Fleet change since the last check: ${reason}.`, { isBriefing: true });
  if (!result.ok) {
    // A briefing has nobody waiting on it, so a refusal here used to be a
    // plain `null`: the five minute cycle failed over and over with nothing
    // to see, which is the same silent failure the API server had when its
    // port was taken. Recorded and logged, so the reason is answerable.
    lastWatchFailure = { reason: result.reason, error: result.error, at: new Date().toISOString() };
    console.warn(`[overseer] check-in produced no briefing (${result.reason}): ${result.error}`);
    return null;
  }
  lastWatchFailure = null;
  return result.message;
}

/** Why the last automatic check-in produced nothing, when it produced nothing.
 *  Cleared by the next one that succeeds. */
let lastWatchFailure: WatchFailure | null = null;

export interface WatchFailure {
  reason: string;
  error: string;
  /** ISO timestamp. */
  at: string;
}

export function getLastWatchFailure(): WatchFailure | null {
  return lastWatchFailure;
}

let watchTimer: ReturnType<typeof setInterval> | null = null;
/** Kept so a settings change can re-arm the timer at the new interval without
 *  the caller having to hand the callback in a second time. */
let watchCallback: ((message: OverseerMessage) => void) | null = null;

function clampInterval(ms: number): number {
  if (!Number.isFinite(ms)) return DEFAULT_WATCH_INTERVAL_MS;
  return Math.min(MAX_WATCH_INTERVAL_MS, Math.max(MIN_WATCH_INTERVAL_MS, Math.round(ms)));
}

/**
 * The shortest gap between two event-driven looks.
 *
 * A single piece of work moves an agent through running, waiting and running
 * again within seconds, and a fleet of six doing that at once is a burst. The
 * overseer should look once when the dust settles, not once per transition:
 * each turn is a real Hermes run and a real cost.
 */
const EVENT_SETTLE_MS = 8_000;
/** And never more often than this, however busy the fleet gets. */
const EVENT_FLOOR_MS = 45_000;

let settleTimer: ReturnType<typeof setTimeout> | null = null;
let lastEventLookAt = 0;
let onFleetChange: (() => void) | null = null;

export function startOverseerWatch(onBriefing: (message: OverseerMessage) => void, intervalMs?: number): void {
  if (watchTimer) return;
  watchCallback = onBriefing;
  const period = clampInterval(intervalMs ?? loadState().settings.watchIntervalMs);

  const look = () => {
    watchTick()
      .then(message => { if (message) onBriefing(message); })
      .catch(err => console.error('[overseer] watch tick failed:', err));
  };

  // The timer is the safety net now, not the mechanism: it catches anything
  // that changes without a status transition (a branch moving, a worktree
  // going dirty) and covers the case where nothing emits at all.
  watchTimer = setInterval(look, period);
  watchTimer.unref?.();

  // The mechanism: react when an agent actually moves. `fleet-change` is
  // emitted by emitAgentStatus for every status transition in the app.
  onFleetChange = () => {
    if (settleTimer) clearTimeout(settleTimer);
    settleTimer = setTimeout(() => {
      settleTimer = null;
      const since = Date.now() - lastEventLookAt;
      if (since < EVENT_FLOOR_MS) return;
      lastEventLookAt = Date.now();
      look();
    }, EVENT_SETTLE_MS);
    settleTimer.unref?.();
  };
  agentStatusEmitter.on('fleet-change', onFleetChange);
}

export function getOverseerSettings(): OverseerSettings {
  return loadState().settings;
}

/**
 * Persist a settings change and, if the interval moved, re-arm the timer so it
 * applies now rather than after the next restart.
 */
export async function applyOverseerModel(
  provider: string,
  model: string,
): Promise<{ success: boolean; error?: string }> {
  const conn = usableHermesConnection();
  if (!conn) return { success: false, error: 'Hermes is not configured.' };
  return setHermesModel(conn, { provider, model });
}

export function setOverseerSettings(patch: Partial<OverseerSettings>): OverseerSettings {
  const state = loadState();
  const next: OverseerSettings = {
    watchIntervalMs: clampInterval(patch.watchIntervalMs ?? state.settings.watchIntervalMs),
    model: patch.model ?? state.settings.model,
    provider: patch.provider ?? state.settings.provider,
    // Only ids of rules that exist: a stale id from an older build must not
    // sit in the list looking like something is authorised.
    autoActions: (patch.autoActions ?? state.settings.autoActions ?? [])
      .filter(id => AUTO_ACTION_RULES.some(r => r.id === id)),
  };
  const intervalChanged = next.watchIntervalMs !== state.settings.watchIntervalMs;
  state.settings = next;
  saveState(state);

  if (intervalChanged && watchTimer && watchCallback) {
    const cb = watchCallback;
    stopOverseerWatch();
    startOverseerWatch(cb, next.watchIntervalMs);
  }
  return next;
}

export function stopOverseerWatch(): void {
  if (watchTimer) clearInterval(watchTimer);
  watchTimer = null;
  if (settleTimer) clearTimeout(settleTimer);
  settleTimer = null;
  if (onFleetChange) agentStatusEmitter.off('fleet-change', onFleetChange);
  onFleetChange = null;
  // watchCallback is deliberately kept: setOverseerSettings re-arms through it.
}

/**
 * Pause the watch, and give up on any turn already running.
 *
 * Pausing used to set a flag the next tick would read, which did nothing at
 * all to a reply already in flight: Hermes kept working and the answer landed
 * in the chat minutes after you had asked it to stop. Worse when the turn was
 * wedged, since pause was the obvious thing to press and the only thing that
 * did not help.
 *
 * The poll loop checks this on every pass, so the turn ends at the next poll
 * rather than at its timeout. The Hermes run itself is already triggered and
 * will finish on the gateway; what stops is Tars waiting for it and posting
 * the result.
 */
export function pauseOverseerWatch(): void {
  const state = loadState();
  state.paused = true;
  saveState(state);
  abortTurn = true;
}

export function resumeOverseerWatch(): void {
  const state = loadState();
  state.paused = false;
  saveState(state);
  abortTurn = false;
}

export function isOverseerWatchPaused(): boolean {
  return loadState().paused;
}
