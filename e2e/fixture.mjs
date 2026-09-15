import * as fs from 'fs';
import * as path from 'path';

/**
 * What the sandboxed app has in it when we photograph it.
 *
 * The suite used to boot against an empty HOME, so every surface rendered its
 * own empty state. That is the least interesting version of each screen: an
 * empty list cannot show a status colour, a row rhythm, a truncation, or a
 * column that has more cards than fit. The screenshots were guarding almost
 * nothing, and they were no use as documentation either.
 *
 * The data below is fictional but shaped exactly like the real thing, so it
 * exercises the same code paths: several providers, every status, a worktree
 * branch, a long name that has to truncate, and one agent with an error.
 *
 * It is written into the sandbox HOME before Electron launches, which is the
 * only moment the app has not yet read it.
 */

const ISO = (daysAgo, hour = 12) => {
  // Fixed clock: a relative timestamp would make every screenshot differ from
  // the last run and the baselines would never settle.
  const base = Date.UTC(2026, 7, 20, hour, 0, 0);
  return new Date(base - daysAgo * 86_400_000).toISOString();
};

// Relative to the sandbox HOME. Absolute paths outside it are not ours to
// create - the first attempt used /Users/e2e and died on EACCES.
const REL_PROJECT = 'projects/tars';
const REL_SECOND = 'projects/1212-capital';
let PROJECT = REL_PROJECT;
let SECOND = REL_SECOND;

const AGENTS = [
  {
    id: 'a1', name: 'Orchestrator', character: 'wizard', provider: 'claude',
    model: 'claude-opus-5', status: 'running', role: 'orchestrator',
    orchestratorMode: true, projectPath: REL_PROJECT, effort: 'high',
    currentTask: 'delegate_task frontend « fix the scroll lock »',
    permissionMode: 'auto', skills: ['superpowers'],
  },
  {
    id: 'a2', name: 'Frontend Engineer', character: 'robot', provider: 'claude',
    model: 'claude-sonnet-5', status: 'waiting', role: 'worker',
    projectPath: REL_PROJECT, branchName: 'feat/frontend', worktreePath: true,
    currentTask: 'Apply patch to TerminalGrid.tsx', effort: 'medium',
  },
  {
    id: 'a3', name: 'Backend Engineer', character: 'robot', provider: 'codex',
    model: 'gpt-5.3-codex', status: 'running', role: 'worker',
    projectPath: REL_PROJECT, branchName: 'feat/backend', worktreePath: true,
    currentTask: 'npm run build', effort: 'medium',
  },
  {
    id: 'a4', name: 'QA', character: 'robot', provider: 'gemini',
    model: 'gemini-3-pro', status: 'idle', role: 'worker',
    projectPath: REL_PROJECT, branchName: 'feat/qa', effort: 'low',
  },
  {
    id: 'a5', name: 'Database migration and schema review', character: 'robot',
    provider: 'grok', model: 'grok-4.6', status: 'error', role: 'worker',
    projectPath: REL_SECOND, currentTask: 'ECONNREFUSED 127.0.0.1:5432', effort: 'medium',
  },
  {
    id: 'a6', name: 'Audit', character: 'robot', provider: 'deepseek',
    model: 'deepseek-chat', status: 'idle', role: 'worker',
    projectPath: REL_SECOND, effort: 'high',
  },
].map((a, i) => ({
  createdAt: ISO(6 - i),
  lastActivity: ISO(0, 9 + i),
  skills: [],
  ...a,
}));

const KANBAN = {
  tasks: [
    { id: 't1', title: 'Statusline spawns 32 processes per render', column: 'triage', tags: ['perf'], assignee: 'Audit', createdAt: ISO(3) },
    { id: 't2', title: 'Gemini writes memory but never reads it', column: 'triage', tags: ['memory'], assignee: 'Audit', createdAt: ISO(3) },
    { id: 't3', title: 'Wire ACP into the terminal view', column: 'todo', tags: ['acp'], assignee: 'Backend Engineer', createdAt: ISO(2) },
    { id: 't4', title: 'Light theme pass on Review', column: 'todo', tags: ['design'], assignee: 'Frontend Engineer', createdAt: ISO(2) },
    { id: 't5', title: 'Per-provider budgets in Usage', column: 'running', tags: ['usage'], assignee: 'Frontend Engineer', createdAt: ISO(1) },
    { id: 't6', title: 'Atomic writes for agents.json', column: 'review', tags: ['persistence'], assignee: 'Backend Engineer', createdAt: ISO(1) },
    { id: 't7', title: 'Memory hub federates five sources', column: 'done', tags: ['memory'], assignee: 'Backend Engineer', createdAt: ISO(4) },
    { id: 't8', title: 'Schedules page', column: 'done', tags: ['hermes'], assignee: 'Frontend Engineer', createdAt: ISO(5) },
  ],
};

/**
 * The session the Orchestrator's panel history reads, in the panel history
 * sandbox only.
 *
 * The shared sweep leaves auto start on, so opening the Dashboard starts every
 * agent on the board as a real CLI. A claude panel's history then depends on
 * how fast that CLI registers a session of its own, and a seeded
 * resumableSessionId would be handed to a real `claude --resume`. With auto
 * start off nothing starts, and the conversation on screen is exactly this one.
 */
const HISTORY_SESSION = '7c1e4f2a-9b3d-4e8f-a6c5-2d1b0f9e8a73';

