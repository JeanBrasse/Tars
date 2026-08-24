import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

/**
 * Whether an agent's last session can actually be resumed.
 *
 * `claude --resume <id>` reads the conversation back from
 * `~/.claude/projects/<encoded-path>/<id>.jsonl`. If that file is not there,
 * the binary exits with an error instead of starting, so an agent whose
 * transcript has been cleaned up would simply stop launching. Restarting into
 * a fresh conversation is a worse outcome than resuming and a much better one
 * than not starting at all, so the id is only ever used once the file backing
 * it has been found.
 *
 * The project directory name is Claude Code's own encoding: every `/` and `.`
 * in the path becomes `-` (see decode-project-path.ts, which reverses it).
 * Encoding is lossy, so several paths can encode to the same directory name;
 * that is fine here, because the session id is a UUID and the check is only
 * asking whether this exact transcript exists.
 */

/** Claude Code's project directory name for a filesystem path. */
export function encodeProjectDirName(projectPath: string): string {
  return projectPath.replace(/[/.]/g, '-');
}

export function transcriptPath(projectPath: string, sessionId: string, homeDir = os.homedir()): string {
  return path.join(homeDir, '.claude', 'projects', encodeProjectDirName(projectPath), `${sessionId}.jsonl`);
}

/**
 * The session id to resume, or null.
 *
 * Null covers every reason not to resume: no id recorded, an id that is not a
 * session id, or a transcript that is no longer on disk.
 */
export function resolveResumeSessionId(
  agent: { resumableSessionId?: string; projectPath?: string; worktreePath?: string },
  homeDir = os.homedir(),
): string | null {
  const sessionId = agent.resumableSessionId?.trim();
  if (!sessionId) return null;
  // A UUID and nothing else. This value reaches a command line, and the shape
  // check is what keeps it from being anything but an id.
  if (!/^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/.test(sessionId)) return null;

  // An agent with its own worktree ran there, so that is where its transcript
  // was written. Both are checked because an agent can be moved onto a
  // worktree after the session that is being resumed.
  const roots = [agent.worktreePath, agent.projectPath].filter((p): p is string => !!p);
  for (const root of roots) {
    try {
      if (fs.existsSync(transcriptPath(root, sessionId, homeDir))) return sessionId;
    } catch {
      // An unreadable home directory is not a reason to fail the start.
    }
  }
  return null;
}

/**
 * Agents already started in this run of the app.
 *
 * Resuming is for the first start after a restart, which is the case that used
 * to lose the work. Once an agent has been started here, later starts behave
 * as they always have: a fresh conversation, because that is what a user
 * pressing Start a second time is asking for. Without this, every dispatch
 * would silently reopen an old conversation.
 */
const startedThisRun = new Set<string>();

/** The id to resume for this start, or null. Returns an id at most once per
 *  agent per app run. */
export function consumeResumeSessionId(
  agent: { id: string; resumableSessionId?: string; projectPath?: string; worktreePath?: string },
  homeDir?: string,
): string | null {
  const first = !startedThisRun.has(agent.id);
  startedThisRun.add(agent.id);
  if (!first) return null;
  return resolveResumeSessionId(agent, homeDir);
}

/** Test seam: forget which agents have started. */
export function resetResumeTracking(): void {
  startedThisRun.clear();
}
