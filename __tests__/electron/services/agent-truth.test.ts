import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { encodeProjectDirName } from '../../../electron/utils/resume-session';
import { sessionModel, withSessionTruth, clearAgentTruthCache } from '../../../electron/services/agent-truth';

/**
 * What an agent is actually on.
 *
 * `agent.model` was only ever written by Tars, from the edit screen or the
 * create call. So typing `/model opus` into the terminal changed the session
 * and not the record, the card kept saying the old model, and the next respawn
 * rebuilt the command from that record and quietly put it back.
 *
 * The session wins, because it is what happened. What has to be right is the
 * "only ever fills in" part: a reading that fails must leave the record alone
 * rather than blanking a model the user did choose.
 */

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'tars-truth-'));
const PROJECT = '/Users/noah/Dorothy-fix';
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
    const worktree = '/Users/noah/Dorothy-fix/.worktrees/feat-x';
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
});
