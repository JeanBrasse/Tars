#!/usr/bin/env node
// The Tars hooks in Node: `node tars-hook.mjs <event>`, <event> being the
// name of the .sh it stands for (`session-start`, `gemini/on-stop`, ...).
//
// Decision D1 of the Windows port: on Windows the .sh hooks cannot run
// (bash eats the backslashes of their unquoted path, jq is absent, Git Bash's
// curl cannot read `-H @<(tars_auth)`). This runner does what each script
// does, post for post, with Node built-ins only: the same routes, headers and
// bodies, the same retries and deadlines, the same answer on stdout, the same
// logs. Configured on win32 only for now; the .sh stay what macOS and Linux
// run. The .sh remain the reference: each handler names its script, and
// __tests__/hooks/node-hook-runner.test.ts holds the two side by side.
//
// Where it differs on purpose: a Windows path is sent as valid JSON (the
// Gemini notification pasted it raw, audit A13) and query values are encoded
// (session-start pasted them raw, audit A14); the Gemini posts the .sh sends
// in the background are awaited before exit (bounded by the same 3s); the
// dates in the log lines are Node's.

import {
  apiUrl, appendLog, authHeader, codePoints, curl, echoHead, finish, headBytes, isFile, jqRaw, jqToString,
  lastAssistantMessage, logPaths, parseInput, postJson, postWithRetry, stamp, subst, tarsProvesInstance, tokenWithFileFallback,
} from './tars-hook-lib.mjs';

const CONTINUE = '{"continue":true,"suppressOutput":true}\n';
const env = process.env;

function readStdin() {
  return new Promise(resolve => {
    const chunks = [];
    process.stdin.on('data', c => chunks.push(c));
    process.stdin.on('end', () => resolve(subst(Buffer.concat(chunks).toString('utf8'))));
    process.stdin.on('error', () => resolve(''));
  });
}

/** `${CLAUDE_AGENT_ID:-$SESSION_ID}` */
const claudeAgent = sessionId => env.CLAUDE_AGENT_ID || sessionId;
/** `${DOROTHY_AGENT_ID:-$SESSION_ID}`, the Gemini scripts' name for it. */
const geminiAgent = sessionId => env.DOROTHY_AGENT_ID || sessionId;
/** tars_auth: the CLI's token once the port has proved to be its Tars (tarsProvesInstance), else null: no header. */
let tokenOk = false;
const token = () => (tokenOk ? env.CLAUDE_MGR_API_TOKEN : null);

// session-start.sh
async function sessionStart(input) {
  const { hookLog } = logPaths();
  const sessionId = jqRaw(input, ['session_id']);
  const cwd = jqRaw(input, ['cwd']);
  const source = jqRaw(input, ['source'], 'startup');
  appendLog(hookLog, `[${stamp()}] SESSION_START hook. AGENT_ID=${env.CLAUDE_AGENT_ID || 'unset'} SESSION_ID=${sessionId}`);
  const api = apiUrl();
  const agentId = claudeAgent(sessionId);
  const projectPath = env.CLAUDE_PROJECT_PATH || cwd;

  // Registration, retried once: no probe first, the POST is the probe (see the .sh).
  const result = await postWithRetry(`${api}/api/hooks/status`, token(),
    JSON.stringify({ agent_id: agentId, session_id: sessionId, status: 'idle', source, hook: 'SessionStart' }));
  appendLog(hookLog, `[${stamp()}] SESSION_START curl result: ${result}`);

  const apiToken = tokenWithFileFallback();
  let bootstrap = '';
  if (env.CLAUDE_AGENT_ID && apiToken) {
    const text = await curl({
      url: `${api}/api/agents/${encodeURIComponent(env.CLAUDE_AGENT_ID)}/bootstrap`,
      headers: { Authorization: `Bearer ${apiToken}` },
    });
    bootstrap = jqRaw(parseInput(text), ['context']);
  }

  const query = new URLSearchParams({ agent_id: agentId, project_path: projectPath });
  const context = subst(await curl({
    url: `${api}/api/memory/context?${query}`,
    headers: { Authorization: `Bearer ${apiToken}` },
  }));
  let memory = '';
  if (context !== '' && context !== 'null' && context !== '{}') {
    memory = jqRaw(parseInput(context), ['context']);
    if (memory === 'No previous context found for this agent/project.') memory = '';
  }

  let combined = bootstrap;
  if (memory) combined = combined ? `${combined}\n\n${memory}` : memory;
  if (combined) {
    return `{"continue":true,"suppressOutput":false,"hookSpecificOutput":{"hookEventName":"SessionStart","additionalContext":${JSON.stringify(combined)}}}\n`;
  }
  return CONTINUE;
}

