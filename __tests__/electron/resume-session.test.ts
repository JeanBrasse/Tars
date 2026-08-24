import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  encodeProjectDirName,
  resolveResumeSessionId,
  consumeResumeSessionId,
  resetResumeTracking,
} from '../../electron/utils/resume-session';

/**
 * Resuming an agent's conversation after a restart.
 *
 * Updating Tars restarts Electron, which kills every PTY, and every agent came
 * back with an empty conversation. The session id was recorded but never
 * survived the restart: `currentSessionId` is ownership and is cleared on load
 * on purpose, so a second field records where the work got to.
 *
 * The part that has to be right is the refusal. `claude --resume <id>` exits
 * rather than starting when the transcript is gone, so an id that cannot be
 * backed by a file on disk must never reach the command line: an agent that
 * starts fresh is a worse outcome than resuming, and an agent that does not
 * start at all is much worse than both.
 */

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'tars-resume-'));
const PROJECT = '/Users/noah/tars';
const SESSION = '4ab31f00-ce51-4676-ab80-4023cf6e3f4e';

function writeTranscript(projectPath: string, sessionId: string) {
  const dir = path.join(home, '.claude', 'projects', encodeProjectDirName(projectPath));
  fs.mkdirSync(dir, { recursive: true });
  try {
    fs.writeFileSync(path.join(dir, `${sessionId}.jsonl`), '{"type":"user"}\n');
  } catch {
    // Hostile ids are also unwritable filenames, which is beside the point:
    // the assertion is that they are refused whatever is on disk.
  }
}

beforeEach(() => {
  fs.rmSync(path.join(home, '.claude'), { recursive: true, force: true });
  resetResumeTracking();
});

afterAll(() => fs.rmSync(home, { recursive: true, force: true }));

describe('finding the transcript', () => {
  it('encodes a project path the way Claude Code does', () => {
    // Both slashes and dots become dashes.
    expect(encodeProjectDirName('/Users/noah/docs.octav.fi')).toBe('-Users-noah-docs-octav-fi');
  });

  it('resumes when the transcript is on disk', () => {
    writeTranscript(PROJECT, SESSION);
    expect(resolveResumeSessionId({ resumableSessionId: SESSION, projectPath: PROJECT }, home)).toBe(SESSION);
  });

  it('refuses when the transcript has been cleaned up', () => {
    expect(resolveResumeSessionId({ resumableSessionId: SESSION, projectPath: PROJECT }, home)).toBeNull();
  });

  it('looks in the worktree, which is where an agent with one actually ran', () => {
    const worktree = '/Users/noah/tars/.worktrees/feat-x';
    writeTranscript(worktree, SESSION);
    expect(
      resolveResumeSessionId({ resumableSessionId: SESSION, projectPath: PROJECT, worktreePath: worktree }, home),
    ).toBe(SESSION);
  });

  it('refuses when nothing was recorded', () => {
    expect(resolveResumeSessionId({ projectPath: PROJECT }, home)).toBeNull();
    expect(resolveResumeSessionId({ resumableSessionId: '', projectPath: PROJECT }, home)).toBeNull();
    expect(resolveResumeSessionId({ resumableSessionId: '   ', projectPath: PROJECT }, home)).toBeNull();
  });

  it('refuses anything that is not a session id, whatever is on disk', () => {
    // This value reaches a command line. A shape check is what keeps it from
    // being a flag, a path, or a shell fragment.
    for (const bad of ['../../etc/passwd', 'a b', "x'; rm -rf /", '--dangerously-skip-permissions', 'not-a-uuid']) {
      writeTranscript(PROJECT, bad);
      expect(resolveResumeSessionId({ resumableSessionId: bad, projectPath: PROJECT }, home)).toBeNull();
    }
  });
});

describe('resuming happens once per run', () => {
  it('resumes the first start and not the second', () => {
    writeTranscript(PROJECT, SESSION);
    const agent = { id: 'a1', resumableSessionId: SESSION, projectPath: PROJECT };

    // The restart: pick the conversation back up.
    expect(consumeResumeSessionId(agent, home)).toBe(SESSION);
    // Pressing Start again is a request for a fresh conversation, which is
    // what it has always meant.
    expect(consumeResumeSessionId(agent, home)).toBeNull();
  });

  it('tracks agents independently', () => {
    writeTranscript(PROJECT, SESSION);
    const a = { id: 'a1', resumableSessionId: SESSION, projectPath: PROJECT };
    const b = { id: 'b1', resumableSessionId: SESSION, projectPath: PROJECT };

    expect(consumeResumeSessionId(a, home)).toBe(SESSION);
    expect(consumeResumeSessionId(b, home)).toBe(SESSION);
  });
});

describe('the wiring holds', () => {
  const read = (p: string) => fs.readFileSync(p, 'utf-8');

  it('records the session where a restart can still find it', () => {
    const hooks = read('electron/services/api-routes/hooks-routes.ts');
    // Both, together: currentSessionId is ownership, resumableSessionId is the
    // memory of where the work got to.
    expect(hooks).toContain('agent.resumableSessionId = session_id;');
  });

  it('keeps it across a load, unlike the ownership field', () => {
    const manager = read('electron/core/agent-manager.ts');
    expect(manager).toContain('agent.currentSessionId = undefined;');
    // If a future change starts clearing it here, resuming silently stops
    // working and nothing else fails.
    expect(manager).not.toContain('agent.resumableSessionId = undefined;');
  });

  it('every caller that builds a CLI command passes the resume id', () => {
    // Four call sites build the interactive command, and the failure mode for
    // this feature is a fifth one being added without it: everything keeps
    // working, and that agent quietly stops resuming.
    const callers = [
      'electron/handlers/ipc-handlers.ts',
      'electron/services/telegram-bot.ts',
      'electron/services/api-routes/agent-routes.ts',
    ];
    for (const file of callers) {
      const src = read(file);
      const builds = src.split('buildInteractiveCommand({').length - 1;
      const passes = src.split('resumeSessionId: consumeResumeSessionId(').length - 1;
      expect(passes, `${file} builds ${builds} commands but passes the resume id ${passes} times`).toBe(builds);
    }
  });

  it('claude turns it into the flag its binary documents', () => {
    const provider = read('electron/providers/claude-provider.ts');
    expect(provider).toContain("command += ` --resume '${params.resumeSessionId}'`");
  });
});
