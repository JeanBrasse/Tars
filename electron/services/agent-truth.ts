import * as fs from 'fs';
import * as os from 'os';
import { execFile } from 'child_process';
import { transcriptPath, transcriptRoots } from '../utils/resume-session';

/**
 * What an agent is actually on, as opposed to what Tars last wrote down.
 *
 * `agent.branchName` was only ever set by Tars itself, from the edit screen or
 * the create call, and nothing read it back, so an agent that ran
 * `git checkout -b` kept the old branch on its card. The working tree wins for
 * the branch: it is what actually happened.
 *
 * The model is the other way round, and it used to be the same way. The
 * session's model replaced the record's everywhere, launches included, so the
 * model a session last answered on outlived every choice made after it: moved
 * to Opus 5.5 in the Agents page, thirteen agents relaunched on the model their
 * previous session had used, Opus 5 for most and Opus 4.8 for one. And the edit
 * screen, filled from that list, wrote the old model back into the record on
 * the next save of anything. So the record is the model an agent launches on,
 * and the session's reading travels beside it as `sessionModel`, for a screen
 * that wants to say the session runs something else, after a `/model` typed
 * into it. Both readings are cheap and cached, because the agent list is
 * rebuilt about twice a second.
 */

/** Short enough that a checkout shows up promptly, long enough that a list
 *  refreshing twice a second does not run git twice a second per agent. */
const TTL_MS = 5_000;

const branchCache = new Map<string, { value: string | null; at: number }>();
const modelCache = new Map<string, { value: string | null; at: number }>();

/* ── The branch ──────────────────────────────────────────────────────── */

/**
 * Kicked off in the background and read from the cache.
 *
 * The agent list is built synchronously in an IPC handler and on a route, and
 * neither can wait on git. So a miss returns null and starts the read: the
 * next refresh, a few hundred milliseconds later, has the answer. That is the
 * right trade for a field that changes once an hour at most.
 */
export function currentBranch(cwd: string | undefined): string | null {
  if (!cwd) return null;
  const hit = branchCache.get(cwd);
  const now = Date.now();
  if (hit && now - hit.at < TTL_MS) return hit.value;

  // Mark it fresh before the call, so a burst of list rebuilds spawns one git
  // rather than one per rebuild.
  branchCache.set(cwd, { value: hit?.value ?? null, at: now });
  execFile('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd }, (err, stdout) => {
    const value = err ? null : stdout.trim() || null;
    // HEAD detached reads as "HEAD", which is not a branch name worth showing.
    branchCache.set(cwd, { value: value === 'HEAD' ? null : value, at: Date.now() });
  });
  return hit?.value ?? null;
}

/* ── The model ───────────────────────────────────────────────────────── */

/** The last line of a file, without reading the whole thing into memory twice.
 *  Transcripts run to megabytes and this is called per agent per refresh. */
function lastAssistantModel(file: string): string | null {
  let raw: string;
  try {
    raw = fs.readFileSync(file, 'utf-8');
  } catch {
    return null;
  }
  const lines = raw.split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim();
    if (!line) continue;
    let entry: Record<string, unknown>;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    if (entry.type !== 'assistant') continue;
    const message = entry.message as Record<string, unknown> | undefined;
    const model = typeof message?.model === 'string' ? message.model : null;
    // `<synthetic>` is what Claude Code writes for messages it generated
    // itself; it is not a model anyone chose.
    if (model && model !== '<synthetic>') return model;
  }
  return null;
}

/**
 * The model the session last actually answered on, or null.
 *
 * Read from the transcript rather than from anything Tars stores, which is the
 * whole point: it reflects a `/model` typed into the terminal. A reading for a
 * screen, never for a launch: see the top of this file.
 */
export function sessionModel(
  agent: { resumableSessionId?: string; projectPath?: string; worktreePath?: string },
  homeDir = os.homedir(),
): string | null {
  const sessionId = agent.resumableSessionId?.trim();
  if (!sessionId) return null;

  const key = sessionId;
  const hit = modelCache.get(key);
  const now = Date.now();
  if (hit && now - hit.at < TTL_MS) return hit.value;

  let found: string | null = null;
  for (const root of transcriptRoots(agent.worktreePath, agent.projectPath)) {
    const file = transcriptPath(root, sessionId, homeDir);
    if (!fs.existsSync(file)) continue;
    found = lastAssistantModel(file);
    if (found) break;
  }
  modelCache.set(key, { value: found, at: now });
  return found;
}