// user-prompt-submit.sh
async function userPromptSubmit(input) {
  const { hookLog } = logPaths();
  const sessionId = jqRaw(input, ['session_id']);
  const prompt = jqRaw(input, ['prompt']);
  appendLog(hookLog, `[${stamp()}] USER_PROMPT_SUBMIT hook. AGENT_ID=${env.CLAUDE_AGENT_ID || 'unset'} SESSION_ID=${sessionId}`);
  const body = JSON.stringify({
    agent_id: claudeAgent(sessionId), session_id: sessionId, status: 'running', event: 'UserPromptSubmit', hook: 'UserPromptSubmit',
    // `echo "$PROMPT" | head -c 200 | jq -Rs .`: the newline echo adds is kept.
    current_task: echoHead(prompt, 200),
  });
  const result = await postWithRetry(`${apiUrl()}/api/hooks/status`, token(), body);
  appendLog(hookLog, `[${stamp()}] USER_PROMPT_SUBMIT curl result: ${result}`);
  return CONTINUE;
}

/** store_observation of post-tool-use.sh (both providers). */
function storeObservation(url, apiToken, agentId, projectPath, content, type) {
  return postJson(url, apiToken, JSON.stringify({ agent_id: agentId, project_path: projectPath, content, type }));
}

// post-tool-use.sh
async function postToolUse(input) {
  const toolName = jqRaw(input, ['tool_name']);
  const sessionId = jqRaw(input, ['session_id']);
  const cwd = jqRaw(input, ['cwd']);
  if (!toolName) return CONTINUE;
  const base = apiUrl();
  const remember = `${base}/api/memory/remember`;
  const agentId = claudeAgent(sessionId);
  const projectPath = env.CLAUDE_PROJECT_PATH || cwd;

  await curl({
    method: 'POST',
    url: `${base}/api/hooks/status`,
    headers: { ...authHeader(token()), 'Content-Type': 'application/json' },
    body: JSON.stringify({ agent_id: agentId, session_id: sessionId, status: 'running' }),
  });

  const apiToken = tokenWithFileFallback();
  const store = (content, type) => storeObservation(remember, apiToken, agentId, projectPath, content, type);
  const field = key => jqRaw(input, ['tool_input', key]);

  switch (toolName) {
    case 'Write': {
      const filePath = field('file_path');
      if (filePath) await store(`Created/wrote file: ${filePath}`, 'file_edit');
      break;
    }
    case 'Edit': {
      const filePath = field('file_path');
      const oldStr = subst(echoHead(field('old_string'), 100));
      const newStr = subst(echoHead(field('new_string'), 100));
      if (filePath) {
        if (oldStr) await store(`Edited ${filePath}: replaced '${oldStr}...' with '${newStr}...'`, 'file_edit');
        else await store(`Edited file: ${filePath}`, 'file_edit');
      }
      break;
    }
    case 'Bash': {
      const command = subst(echoHead(field('command'), 200));
      const description = field('description');
      if (command) {
        if (description) await store(`Ran command: ${description} (${command})`, 'command');
        else await store(`Ran command: ${command}`, 'command');
      }
      break;
    }
    case 'Read':
    case 'Grep':
    case 'Glob':
      break;
    case 'Task': {
      const description = field('description');
      if (description) await store(`Spawned agent task: ${description}`, 'tool_use');
      break;
    }
    default:
      if (toolName.startsWith('mcp__')) await store(`Used MCP tool: ${toolName}`, 'tool_use');
  }
  return CONTINUE;
}

/** The last message of on-stop.sh and task-completed.sh: the payload's, else the transcript's. */
function lastMessage(input, debugLog) {
  let message = jqRaw(input, ['last_assistant_message']);
  appendLog(debugLog, `  last_assistant_message length: ${Array.from(message).length}`);
  if (!message) {
    const transcript = jqRaw(input, ['transcript_path']);
    if (transcript && isFile(transcript)) message = lastAssistantMessage(transcript);
  }
  return message;
}

/** Background task states that are over: the jq list in on-stop.sh. */
const OVER = new Set(['completed', 'failed', 'killed', 'stopped', 'error']);

/**
 * What waits at rest, as on-stop.sh counts it: the session's crons, and its
 * background tasks not over (a task with no status, or not an object, counts
 * as running). Claude Code 2.1.289 sends both lists to the Stop hook; a claude
 * that sends neither, as lists, gets no count: nothing is known. An agent put
 * to sleep loses both with its CLI (services/agent-sleep.ts).
 */
