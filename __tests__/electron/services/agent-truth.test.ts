import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { encodeProjectDirName } from '../../../electron/utils/resume-session';
import { sessionModel, withSessionTruth, clearAgentTruthCache, pendingBackgroundWork } from '../../../electron/services/agent-truth';

/**
 * What an agent is actually on.
 *
 * `agent.model` was only ever written by Tars, from the edit screen or the
 * create call. So typing `/model opus` into the terminal changed the session
 * and not the record, the card kept saying the old model, and the next respawn
 * rebuilt the command from that record and quietly put it back.
 *
 * The session is read back, and reported beside the record as `sessionModel`:
 * it used to replace the record, launches included, which put agents moved to
 * a new model back on the one their previous session had used. What has to be
 * right is the "only ever fills in" part: a reading that fails must leave the
 * record alone rather than blanking a model the user did choose.
 */

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'tars-truth-'));
const PROJECT = '/Users/noah/tars';
const SESSION = '4ab31f00-ce51-4676-ab80-4023cf6e3f4e';

function writeTranscript(projectPath: string, sessionId: string, lines: string[]) {
  const dir = path.join(home, '.claude', 'projects', encodeProjectDirName(projectPath));
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${sessionId}.jsonl`), lines.join('\n') + '\n');
}

const assistant = (model: string) =>
  JSON.stringify({ type: 'assistant', message: { model, usage: { input_tokens: 1 } } });

beforeEach(() => {
  fs.rmSync(path.join(home, '.claude'), { recursive: true, force: true });
  clearAgentTruthCache();
});

afterAll(() => fs.rmSync(home, { recursive: true, force: true }));

describe('reading the model back from the session', () => {
  it('reports the model the session last answered on', () => {
    writeTranscript(PROJECT, SESSION, [assistant('claude-sonnet-5'), assistant('claude-opus-5')]);
    expect(sessionModel({ resumableSessionId: SESSION, projectPath: PROJECT }, home)).toBe('claude-opus-5');
  });

  it('ignores messages Claude Code generated itself', () => {
    // `<synthetic>` is not a model anyone chose.
    writeTranscript(PROJECT, SESSION, [assistant('claude-opus-5'), assistant('<synthetic>')]);
    expect(sessionModel({ resumableSessionId: SESSION, projectPath: PROJECT }, home)).toBe('claude-opus-5');
  });

  it('skips lines that are not assistant turns', () => {
    writeTranscript(PROJECT, SESSION, [
      assistant('claude-opus-5'),
      JSON.stringify({ type: 'user', message: { model: 'not-a-model' } }),
    ]);
    expect(sessionModel({ resumableSessionId: SESSION, projectPath: PROJECT }, home)).toBe('claude-opus-5');
  });

  it('survives a corrupt line', () => {
    const dir = path.join(home, '.claude', 'projects', encodeProjectDirName(PROJECT));
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, `${SESSION}.jsonl`), `{not json\n${assistant('claude-opus-5')}\n`);
    expect(sessionModel({ resumableSessionId: SESSION, projectPath: PROJECT }, home)).toBe('claude-opus-5');
  });

  it('looks in the worktree, which is where an agent with one ran', () => {
    const worktree = '/Users/noah/tars/.worktrees/feat-x';
    writeTranscript(worktree, SESSION, [assistant('claude-haiku-4-5')]);
    expect(
      sessionModel({ resumableSessionId: SESSION, projectPath: PROJECT, worktreePath: worktree }, home),
    ).toBe('claude-haiku-4-5');
  });

  it('reports nothing when there is no session or no transcript', () => {
    expect(sessionModel({ projectPath: PROJECT }, home)).toBeNull();
    expect(sessionModel({ resumableSessionId: SESSION, projectPath: PROJECT }, home)).toBeNull();
  });

  it('reports nothing for a transcript with no assistant turn yet', () => {
    writeTranscript(PROJECT, SESSION, [JSON.stringify({ type: 'user', message: {} })]);
    expect(sessionModel({ resumableSessionId: SESSION, projectPath: PROJECT }, home)).toBeNull();
  });
});

describe('what the agent list serves', () => {
  it('leaves a record alone when there is nothing to read', () => {
    // The case that matters: a failed reading must not blank a model the user
    // did choose.
    const agent = { id: 'a1', model: 'claude-sonnet-5', branchName: 'feat/x', projectPath: PROJECT };
    const out = withSessionTruth(agent);
    expect(out.model).toBe('claude-sonnet-5');
    expect(out.branchName).toBe('feat/x');
  });

  it('keeps every other field untouched', () => {
    const agent = { id: 'a1', name: 'Frontend', model: 'm', projectPath: PROJECT, status: 'idle' };
    expect(withSessionTruth(agent)).toMatchObject({ id: 'a1', name: 'Frontend', status: 'idle' });
  });

  it("serves the model the agent is set to, and the session's beside it", () => {
    // Moved to Opus 5.5 in the Agents page, its last session on Opus 5: the
    // list used to serve Opus 5 as the model, the edit screen showed it, and
    // the next save of anything wrote it back into the record.
    const dir = path.join(os.homedir(), '.claude', 'projects', encodeProjectDirName(PROJECT));
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, `${SESSION}.jsonl`), `${assistant('claude-opus-5')}\n`);
    try {
      const out = withSessionTruth({ id: 'a1', model: 'claude-opus-5-5', projectPath: PROJECT, resumableSessionId: SESSION });
      expect(out.model).toBe('claude-opus-5-5');
      expect(out.sessionModel).toBe('claude-opus-5');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('work a session left running in the background', () => {
  const SINCE = Date.parse('2026-09-22T20:41:30.000Z');
  const at = (seconds: number) => new Date(SINCE + seconds * 1000).toISOString();
  const agent = { currentSessionId: SESSION, projectPath: PROJECT };
  /** The records Claude Code 2.1.280 writes, trimmed to the fields read. */
  const call = (id: string, name: string, s: number, input: Record<string, unknown> = {}) =>
    JSON.stringify({ type: 'assistant', timestamp: at(s), message: { content: [{ type: 'tool_use', id, name, input }] } });
  const result = (toolUseId: string, s: number, toolUseResult: Record<string, unknown>) =>
    JSON.stringify({ type: 'user', timestamp: at(s), toolUseResult, message: { content: [{ type: 'tool_result', tool_use_id: toolUseId, content: 'running' }] } });
  const note = (taskId: string, s: number, status?: string) =>
    JSON.stringify({ type: 'user', timestamp: at(s), message: { content:
      `<task-notification>\n<task-id>${taskId}</task-id>\n${status ? `<status>${status}</status>\n` : ''}<summary>x</summary>\n</task-notification>` } });

  it('names a background command until its note says how it ended', () => {
    writeTranscript(PROJECT, SESSION, [call('t1', 'Bash', 5), result('t1', 6, { backgroundTaskId: 'bgncs8rbv' })]);
    expect(pendingBackgroundWork(agent, SINCE, home)).toEqual(['bgncs8rbv']);

    writeTranscript(PROJECT, SESSION, [call('t1', 'Bash', 5), result('t1', 6, { backgroundTaskId: 'bgncs8rbv' }), note('bgncs8rbv', 44, 'completed')]);
    expect(pendingBackgroundWork(agent, SINCE, home)).toEqual([]);
  });

  it.each(['failed', 'killed', 'stopped'])('takes a note that says %s as an end', (status) => {
    writeTranscript(PROJECT, SESSION, [call('t1', 'Bash', 5), result('t1', 6, { backgroundTaskId: 'b1' }), note('b1', 9, status)]);
    expect(pendingBackgroundWork(agent, SINCE, home)).toEqual([]);
  });

  it('keeps a Monitor running through its events, which carry no status', () => {
    const lines = [call('m1', 'Monitor', 5), result('m1', 6, { taskId: 'biuw2fli9' }), note('biuw2fli9', 20), note('biuw2fli9', 30)];
    writeTranscript(PROJECT, SESSION, lines);
    expect(pendingBackgroundWork(agent, SINCE, home)).toEqual(['biuw2fli9']);

    writeTranscript(PROJECT, SESSION, [...lines, note('biuw2fli9', 40, 'stopped')]);
    expect(pendingBackgroundWork(agent, SINCE, home)).toEqual([]);
  });

  it('counts an Agent launched asynchronously', () => {
    writeTranscript(PROJECT, SESSION, [call('a1', 'Agent', 5), result('a1', 6, { isAsync: true, status: 'async_launched', agentId: 'a76fbebc0fee4081a' })]);
    expect(pendingBackgroundWork(agent, SINCE, home)).toEqual(['a76fbebc0fee4081a']);
  });

  it('takes a task stopped with TaskStop, which sends no note, as ended', () => {
    writeTranscript(PROJECT, SESSION, [
      call('t1', 'Bash', 5), result('t1', 6, { backgroundTaskId: 'bz3s5cvjo' }),
      call('s1', 'TaskStop', 9, { task_id: 'bz3s5cvjo' }),
    ]);
    expect(pendingBackgroundWork(agent, SINCE, home)).toEqual([]);
  });

  it('ignores what an earlier process started: a forked transcript copies it with the old times', () => {
    writeTranscript(PROJECT, SESSION, [call('t1', 'Bash', -30), result('t1', -29, { backgroundTaskId: 'from-before' })]);
    expect(pendingBackgroundWork(agent, SINCE, home)).toEqual([]);
  });

  it('does not take a task id from any other tool for background work', () => {
    // The todo tools answer with a taskId too.
    writeTranscript(PROJECT, SESSION, [call('c1', 'TaskCreate', 5), result('c1', 6, { taskId: '3' })]);
    expect(pendingBackgroundWork(agent, SINCE, home)).toEqual([]);
  });

  it('reports nothing without a session or a transcript', () => {
    expect(pendingBackgroundWork({ projectPath: PROJECT }, SINCE, home)).toEqual([]);
    expect(pendingBackgroundWork(agent, SINCE, home)).toEqual([]);
  });
});