/* ── Work still running after the turn ─────────────────────────────────── */

const TASK_NOTE = /<task-notification>([\s\S]*?)<\/task-notification>/g;
const TASK_ID = /<task-id>([^<]+)<\/task-id>/;
const TASK_STATUS = /<status>([^<]+)<\/status>/;
const STOP_TOOLS = new Set(['TaskStop', 'KillShell', 'KillBash']);

/** How much of a transcript's end the local-command probe reads. A command's
 *  three records take a few hundred bytes; a transcript runs to megabytes. */
const LOCAL_COMMAND_TAIL = 256 * 1024;

/**
 * When the agent's session last recorded a local command finishing, in ms since
 * the epoch, or undefined.
 *
 * A command typed by hand at the prompt (/model, /effort, /config ...) runs in
 * the CLI and never reaches the model: no UserPromptSubmit hook fires, and
 * nothing else says the field emptied. What it leaves is three records in the
 * session transcript, `<local-command-caveat>`, `<command-name>` and
 * `<local-command-stdout>`, written when it finishes, not when it opens.
 * Measured on Claude Code 2.1.280: 44 to 74 ms after the Enter or the Esc that
 * closes a /model or /effort picker; the /config panel wrote them only when it
 * finally closed, after a first Esc that merely cleared its filter. By then the
 * command's text has left the field and its panel is gone: the field is empty.
 *
 * Some finish without a record this takes: /help and /config closed without
 * a change write none, and /model cancelled with Esc writes two `system`
 * records (subtype local_command) that are skipped on purpose, since the same
 * pair is written when the "Switch model?" confirmation is backed out of with
 * Esc while the picker stays open (the gate of #128). For those this says
 * nothing.
 */
export function lastLocalCommandAt(
  agent: { currentSessionId?: string; projectPath?: string; worktreePath?: string },
  homeDir = os.homedir(),
): number | undefined {
  const sessionId = agent.currentSessionId?.trim();
  if (!sessionId) return undefined;
  for (const root of transcriptRoots(agent.worktreePath, agent.projectPath)) {
    const file = transcriptPath(root, sessionId, homeDir);
    let fd: number | undefined;
    try {
      fd = fs.openSync(file, 'r');
      const { size, mtimeMs } = fs.fstatSync(fd);
      // Asked every second while a message waits on a field somebody left
      // something in: the tail is read again only when the file has changed.
      const known = lastReadOf.get(file);
      if (known && known.size === size && known.mtimeMs === mtimeMs) return known.at;
      const length = Math.min(size, LOCAL_COMMAND_TAIL);
      const tail = Buffer.alloc(length);
      fs.readSync(fd, tail, 0, length, size - length);
      const at = latestLocalCommand(tail.toString('utf-8'));
      lastReadOf.set(file, { size, mtimeMs, at });
      return at;
    } catch {
      // not in this root
    } finally {
      if (fd !== undefined) fs.closeSync(fd);
    }
  }
  return undefined;
}

/** What lastLocalCommandAt last read in each transcript, and the file it read it from. */
const lastReadOf = new Map<string, { size: number; mtimeMs: number; at: number | undefined }>();