function waitingAtRest(input) {
  if (!input || !Array.isArray(input.session_crons) || !Array.isArray(input.background_tasks)) return undefined;
  const statusOf = (task) => {
    const status = task && typeof task === 'object' && !Array.isArray(task) && task.status !== null && task.status !== undefined && task.status !== false
      ? task.status : 'running';
    return typeof status === 'string' ? status : JSON.stringify(status);
  };
  return { crons: input.session_crons.length, background: input.background_tasks.filter(task => !OVER.has(statusOf(task))).length };
}

// on-stop.sh
async function onStop(input) {
  const { debugLog } = logPaths();
  const sessionId = jqRaw(input, ['session_id']);
  if (jqRaw(input, ['stop_hook_active'], 'false') === 'true') return CONTINUE;
  const api = apiUrl();
  const agentId = claudeAgent(sessionId);
  appendLog(debugLog, '========================================');
  appendLog(debugLog, `[${stamp()}] STOP hook: AGENT=${agentId}`);
  const message = lastMessage(input, debugLog);
  if (message) {
    const trimmed = subst(headBytes(message, 4000));
    const answer = await postJson(`${api}/api/hooks/output`, token(),
      JSON.stringify({ agent_id: agentId, hook: 'Stop', session_id: sessionId, output: trimmed }));
    if (answer) appendLog(debugLog, answer);
    appendLog(debugLog, `  Output sent (${Array.from(trimmed).length} chars)`);
  }
  const pending = waitingAtRest(input);
  await postJson(`${api}/api/hooks/status`, token(),
    JSON.stringify({ agent_id: agentId, hook: 'Stop', session_id: sessionId, status: 'idle', ...(pending ? { pending } : {}) }));
  await postJson(`${api}/api/hooks/agent-stopped`, token(), JSON.stringify({ agent_id: agentId, session_id: sessionId, hook: 'Stop' }));
  return CONTINUE;
}

// stop-failure.sh: prints nothing.
async function stopFailure(input) {
  const { hookLog } = logPaths();
  const sessionId = jqRaw(input, ['session_id']);
  const errorKind = jqRaw(input, ['error']);
  const message = jqRaw(input, ['last_assistant_message']);
  appendLog(hookLog, `[${stamp()}] STOP_FAILURE hook. AGENT_ID=${env.CLAUDE_AGENT_ID || 'unset'} SESSION_ID=${sessionId} ERROR=${errorKind}`);
  const body = JSON.stringify({
    agent_id: claudeAgent(sessionId), session_id: sessionId, status: 'error', event: 'StopFailure', hook: 'StopFailure',
    error_kind: errorKind, error_message: message,
  });
  const result = await postWithRetry(`${apiUrl()}/api/hooks/status`, token(), body);
  appendLog(hookLog, `[${stamp()}] STOP_FAILURE curl result: ${result}`);
  return '';
}

// session-end.sh
async function sessionEnd(input) {
  const { hookLog } = logPaths();
  const sessionId = jqRaw(input, ['session_id']);
  const transcript = jqRaw(input, ['transcript_path']);
  const reason = jqRaw(input, ['reason'], 'other');
  appendLog(hookLog, `[${stamp()}] SESSION_END hook. AGENT_ID=${env.CLAUDE_AGENT_ID || 'unset'} SESSION_ID=${sessionId}`);
  const api = apiUrl();
  const agentId = claudeAgent(sessionId);
  if (transcript && isFile(transcript)) {
    const last = lastAssistantMessage(transcript);
    if (last) {
      await postJson(`${api}/api/hooks/output`, token(), JSON.stringify({ agent_id: agentId, session_id: sessionId, output: last }));
    }
  }
  await postJson(`${api}/api/hooks/status`, token(),
    JSON.stringify({ agent_id: agentId, session_id: sessionId, status: 'completed', reason }));
  return CONTINUE;
}

// notification.sh
async function notification(input) {
  const { hookLog } = logPaths();
  const sessionId = jqRaw(input, ['session_id']);
  const message = jqRaw(input, ['message']);
  const title = jqRaw(input, ['title']);
  const type = jqRaw(input, ['notification_type']);
  const api = apiUrl();
  const agentId = claudeAgent(sessionId);
  appendLog(hookLog, `[${stamp()}] NOTIFICATION hook. AGENT_ID=${env.CLAUDE_AGENT_ID || 'unset'} TYPE=${type}`);
  if (!type) return CONTINUE;
  await postJson(`${api}/api/hooks/notification`, token(),
    JSON.stringify({ agent_id: agentId, session_id: sessionId, type, title, message }));
  if (type === 'idle_prompt') {
    await postJson(`${api}/api/hooks/status`, token(),
      JSON.stringify({ agent_id: agentId, session_id: sessionId, status: 'waiting', waiting_reason: 'idle' }));
  }
  return CONTINUE;
}

