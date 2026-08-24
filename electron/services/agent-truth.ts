import * as fs from 'fs';
import * as os from 'os';
import { execFile } from 'child_process';
import { transcriptPath } from '../utils/resume-session';

/**
 * What an agent is actually on, as opposed to what Tars last wrote down.
 *
 * `agent.branchName` and `agent.model` were only ever set by Tars itself, from
 * the edit screen or the create call. Nothing read them back. So an agent that
 * ran `git checkout -b` kept the old branch on its card, and a session where
 * you typed `/model opus` kept the old model, and then the next respawn passed
 * `--model <the old one>` and undid the change without saying anything.
 *
 * The session wins. It is what actually happened; the record is a note Tars
 * made earlier. Both readings are cheap and cached, because the agent list is
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
 * whole point: it reflects a `/model` typed into the terminal.
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
  for (const root of [agent.worktreePath, agent.projectPath].filter((p): p is string => !!p)) {
    const file = transcriptPath(root, sessionId, homeDir);
    if (!fs.existsSync(file)) continue;
    found = lastAssistantModel(file);
    if (found) break;
  }
  modelCache.set(key, { value: found, at: now });
  return found;
}

/**
 * The agent as it really is: its own record, with the branch and the model
 * replaced by what the working tree and the transcript say when they disagree.
 *
 * Only ever fills in; a null reading leaves the stored value alone, so an
 * agent with no session yet still shows the model it was created with.
 */
export function withSessionTruth<T extends {
  model?: string;
  branchName?: string;
  projectPath?: string;
  worktreePath?: string;
  resumableSessionId?: string;
}>(agent: T): T {
  const branch = currentBranch(agent.worktreePath || agent.projectPath);
  const model = sessionModel(agent);
  return {
    ...agent,
    ...(branch ? { branchName: branch } : {}),
    ...(model ? { model } : {}),
  };
}

/** Test seam. */
export function clearAgentTruthCache(): void {
  branchCache.clear();
  modelCache.clear();
}

