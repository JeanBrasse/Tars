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
 * The port the sandbox's Hermes points at, and nothing listens on it.
 *
 * With no connection file the app falls back to `mode: 'local'` on Hermes's
 * default port, so the "sandbox" reached whatever was running on the machine
 * recording the baseline. On Noah's it was his real gateway, which answered
 * `Unauthorized`; elsewhere the connection is refused and the page prints
 * `socket hang up`. Same code, same seed, two different pictures, and the
 * Kanban surface failed or passed on which of them the run happened to get.
 *
 * Pointing it at a port nothing serves makes the refusal the same everywhere
 * and, more to the point, stops the sandbox from touching the machine at all.
 * 9 is `discard`: assigned, never served, and refused immediately.
 */
const HERMES_DEAD_PORT = 9;

/**
 * The skills.sh listing, frozen, as that site serves it.
 *
 * `/skills` renders "live from skills.sh" and means it: the names, the order
 * and the install counts all come off a third party at the moment of the run,
 * so that baseline drifted whenever the catalogue did. Measured twice in one
 * night: 3649 pixels, then 3598, with nothing in this repo having changed.
 *
 * Shaped as the page rather than as the parsed result on purpose. The main
 * process fetches `https://skills.sh/` and scrapes `initialSkills` out of the
 * HTML, so a stub that returned the finished list would skip the scraping and
 * the formatting, which are the parts that can break. This goes in where the
 * network does, and everything downstream of it is the real code.
 */
const SKILLS_ROWS = [
  ['find-skills', 'vercel-labs/skills', 12_400],
  ['grill-me', 'mattpocock/skills', 9_800],
  ['frontend-design', 'vercel-labs/skills', 8_100],
  ['improve-codebase-architecture', 'mattpocock/skills', 7_700],
  ['agent-browser', 'vercel-labs/agent-browser', 6_200],
  ['setup-matt-pocock-skills', 'mattpocock/skills', 5_900],
  ['handoff', 'mattpocock/skills', 5_100],
  ['good-react-best-practices', 'vercel-labs/skills', 4_700],
  ['prototype', 'mattpocock/skills', 4_300],
  ['web-design-guidelines', 'vercel-labs/skills', 3_800],
  ['superpowers', 'obra/superpowers', 3_200],
  ['remember', 'JeanBrasse/Tars', 940],
];

/** One line, because the scraper's regex does not cross a newline. */
export const SKILLS_SH_PAGE = `<!doctype html><html><body><script>window.initialSkills = ${
  JSON.stringify(SKILLS_ROWS.map(([name, source, installs]) => ({ source, name, installs })))
}</script></body></html>`;

/**
 * Three more projects, and the agents that make their rooms exist.
 *
 * A room is derived, not stored: `listRooms` builds one per project path any
 * agent holds, so a room per state needs an agent per state. These are behind
 * the `chatRooms` flag rather than in the shared seed because adding six agents
 * and three projects to the sweep would move every other baseline in the suite.
 */
const REL_ATLAS = 'projects/atlas';
const REL_MERCURY = 'projects/mercury';
const REL_ORION = 'projects/orion';

const CHAT_AGENTS = [
  { id: 'c1', name: 'Atlas Writer', provider: 'claude', model: 'claude-sonnet-5', status: 'idle', rel: REL_ATLAS, effort: 'medium' },
  { id: 'c2', name: 'Atlas Reviewer', provider: 'claude', model: 'claude-opus-5', status: 'completed', rel: REL_ATLAS, effort: 'low' },
  { id: 'c3', name: 'Mercury Caretaker', provider: 'claude', model: 'claude-sonnet-5', status: 'idle', rel: REL_MERCURY, effort: 'low' },
  { id: 'c4', name: 'Orion Lead', provider: 'claude', model: 'claude-opus-5', status: 'running', rel: REL_ORION, effort: 'high' },
  { id: 'c5', name: 'Orion Second', provider: 'claude', model: 'claude-sonnet-5', status: 'running', rel: REL_ORION, effort: 'medium' },
].map((a, i) => ({
  character: 'robot', role: 'worker', skills: [],
  createdAt: ISO(5 - i), lastActivity: ISO(0, 10 + i),
  ...a,
}));

/**
 * The journal behind the five room states, written the way the bus writes one.
 *
 * Every state the Chat room can render came from code nobody had seen on a
 * screen: `delivered`, `dropped`, `bounded` and `superseded` had no data that
 * produced them. Each one is here, on the room whose frame is meant to show it.
 * The counters agree with the log rather than being set to a round number: the
 * bounded thread really does carry its ten agent messages.
 */