/** The newest local-command record in some transcript lines, as its time. */
function latestLocalCommand(lines: string): number | undefined {
  let latest: number | undefined;
  for (const line of lines.split('\n')) {
    if (!line.includes('<command-name>') && !line.includes('<local-command-stdout>')) continue;
    let entry: Record<string, unknown>;
    try {
      // The first line of a tail is usually cut in two, and fails here.
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    if (entry.type !== 'user') continue;
    const content = (entry.message as { content?: unknown } | undefined)?.content;
    const text = typeof content === 'string'
      ? content
      : Array.isArray(content) ? content.map(b => (typeof b?.text === 'string' ? b.text : '')).join('') : '';
    // The CLI's own record starts with the tag; a prompt that quotes one does not.
    if (!/^\s*<(command-name|local-command-stdout)>/.test(text)) continue;
    const at = Date.parse(String(entry.timestamp ?? ''));
    if (Number.isFinite(at) && (latest === undefined || at > latest)) latest = at;
  }
  return latest;
}

/**
 * The background work this session started and has not heard back from.
 *
 * A turn can end with work still running: a Bash command run in the
 * background, a Monitor, an Agent launched asynchronously. Claude Code ends the
 * turn (Stop, so Tars reads `idle`), and when the work finishes it injects a
 * `<task-notification>` that starts the next turn by itself. Killing the CLI in
 * between kills that work and the turn it was waiting for. Measured on 2.1.280:
 * asked to `sleep 25`, the CLI refused a foreground sleep, ran it in the
 * background and stopped its turn ten seconds in.
 *
 * Read from the transcript, because that is where Claude Code records both
 * ends, and both are structured. Across a week of Noah's transcripts (329
 * background starts): a Bash start carries `toolUseResult.backgroundTaskId`,
 * a Monitor `toolUseResult.taskId`, an asynchronous Agent `agentId` with
 * `isAsync`; 322 were followed by a note naming the id with a `<status>`
 * (completed, failed, killed, stopped), 7 were stopped with TaskStop, which
 * sends no note, and the other 3 were still running. A Monitor's event notes
 * carry no status: only a status ends it.
 *
 * `sinceMs` is when the CLI now running was launched. A resumed or forked
 * session copies the earlier conversation into its transcript, stamped with the
 * new session id but with the old timestamps, and a task started by a process
 * that is gone is not running.
 */
export function pendingBackgroundWork(
  agent: { currentSessionId?: string; projectPath?: string; worktreePath?: string },
  sinceMs: number,
  homeDir = os.homedir(),
): string[] {
  const sessionId = agent.currentSessionId?.trim();
  if (!sessionId) return [];
  let raw: string | undefined;
  for (const root of transcriptRoots(agent.worktreePath, agent.projectPath)) {
    try {
      raw = fs.readFileSync(transcriptPath(root, sessionId, homeDir), 'utf-8');
      break;
    } catch {
      // not in this root
    }
  }
  if (!raw) return [];

  const started = new Set<string>();
  const finished = new Set<string>();
  const monitorCalls = new Set<string>();
  for (const line of raw.split('\n')) {
    // Most lines are none of these, and a transcript runs to megabytes.
    if (!/backgroundTaskId|isAsync|taskId|task-notification|Monitor|TaskStop|KillShell|KillBash/.test(line)) continue;
    let entry: Record<string, unknown>;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    if (!(Date.parse(String(entry.timestamp ?? '')) >= sinceMs)) continue;
    const content = (entry.message as { content?: unknown } | undefined)?.content;
    const blocks = Array.isArray(content) ? content as Array<Record<string, unknown>> : [];

    if (entry.type === 'assistant') {
      for (const block of blocks) {
        if (block.type !== 'tool_use') continue;
        if (block.name === 'Monitor' && typeof block.id === 'string') monitorCalls.add(block.id);
        if (STOP_TOOLS.has(String(block.name))) {
          const input = (block.input ?? {}) as Record<string, unknown>;
          const id = input.task_id ?? input.shell_id ?? input.bash_id;
          if (typeof id === 'string') finished.add(id);
        }
      }
      continue;
    }
    if (entry.type !== 'user') continue;

    const result = entry.toolUseResult as Record<string, unknown> | undefined;
    if (result && typeof result === 'object') {
      if (typeof result.backgroundTaskId === 'string') started.add(result.backgroundTaskId);
      else if (result.isAsync === true && typeof result.agentId === 'string') started.add(result.agentId);
      else if (typeof result.taskId === 'string'
        && blocks.some(b => b.type === 'tool_result' && monitorCalls.has(String(b.tool_use_id)))) {
        started.add(result.taskId);
      }
    }
    const text = typeof content === 'string'
      ? content
      : blocks.map(b => (typeof b.text === 'string' ? b.text : '')).join('\n');
    for (const [, note] of text.matchAll(TASK_NOTE)) {
      const id = note.match(TASK_ID)?.[1];
      const status = note.match(TASK_STATUS)?.[1]?.trim();
      if (id && status && status !== 'running') finished.add(id);
    }
  }
  return [...started].filter(id => !finished.has(id));
}

/**
 * The agent as it really is: its own record, with the branch replaced by what
 * the working tree says, and the model its session last answered on beside the
 * one it is set to, as `sessionModel`.
 *
 * `model` stays the record's: it is what the next launch uses, and what the
 * edit screen shows and saves back.
 *
 * Only ever fills in; a null reading leaves the stored value alone, and an
 * agent with no session yet has no `sessionModel`.
 */
export function withSessionTruth<T extends {
  model?: string;
  branchName?: string;
  projectPath?: string;
  worktreePath?: string;
  resumableSessionId?: string;
}>(agent: T): T & { sessionModel?: string } {
  const branch = currentBranch(agent.worktreePath || agent.projectPath);
  const model = sessionModel(agent);
  return {
    ...agent,
    ...(branch ? { branchName: branch } : {}),
    ...(model ? { sessionModel: model } : {}),
  };
}

/** Test seam. */
export function clearAgentTruthCache(): void {
  branchCache.clear();
  modelCache.clear();
}


/**
 * When the session's turn was last interrupted, or undefined.
 *
 * Claude Code records an interrupt in its transcript as a user entry whose text
 * begins `[Request interrupted by user` (`... for tool use]` when a tool was
 * waiting on the user), and sends no hook for it: no Stop, and no idle prompt
 * in the 90 s the Audit waited. Refusing a permission, with "No" or with Esc,
 * writes that entry (the Audit's gate of #174), and it is the only sign that
 * the dialog is gone. Read under both spellings of the project path, and
 * again only when the file has changed: the writer asks every second while a
 * message waits on a dialog.
 */
export function lastInterruptAt(
  agent: { currentSessionId?: string; projectPath?: string; worktreePath?: string },
  homeDir = os.homedir(),
): number | undefined {
  const sessionId = agent.currentSessionId?.trim();
  if (!sessionId) return undefined;
  const roots = transcriptRoots(agent.worktreePath, agent.projectPath);
  let latest: number | undefined;
  for (const root of roots) {
    const file = transcriptPath(root, sessionId, homeDir);
    let fd: number | undefined;
    try {
      fd = fs.openSync(file, 'r');
      const { size, mtimeMs } = fs.fstatSync(fd);
      const known = interruptReadOf.get(file);
      let at: number | undefined;
      if (known && known.size === size && known.mtimeMs === mtimeMs) {
        at = known.at;
      } else {
        const length = Math.min(size, LOCAL_COMMAND_TAIL);
        const tail = Buffer.alloc(length);
        fs.readSync(fd, tail, 0, length, size - length);
        at = latestInterrupt(tail.toString('utf-8'));
        interruptReadOf.set(file, { size, mtimeMs, at });
      }
      if (at !== undefined && (latest === undefined || at > latest)) latest = at;
    } catch {
      // not in this root
    } finally {
      if (fd !== undefined) fs.closeSync(fd);
    }
  }
  return latest;
}

const interruptReadOf = new Map<string, { size: number; mtimeMs: number; at: number | undefined }>();

function latestInterrupt(lines: string): number | undefined {
  let latest: number | undefined;
  for (const line of lines.split('\n')) {
    if (!line.includes('[Request interrupted by user')) continue;
    let entry: Record<string, unknown>;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    if (entry.type !== 'user') continue;
    const content = (entry.message as { content?: unknown } | undefined)?.content;
    const text = typeof content === 'string'
      ? content
      : Array.isArray(content) ? content.map(b => (typeof b?.text === 'string' ? b.text : '')).join('') : '';
    if (!text.trimStart().startsWith('[Request interrupted by user')) continue;
    const at = Date.parse(String(entry.timestamp ?? ''));
    if (Number.isFinite(at) && (latest === undefined || at > latest)) latest = at;
  }
  return latest;
}