/**
 * The body permission-request.sh builds with jq: only what names the dialog,
 * each value cut at 1000 code points, the questions' words; undefined where
 * that jq program fails (an input it cannot index), for the bare fallback.
 */
function permissionBody(stdin, agentId) {
  // jq reads every field of `null` as null, so its program runs on it too.
  const input = stdin === null ? {} : stdin;
  if (typeof input !== 'object' || Array.isArray(input)) return undefined;
  let t = input.tool_input;
  if (t === undefined || t === null || t === false) t = {};
  if (typeof t !== 'object' || Array.isArray(t)) return undefined;
  const toolInput = {};
  for (const key of ['command', 'file_path', 'notebook_path', 'url', 'query', 'pattern']) {
    if (typeof t[key] === 'string') toolInput[key] = codePoints(t[key], 1000);
  }
  if (Array.isArray(t.questions)) {
    const questions = [];
    for (const q of t.questions.slice(0, 5)) {
      if (q !== null && (typeof q !== 'object' || Array.isArray(q))) return undefined;
      const words = q === null || q.question === undefined || q.question === null || q.question === false ? '' : q.question;
      questions.push({ question: codePoints(jqToString(words), 1000) });
    }
    toolInput.questions = questions;
  }
  const sessionId = input.session_id === undefined || input.session_id === null || input.session_id === false ? '' : input.session_id;
  const toolName = input.tool_name === undefined || input.tool_name === null || input.tool_name === false ? '' : input.tool_name;
  return JSON.stringify({
    agent_id: agentId, session_id: sessionId, status: 'waiting', waiting_reason: 'permission',
    opened_at: Date.now(), tool_name: codePoints(jqToString(toolName), 200), tool_input: toolInput,
  });
}

// permission-request.sh
async function permissionRequest(input) {
  const { hookLog } = logPaths();
  const sessionId = jqRaw(input, ['session_id']);
  const toolName = jqRaw(input, ['tool_name']);
  appendLog(hookLog, `[${stamp()}] PERMISSION_REQUEST hook. AGENT_ID=${env.CLAUDE_AGENT_ID || 'unset'} SESSION_ID=${sessionId} TOOL=${toolName}`);
  const agentId = claudeAgent(sessionId);
  const body = permissionBody(input, agentId)
    ?? JSON.stringify({ agent_id: agentId, session_id: sessionId, status: 'waiting', waiting_reason: 'permission' });
  await postJson(`${apiUrl()}/api/hooks/status`, token(), body);
  return CONTINUE;
}

// task-completed.sh
async function taskCompleted(input) {
  const { debugLog } = logPaths();
  const sessionId = jqRaw(input, ['session_id']);
  const api = apiUrl();
  const agentId = claudeAgent(sessionId);
  appendLog(debugLog, '========================================');
  appendLog(debugLog, `[${stamp()}] TASK_COMPLETED: AGENT=${agentId}`);
  const message = lastMessage(input, debugLog);
  if (message) {
    const trimmed = subst(headBytes(message, 4000));
    const answer = await postJson(`${api}/api/hooks/output`, token(),
      JSON.stringify({ agent_id: agentId, session_id: sessionId, output: trimmed }));
    if (answer) appendLog(debugLog, answer);
  }
  await postJson(`${api}/api/hooks/task-completed`, token(), JSON.stringify({ agent_id: agentId, session_id: sessionId }));
  return CONTINUE;
}

// gemini/session-start.sh
async function geminiSessionStart(input) {
  const sessionId = jqRaw(input, ['session_id']);
  await postJson(`${apiUrl()}/api/hooks/status`, token(),
    JSON.stringify({ agent_id: geminiAgent(sessionId), session_id: sessionId, status: 'running', source: 'startup' }));
  return CONTINUE;
}

// gemini/user-prompt-submit.sh (wired on BeforeAgent)
async function geminiUserPromptSubmit(input) {
  const { hookLog } = logPaths();
  const sessionId = jqRaw(input, ['session_id']);
  appendLog(hookLog, `[${stamp()}] GEMINI USER_PROMPT_SUBMIT hook. AGENT_ID=${env.DOROTHY_AGENT_ID || 'unset'} SESSION_ID=${sessionId}`);
  await postJson(`${apiUrl()}/api/hooks/status`, token(),
    JSON.stringify({ agent_id: geminiAgent(sessionId), session_id: sessionId, status: 'running' }));
  return CONTINUE;
}

