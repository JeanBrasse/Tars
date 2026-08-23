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
import {
  probeHermes,
  createHermesCron,
  updateHermesCron,
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

export interface OverseerMessage {
  id: string;
  role: 'user' | 'overseer';
  text: string;
  action: OverseerAction | null;
  isBriefing?: boolean;
  timestamp: string;
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
}

function defaultState(): OverseerState {
  return { jobId: null, messages: [], previousSnapshot: null, longRunningReported: [], paused: false };
}

function loadState(): OverseerState {
  try {
    if (!fs.existsSync(OVERSEER_FILE)) return defaultState();
    const raw = JSON.parse(fs.readFileSync(OVERSEER_FILE, 'utf-8'));
    return { ...defaultState(), ...raw };
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

export function getOverseerHistory(): OverseerMessage[] {
  return loadState().messages;
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
  const recent = history.slice(-HISTORY_TURN_LIMIT);
  let omitted = history.length - recent.length;
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
    '- Reply with EXACTLY one JSON object and nothing else, before or after it, in this shape:',
    '  {"say": "<what you tell Noah, plain text or light markdown>", "action": null}',
    '  or, only when proposing to message one specific agent:',
    '  {"say": "<...>", "action": {"kind": "message_agent", "agent_id": "<id from the snapshot>", "text": "<the exact message to send>"}}',
    '- If no agent in the snapshot is the right target, action must be null.',
  ].join('\n');

  const turnLabel = opts.isBriefing
    ? '=== AUTOMATIC CHECK-IN (Tars\' watch timer, not a message from Noah) ==='
    : '=== NOAH ===';
  const turnBody = opts.isBriefing
    ? `${userMessage}\nThis is an unprompted check-in triggered by a fleet change, not a question. If something is worth flagging, say it concisely; otherwise say something minimal like "Nothing worth flagging."`
    : userMessage;

  return [
    instructions,
    '',
    '=== FLEET SNAPSHOT ===',
    serializeSnapshot(snapshot),
    '',
    '=== CONVERSATION SO FAR ===',
    history.length ? serializeHistory(history) : '(nothing yet, this is the first turn)',
    '',
    turnLabel,
    turnBody,
  ].join('\n');
}

interface ParsedEnvelope {
  say: string;
  action: { agentId: string; text: string } | null;
}

function parseEnvelope(raw: string): ParsedEnvelope {
  const text = raw.trim();
  // Reply is asked to be exactly one JSON object; tolerate the one deviation
  // seen in testing, a markdown code fence wrapped around it.
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = (fenced ? fenced[1] : text).trim();
  try {
    const parsed = JSON.parse(candidate) as { say?: unknown; action?: unknown };
    if (parsed && typeof parsed.say === 'string') {
      const a = parsed.action as { kind?: unknown; agent_id?: unknown; text?: unknown } | null | undefined;
      if (a && a.kind === 'message_agent' && typeof a.agent_id === 'string' && typeof a.text === 'string') {
        return { say: parsed.say, action: { agentId: a.agent_id, text: a.text } };
      }
      return { say: parsed.say, action: null };
    }
  } catch {
    // Not valid JSON - fall through to the prose fallback below.
  }
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
export async function askOverseer(userMessage: string, opts: { isBriefing?: boolean } = {}): Promise<AskOverseerResult> {
  if (turnInFlight) {
    return { ok: false, reason: 'busy', error: 'The overseer is already handling another turn; try again in a moment.' };
  }
  turnInFlight = true;
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

    let jobResult = await ensureOverseerJob(conn, state);
    if ('error' in jobResult) {
      return { ok: false, reason: jobResult.needsSignIn ? 'needs_sign_in' : 'error', error: jobResult.error };
    }
    let jobId = jobResult.jobId;

    const snapshot = await buildFleetSnapshot();
    const prompt = composeTurn(snapshot, state.messages, userMessage, opts);

    let update = await updateHermesCron(conn, jobId, { prompt });
    if (!update.success && /not found|no such job|404/i.test(update.error || '')) {
      // The job was deleted out from under us (by hand, or gateway-side):
      // forget the stale id and create a replacement, once.
      state.jobId = null;
      jobResult = await ensureOverseerJob(conn, state);
      if ('error' in jobResult) {
        return { ok: false, reason: jobResult.needsSignIn ? 'needs_sign_in' : 'error', error: jobResult.error };
      }
      jobId = jobResult.jobId;
      update = await updateHermesCron(conn, jobId, { prompt });
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

    const envelope = parseEnvelope(assistantMsg.content);

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

    const overseerMsg: OverseerMessage = {
      id: uuidv4(),
      role: 'overseer',
      text: envelope.say,
      action,
      isBriefing: opts.isBriefing,
      timestamp: new Date().toISOString(),
    };

    // A briefing has no corresponding user turn: it wasn't asked for.
    if (!opts.isBriefing) {
      state.messages.push({ id: uuidv4(), role: 'user', text: userMessage, action: null, timestamp: new Date(triggeredAt).toISOString() });
    }
    state.messages.push(overseerMsg);
    // Bound the persisted history so overseer.json doesn't grow forever.
    if (state.messages.length > 400) state.messages = state.messages.slice(-400);
    saveState(state);

    return { ok: true, message: overseerMsg };
  } finally {
    turnInFlight = false;
  }
}

// ── The watch ─────────────────────────────────────────────────────────────

const LONG_RUNNING_MS = 20 * 60 * 1000;
export const DEFAULT_WATCH_INTERVAL_MS = 5 * 60 * 1000;

/** What changed since the last snapshot, in one sentence, or null if nothing
 *  worth a briefing did. Mutates `longRunningReported` in place. */
function detectFleetChange(prev: FleetSnapshot | null, next: FleetSnapshot, longRunningReported: Set<string>): string | null {
  // No previous snapshot (first tick, or first tick after a restart): there
  // is nothing to diff against yet, so this tick can only ever be a false
  // "everything changed" - skip it rather than replaying the whole fleet.
  if (!prev) return null;

  const prevById = new Map(prev.agents.map(a => [a.id, a]));
  const notes: string[] = [];
  for (const a of next.agents) {
    const before = prevById.get(a.id);
    if (before && before.status !== a.status) {
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
  return result.ok ? result.message : null;
}

let watchTimer: ReturnType<typeof setInterval> | null = null;

export function startOverseerWatch(onBriefing: (message: OverseerMessage) => void, intervalMs = DEFAULT_WATCH_INTERVAL_MS): void {
  if (watchTimer) return;
  watchTimer = setInterval(() => {
    watchTick()
      .then(message => { if (message) onBriefing(message); })
      .catch(err => console.error('[overseer] watch tick failed:', err));
  }, intervalMs);
  watchTimer.unref?.();
}

export function stopOverseerWatch(): void {
  if (watchTimer) clearInterval(watchTimer);
  watchTimer = null;
}

export function pauseOverseerWatch(): void {
  const state = loadState();
  state.paused = true;
  saveState(state);
}

export function resumeOverseerWatch(): void {
  const state = loadState();
  state.paused = false;
  saveState(state);
}

export function isOverseerWatchPaused(): boolean {
  return loadState().paused;
}