function chatJournal(paths) {
  const room = project => `project:${project}`;
  const msg = (id, roomId, threadId, authorKind, authorId, authorName, text, createdAt, mentions = []) =>
    ({ id, roomId, threadId, authorKind, authorId, authorName, text, mentions, createdAt });
  const delivered = (messageId, targetAgentId, at) =>
    ({ messageId, targetAgentId, state: 'delivered', queuedAt: at, deliveredAt: at });

  const messages = [];
  const threads = [];
  const deliveries = [];

  // tars: an exchange still running. One row of each live delivery state.
  const tars = room(paths.tars);
  threads.push({ id: 't-tars', roomId: tars, anchorMessageId: 'm-tars-1', state: 'open', round: 2, agentMessageCount: 2, openedAt: ISO(0, 9) });
  messages.push(
    msg('m-tars-1', tars, 't-tars', 'human', 'human', 'Noah', 'The scroll lock drops a line when a panel is resized. Take it between you.', ISO(0, 9), ['a1', 'a2']),
    msg('m-tars-2', tars, 't-tars', 'agent', 'a1', 'Orchestrator', 'It is in the fit handler: the resize runs before the row count has settled.', ISO(0, 10), ['a2']),
    msg('m-tars-3', tars, 't-tars', 'agent', 'a2', 'Frontend Engineer', 'Then I hold the write until the fit resolves, and add the test that caught it.', ISO(0, 11)),
  );
  deliveries.push(
    delivered('m-tars-1', 'a1', ISO(0, 9)),
    delivered('m-tars-2', 'a2', ISO(0, 10)),
    { messageId: 'm-tars-3', targetAgentId: 'a1', state: 'queued', queuedAt: ISO(0, 11) },
    {
      messageId: 'm-tars-3', targetAgentId: 'a3', state: 'not_sent', queuedAt: ISO(0, 11), refusedAt: ISO(0, 11),
      reasonCode: 'no_end_of_turn',
      reason: 'codex stays running until its process exits, so nothing can be delivered to it at rest',
    },
  );

  // 1212-capital: the bound reached, ten agent messages and no human since.
  const capital = room(paths.capital);
  threads.push({ id: 't-cap', roomId: capital, anchorMessageId: 'm-cap-0', state: 'bounded', round: 5, agentMessageCount: 10, openedAt: ISO(1, 14) });
  messages.push(msg('m-cap-0', capital, 't-cap', 'human', 'human', 'Noah', 'Why is the migration refusing the connection? Work it out between you.', ISO(1, 14), ['a5', 'a6']));
  const capitalTurns = [
    ['a5', 'Database migration and schema review', 'The socket is refused at 5432, so nothing of mine ever opened.', 'a6'],
    ['a6', 'Audit', 'The port is right. Check whether the server is listening on the socket file instead.', 'a5'],
    ['a5', 'Database migration and schema review', 'It is a unix socket, and the path in the config is the Homebrew one.', 'a6'],
    ['a6', 'Audit', 'Then the server here is the Postgres.app build, which puts its socket elsewhere.', 'a5'],
    ['a5', 'Database migration and schema review', 'Confirmed, two servers installed and the config names the one that is not running.', 'a6'],
    ['a6', 'Audit', 'Point the config at the running one rather than starting the other.', 'a5'],
    ['a5', 'Database migration and schema review', 'Done locally, the connection opens. I have not touched the committed config.', 'a6'],
    ['a6', 'Audit', 'Leave it uncommitted: that path is this machine, not the project.', 'a5'],
    ['a5', 'Database migration and schema review', 'Agreed. The migration runs clean against the local server now.', 'a6'],
    ['a6', 'Audit', 'Nothing left on my side. This needs Noah to say which server the project assumes.', 'a5'],
  ];
  capitalTurns.forEach(([id, name, text, to], i) => {
    messages.push(msg(`m-cap-${i + 1}`, capital, 't-cap', 'agent', id, name, text, ISO(1, 15 + i), [to]));
    deliveries.push(delivered(`m-cap-${i + 1}`, to, ISO(1, 15 + i)));
  });

  // atlas: a room whose agents have all finished. Nothing is pending.
  const atlas = room(paths.atlas);
  threads.push({ id: 't-atlas', roomId: atlas, anchorMessageId: 'm-atlas-1', state: 'open', round: 1, agentMessageCount: 1, openedAt: ISO(2, 11) });
  messages.push(
    msg('m-atlas-1', atlas, 't-atlas', 'human', 'human', 'Noah', 'Read the onboarding copy and tell me what a new reader would not understand.', ISO(2, 11), ['c1']),
    msg('m-atlas-2', atlas, 't-atlas', 'agent', 'c1', 'Atlas Writer', 'Three paragraphs assume the reader already has an account. I have marked them.', ISO(2, 12)),
  );
  deliveries.push(delivered('m-atlas-1', 'c1', ISO(2, 11)));

  // orion: Noah stepped in. The old anchor is superseded and what it was still
  // holding was dropped, which is the pair of states nothing had produced.
  const orion = room(paths.orion);
  threads.push(
    { id: 't-orion-old', roomId: orion, anchorMessageId: 'm-orion-1', state: 'superseded', round: 1, agentMessageCount: 2, openedAt: ISO(0, 13) },
    { id: 't-orion-new', roomId: orion, anchorMessageId: 'm-orion-4', state: 'open', round: 1, agentMessageCount: 0, openedAt: ISO(0, 16) },
  );
  messages.push(
    msg('m-orion-1', orion, 't-orion-old', 'human', 'human', 'Noah', 'Pick the cache strategy for the feed and tell me which one you took.', ISO(0, 13), ['c4', 'c5']),
    msg('m-orion-2', orion, 't-orion-old', 'agent', 'c4', 'Orion Lead', 'I would cache per user, since the feed differs for everyone who reads it.', ISO(0, 14), ['c5']),
    msg('m-orion-3', orion, 't-orion-old', 'agent', 'c5', 'Orion Second', 'Per user multiplies the store by the user count. I would cache the parts instead.', ISO(0, 15), ['c4']),
    msg('m-orion-4', orion, 't-orion-new', 'human', 'human', 'Noah', 'Stop there, both of you. Cache the parts, and measure it before you tune it.', ISO(0, 16), ['c4', 'c5']),
  );
  deliveries.push(
    delivered('m-orion-2', 'c5', ISO(0, 14)),
    {
      messageId: 'm-orion-3', targetAgentId: 'c4', state: 'dropped', queuedAt: ISO(0, 15), refusedAt: ISO(0, 16),
      reasonCode: 'thread_replaced', reason: 'a newer message from Noah replaced the exchange this was queued for',
    },
    { messageId: 'm-orion-4', targetAgentId: 'c4', state: 'queued', queuedAt: ISO(0, 16) },
    { messageId: 'm-orion-4', targetAgentId: 'c5', state: 'queued', queuedAt: ISO(0, 16) },
  );

  return {
    savedAt: ISO(0, 16),
    // mercury keeps its room and loses its members, which is the only way to
    // reach the empty room: the room exists because an agent names the project.
    memberOverrides: { [room(paths.mercury)]: [] },
    threads,
    messages,
    deliveries,
  };
}

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
export function seedSandbox(home, { panelHistory = false, chatRooms = false } = {}) {
  PROJECT = path.join(home, REL_PROJECT);
  SECOND = path.join(home, REL_SECOND);
  const dir = path.join(home, '.dorothy');
  fs.mkdirSync(dir, { recursive: true });

  const chatPaths = {
    tars: PROJECT,
    capital: SECOND,
    atlas: path.join(home, REL_ATLAS),
    mercury: path.join(home, REL_MERCURY),
    orion: path.join(home, REL_ORION),
  };

  const agents = AGENTS.map(a => ({
    ...a,
    projectPath: a.projectPath === REL_PROJECT ? PROJECT : SECOND,
    ...(a.worktreePath ? { worktreePath: path.join(PROJECT, '.worktrees', a.branchName) } : {}),
    // loadAgents clears currentSessionId on every launch and keeps this one,
    // so it is exactly what a panel reads right after a restart.
    ...(panelHistory && a.id === 'a1' ? { resumableSessionId: HISTORY_SESSION } : {}),
  }));
  if (chatRooms) {
    for (const a of CHAT_AGENTS) {
      const { rel, ...rest } = a;
      agents.push({ ...rest, projectPath: path.join(home, rel) });
    }
  }
  fs.writeFileSync(path.join(dir, 'agents.json'), JSON.stringify(agents, null, 2));
  fs.writeFileSync(path.join(dir, 'kanban-tasks.json'), JSON.stringify(KANBAN, null, 2));
  fs.writeFileSync(
    path.join(dir, 'projects.json'),
    JSON.stringify([{ path: PROJECT, name: 'tars' }, { path: SECOND, name: '1212-capital' }], null, 2),
  );

  // Written for every sandbox, panel history and chat rooms included: whatever
  // a suite photographs, none of it should depend on what happens to be
  // listening on this machine.
  fs.writeFileSync(
    path.join(dir, 'hermes-connection.json'),
    JSON.stringify({ mode: 'local', localPort: HERMES_DEAD_PORT, authMode: 'token' }, null, 2),
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

  if (chatRooms) {
    for (const p of [chatPaths.atlas, chatPaths.mercury, chatPaths.orion]) fs.mkdirSync(p, { recursive: true });
    fs.writeFileSync(
      path.join(dir, 'projects.json'),
      JSON.stringify([
        { path: PROJECT, name: 'tars' }, { path: SECOND, name: '1212-capital' },
        { path: chatPaths.atlas, name: 'atlas' }, { path: chatPaths.mercury, name: 'mercury' },
        { path: chatPaths.orion, name: 'orion' },
      ], null, 2),
    );
    fs.writeFileSync(path.join(dir, 'bus.json'), JSON.stringify(chatJournal(chatPaths), null, 2));
    // Nothing starts, so the statuses on screen are the ones seeded above:
    // `all stopped` is a room whose agents are idle, and autostart would run
    // every one of them as a real CLI and make that frame impossible.
    fs.writeFileSync(path.join(dir, 'app-settings.json'), JSON.stringify({ autoStartAgentsOnLaunch: false }, null, 2));
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