/**
 * Shaped like the records Claude Code writes, the ones the reader drops
 * included: an attachment, an empty thinking block, a tool answer that went
 * fine and one that failed.
 */
function historyTranscript(cwd) {
  const at = (minute, second) => new Date(Date.UTC(2026, 7, 20, 9, minute, second)).toISOString();
  let n = 0;
  const record = (type, timestamp, fields) => ({
    parentUuid: null, isSidechain: false, userType: 'external', cwd, sessionId: HISTORY_SESSION,
    version: '2.1.0', gitBranch: 'main', type,
    uuid: `5b8d6c1e-2f4a-4c7b-9e3d-${String(++n).padStart(12, '0')}`, timestamp, ...fields,
  });
  const typed = (timestamp, text) => record('user', timestamp, { message: { role: 'user', content: text } });
  const assistant = (timestamp, content) => record('assistant', timestamp, {
    message: { id: `msg_history_${n}`, type: 'message', role: 'assistant', model: 'claude-opus-5', content, stop_reason: null },
  });
  const toolAnswer = (timestamp, toolUseId, content, isError) => record('user', timestamp, {
    message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: toolUseId, content, ...(isError ? { is_error: true } : {}) }] },
  });

  return [
    typed(at(12, 4), 'The scroll lock lets go when a panel switches to history. Find out why before touching anything.'),
    record('attachment', at(12, 4), { attachment: { type: 'hook_additional_context', content: ['project context'] } }),
    assistant(at(12, 9), [{ type: 'thinking', thinking: '', signature: 'EqQBCkgIBxABGAIqQJ8xZ3' }]),
    assistant(at(12, 11), [
      { type: 'text', text: 'Reading the grid hook first, the lock lives there.' },
      { type: 'tool_use', id: 'toolu_read', name: 'Read', input: { file_path: 'src/components/TerminalsView/hooks/useTerminalGrid.ts' } },
    ]),
    toolAnswer(at(12, 11), 'toolu_read', "1\t'use client';"),
    assistant(at(13, 2), [
      { type: 'tool_use', id: 'toolu_test', name: 'Bash', input: { command: 'npx vitest run __tests__/components/terminal-mouse-tracking.test.ts' } },
    ]),
    toolAnswer(at(13, 40), 'toolu_test', 'FAIL  keeps the lock across a view switch', true),
    assistant(at(14, 21), [
      { type: 'text', text: 'The overlay remounts the terminal and the refit drops the lock. Keeping the xterm mounted under the history view fixes both.' },
    ]),
    typed(at(16, 2), 'Ship it, with the test that caught it.'),
    assistant(at(18, 47), [{ type: 'text', text: 'Done. One file changed, and the failing test now passes.' }]),
  ];
}

/**
 * Written before Electron starts, into the throwaway HOME the suite creates.
 *
 * `panelHistory` is for e2e/panel-history.spec.ts alone: auto start off, and a
 * transcript on disk for the Orchestrator. Every other suite seeds without it.
 */
export function seedSandbox(home, { panelHistory = false } = {}) {
  PROJECT = path.join(home, REL_PROJECT);
  SECOND = path.join(home, REL_SECOND);
  const dir = path.join(home, '.dorothy');
  fs.mkdirSync(dir, { recursive: true });

  const agents = AGENTS.map(a => ({
    ...a,
    projectPath: a.projectPath === REL_PROJECT ? PROJECT : SECOND,
    ...(a.worktreePath ? { worktreePath: path.join(PROJECT, '.worktrees', a.branchName) } : {}),
    // loadAgents clears currentSessionId on every launch and keeps this one,
    // so it is exactly what a panel reads right after a restart.
    ...(panelHistory && a.id === 'a1' ? { resumableSessionId: HISTORY_SESSION } : {}),
  }));
  fs.writeFileSync(path.join(dir, 'agents.json'), JSON.stringify(agents, null, 2));
  fs.writeFileSync(path.join(dir, 'kanban-tasks.json'), JSON.stringify(KANBAN, null, 2));
  fs.writeFileSync(
    path.join(dir, 'projects.json'),
    JSON.stringify([{ path: PROJECT, name: 'tars' }, { path: SECOND, name: '1212-capital' }], null, 2),
  );

  // The project directories have to exist: several handlers check before they
  // will show a project at all, and loadAgents marks an agent `pathMissing` -
  // which disables its Start button and prints "Path not found" on the card -
  // if its working directory is absent. Worktrees included, since that is the
  // path a worktree agent actually runs in.
  for (const dir of [PROJECT, SECOND]) fs.mkdirSync(dir, { recursive: true });
  for (const branch of ['feat/frontend', 'feat/backend']) {
    fs.mkdirSync(path.join(PROJECT, '.worktrees', branch), { recursive: true });
  }

  if (panelHistory) {
    fs.writeFileSync(path.join(dir, 'app-settings.json'), JSON.stringify({ autoStartAgentsOnLaunch: false }, null, 2));
    // Claude Code's directory name for the project: every `/` and `.` becomes `-`.
    const transcripts = path.join(home, '.claude', 'projects', PROJECT.replace(/[/.]/g, '-'));
    fs.mkdirSync(transcripts, { recursive: true });
    fs.writeFileSync(
      path.join(transcripts, `${HISTORY_SESSION}.jsonl`),
      historyTranscript(PROJECT).map(r => `${JSON.stringify(r)}\n`).join(''),
    );
  }
}