// gemini/post-tool-use.sh
async function geminiPostToolUse(input) {
  const toolName = jqRaw(input, ['tool_name']);
  const sessionId = jqRaw(input, ['session_id']);
  const cwd = jqRaw(input, ['cwd']);
  if (!toolName) return CONTINUE;
  const remember = `${apiUrl()}/api/memory/remember`;
  const agentId = geminiAgent(sessionId);
  const projectPath = env.DOROTHY_PROJECT_PATH || cwd;
  const apiToken = tokenWithFileFallback();
  const store = (content, type) => storeObservation(remember, apiToken, agentId, projectPath, content, type);
  const field = key => jqRaw(input, ['tool_input', key]);
  switch (toolName) {
    case 'Write': {
      const filePath = field('file_path');
      if (filePath) await store(`Created/wrote file: ${filePath}`, 'file_edit');
      break;
    }
    case 'Edit': {
      const filePath = field('file_path');
      if (filePath) await store(`Edited file: ${filePath}`, 'file_edit');
      break;
    }
    case 'Bash':
    case 'Shell': {
      const command = subst(echoHead(field('command'), 200));
      if (command) await store(`Ran command: ${command}`, 'command');
      break;
    }
    default:
      if (toolName.startsWith('mcp__')) await store(`Used MCP tool: ${toolName}`, 'tool_use');
  }
  return CONTINUE;
}

// gemini/on-stop.sh (wired on AfterAgent)
async function geminiOnStop(input) {
  const sessionId = jqRaw(input, ['session_id']);
  if (jqRaw(input, ['stop_hook_active'], 'false') === 'true') return CONTINUE;
  await postJson(`${apiUrl()}/api/hooks/status`, token(),
    JSON.stringify({ agent_id: geminiAgent(sessionId), session_id: sessionId, status: 'waiting' }));
  return CONTINUE;
}

// gemini/session-end.sh
async function geminiSessionEnd(input) {
  const sessionId = jqRaw(input, ['session_id']);
  await postJson(`${apiUrl()}/api/hooks/status`, token(),
    JSON.stringify({ agent_id: geminiAgent(sessionId), session_id: sessionId, status: 'completed' }));
  return CONTINUE;
}

// gemini/notification.sh
async function geminiNotification(input) {
  const sessionId = jqRaw(input, ['session_id']);
  const message = jqRaw(input, ['message']);
  const cwd = jqRaw(input, ['cwd']);
  const projectPath = env.DOROTHY_PROJECT_PATH || cwd;
  if (message) {
    await postJson(`${apiUrl()}/api/hooks/notification`, token(), JSON.stringify({
      // `echo "$MESSAGE" | jq -Rs .`: the newline echo adds is kept.
      agent_id: geminiAgent(sessionId), session_id: sessionId, message: `${message}\n`, project_path: projectPath,
    }));
  }
  return CONTINUE;
}

const EVENTS = {
  'session-start': sessionStart,
  'user-prompt-submit': userPromptSubmit,
  'post-tool-use': postToolUse,
  'on-stop': onStop,
  'stop-failure': stopFailure,
  'session-end': sessionEnd,
  notification,
  'permission-request': permissionRequest,
  'task-completed': taskCompleted,
  'gemini/session-start': geminiSessionStart,
  'gemini/user-prompt-submit': geminiUserPromptSubmit,
  'gemini/post-tool-use': geminiPostToolUse,
  'gemini/on-stop': geminiOnStop,
  'gemini/session-end': geminiSessionEnd,
  'gemini/notification': geminiNotification,
};

const event = process.argv[2];
const handler = Object.prototype.hasOwnProperty.call(EVENTS, event ?? '') ? EVENTS[event] : undefined;
if (!handler) {
  process.stderr.write(`tars-hook: unknown event "${event ?? ''}". Known: ${Object.keys(EVENTS).join(', ')}\n`);
  process.exit(1);
}

try {
  // Asked once, as tars-hook.sh does when a hook sources it.
  tokenOk = await tarsProvesInstance(env);
  const input = parseInput(await readStdin());
  finish(await handler(input));
} catch (error) {
  // A bug here, not a network failure (those resolve to ""). Loud, and still
  // not a blocking exit code for the CLI (2 would block Claude Code).
  process.stderr.write(`tars-hook ${event}: ${error?.stack ?? error}\n`);
  process.exit(1);
}
