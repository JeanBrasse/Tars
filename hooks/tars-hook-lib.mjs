// What the .sh hooks get from bash, curl and jq, in Node built-ins only.
//
// The Node runner (tars-hook.mjs, decision D1 of the Windows port) has to post
// exactly what the .sh hooks post, and those bodies carry the exact quirks of
// the tools that build them: `$(...)` drops every trailing newline, `echo`
// adds one, `head -c` cuts bytes where jq's `.[0:n]` cuts code points, `//`
// treats false like null. Each helper below is one of those, named after it,
// so a reader can hold the runner against the script line by line.

import { createHash, randomBytes } from 'node:crypto';
import * as fs from 'node:fs';
import * as http from 'node:http';
import * as https from 'node:https';
import * as os from 'node:os';
import * as path from 'node:path';

/** The default the .sh hooks fall back to when Tars gave the CLI no URL. */
export const DEFAULT_API_URL = 'http://127.0.0.1:31415';

/** `$(...)`: command substitution removes every trailing newline. */
export function subst(text) {
  return String(text).replace(/\n+$/, '');
}

/** `head -c n`: the first n bytes, an incomplete last character becoming U+FFFD as jq reads it. */
export function headBytes(text, n) {
  return Buffer.from(String(text), 'utf8').subarray(0, n).toString('utf8');
}

/** `echo "$X" | head -c n`: echo ends the text with a newline first. */
export function echoHead(text, n) {
  return headBytes(`${text}\n`, n);
}

/** jq `.[0:n]` on a string: code points, not UTF-16 units. */
export function codePoints(text, n) {
  return Array.from(text).slice(0, n).join('');
}

/** jq `tostring`: a string as it is, anything else as compact JSON. */
export function jqToString(value) {
  return typeof value === 'string' ? value : JSON.stringify(value);
}

/** The stdin of the hook, parsed the way `echo "$INPUT" | jq` would read it; undefined when jq would fail. */
export function parseInput(text) {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

const JQ_ERROR = Symbol('jq error');

/** jq `.a.b.c`: null through null, an error on anything that is not an object. */
function jqPath(input, keys) {
  let current = input;
  for (const key of keys) {
    if (current === null || current === undefined) return null;
    if (typeof current !== 'object' || Array.isArray(current)) return JQ_ERROR;
    current = Object.prototype.hasOwnProperty.call(current, key) ? current[key] : null;
  }
  return current === undefined ? null : current;
}

/**
 * `$(echo "$INPUT" | jq -r '.a.b // <fallback>')`: the raw value, or the
 * fallback when it is null or false, or "" when jq fails (bad input, a path
 * through something that is not an object). Non-strings print as jq -r does.
 */
export function jqRaw(input, keys, fallback = '') {
  if (input === undefined) return '';
  const value = jqPath(input, keys);
  if (value === JQ_ERROR) return '';
  if (value === null || value === false) return fallback;
  return subst(typeof value === 'string' ? value : JSON.stringify(value, null, 2));
}

/** `[ -f "$f" ]`: a regular file (a symlink to one counts, as with test -f). */
export function isFile(file) {
  try {
    return fs.statSync(file).isFile();
  } catch {
    return false;
  }
}

/** `$(cat "$f" 2>/dev/null)` */
export function catFile(file) {
  try {
    return subst(fs.readFileSync(file, 'utf8'));
  } catch {
    return '';
  }
}

/** `$HOME`, as Tars computes its data folder (os.homedir: HOME on POSIX, USERPROFILE on Windows). */
export function home() {
  return os.homedir();
}

/** tars-hook.sh: where every hook logs, readable by its user only (umask 077). */
export function logPaths() {
  const dir = path.join(home(), '.dorothy', 'logs');
  try {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  } catch {
    // mkdir -p ... 2>/dev/null
  }
  return { dir, hookLog: path.join(dir, 'hooks.log'), debugLog: path.join(dir, 'hooks-debug.log') };
}

/** `echo "..." >> "$LOG"`: appended with a newline, created 0600. A log that cannot be written stops nothing. */
export function appendLog(file, line) {
  try {
    fs.appendFileSync(file, `${line}\n`, { mode: 0o600 });
  } catch {
    // The .sh redirection fails the same way and the script goes on.
  }
}

/** `[$(date)]`. The text of `date` differs by platform anyway; this is only a log line. */
export function stamp() {
  return new Date().toString();
}

/** The API base: `${CLAUDE_MGR_API_URL:-http://127.0.0.1:31415}`. */
export function apiUrl(env = process.env) {
  return env.CLAUDE_MGR_API_URL || DEFAULT_API_URL;
}

/** `Bearer <token>`, `Bearer ` and nothing when the token is empty, as `printf "Authorization: Bearer %s"` sends it. */
export function bearer(token) {
  return `Bearer ${token ?? ''}`;
}

/** The Authorization header of a post: none at all for a null token, as curl sends none when tars_auth prints nothing. */
export function authHeader(token) {
  return token === null ? {} : { Authorization: bearer(token) };
}

/**
 * tars-hook.sh, TARS_TOKEN_OK (upstream #212): whether the port is the Tars
 * that spawned this CLI, which alone gets the CLI's token. While Tars is down
 * any process may hold its port. So a fresh random challenge goes to
 * /api/health, and the answer must be sha256("<TARS_INSTANCE_ID>:<challenge>");
 * the id itself never leaves. No token or no id: nothing is asked. No answer
 * within 5 s, longer than any post waits, or a wrong one: false.
 */
export async function tarsProvesInstance(env = process.env) {
  const id = env.TARS_INSTANCE_ID || '';
  if (!env.CLAUDE_MGR_API_TOKEN || !id) return false;
  const challenge = randomBytes(16).toString('hex');
  const answer = await curl({ url: `${apiUrl(env)}/api/health?challenge=${challenge}`, maxTimeMs: 5000 });
  const proof = jqRaw(parseInput(answer), ['proof']);
  const expected = createHash('sha256').update(`${id}:${challenge}`).digest('hex');
  return proof !== '' && proof === expected;
}

/**
 * The token for the calls that fall back to the shared file (bootstrap,
 * memory): the CLI's own, else ~/.dorothy/api-token when Tars did not start
 * this CLI. Hook posts never read the file (tars_auth).
 */
export function tokenWithFileFallback(env = process.env) {
  const own = env.CLAUDE_MGR_API_TOKEN || '';
  if (own) return own;
  const file = path.join(home(), '.dorothy', 'api-token');
  return isFile(file) ? catFile(file) : '';
}

/**
 * One curl: `curl -s --max-time <s> [-X POST] -H ... [-d body] URL`.
 *
 * Resolves with what curl -s prints on stdout: the response body, whatever
 * the status, or "" when the call fails or runs out of time (what the hooks
 * test with `[ -z "$RESULT" ]`). Never rejects: a hook must not stop the CLI
 * because Tars is not there. `maxTimeMs` bounds the whole call, like
 * --max-time; the connect timeouts of the .sh are inside that bound.
 */
export function curl({ method = 'GET', url, headers = {}, body, maxTimeMs = 3000 }) {
  return new Promise(resolve => {
    let settled = false;
    let text = '';
    const done = value => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    };
    let target;
    try {
      target = new URL(url);
    } catch {
      resolve('');
      return;
    }
    const payload = body === undefined ? undefined : Buffer.from(body, 'utf8');
    const lib = target.protocol === 'https:' ? https : http;
    let req;
    const timer = setTimeout(() => {
      // curl --max-time prints what it had received so far.
      done(text);
      try { req?.destroy(); } catch { /* already gone */ }
    }, maxTimeMs);
    try {
      req = lib.request(target, {
        method,
        agent: false,
        headers: {
          Accept: '*/*',
          ...headers,
          ...(payload ? { 'Content-Length': String(payload.length) } : {}),
        },
      }, res => {
        res.setEncoding('utf8');
        res.on('data', chunk => { text += chunk; });
        res.on('end', () => done(text));
        res.on('error', () => done(text));
      });
    } catch {
      done('');
      return;
    }
    req.on('error', () => done(text));
    if (payload) req.write(payload);
    req.end();
  });
}

/** `curl -s --max-time 3 -X POST "$URL" -H <auth> -H "Content-Type: application/json" -d "$BODY"`; a null token sends no <auth>. */
export function postJson(url, token, body, maxTimeMs = 3000) {
  return curl({
    method: 'POST',
    url,
    headers: { ...authHeader(token), 'Content-Type': 'application/json' },
    body,
    maxTimeMs,
  });
}

/** `sleep n` */
export function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * The retried posts (SessionStart, UserPromptSubmit, StopFailure): once more
 * after a second when the first printed nothing, as `[ -z "$RESULT" ]` does.
 */
export async function postWithRetry(url, token, body) {
  let result = subst(await postJson(url, token, body));
  if (result === '') {
    await sleep(1000);
    result = subst(await postJson(url, token, body));
  }
  return result;
}

/** How much of a transcript is read at a time, and at most, from its end. */
export const TRANSCRIPT_CHUNK_BYTES = 1024 * 1024;
export const TRANSCRIPT_MAX_BYTES = 8 * 1024 * 1024;

/**
 * The text of one transcript record as the .sh reads it: '' when it is not an
 * assistant record or holds no text, JQ_ERROR where jq would stop on it.
 */
function assistantText(record) {
  const type = jqPath(record, ['type']);
  if (type === JQ_ERROR) return JQ_ERROR;
  if (type !== 'assistant') return '';
  let content = jqPath(record, ['message', 'content']);
  if (content === JQ_ERROR) return JQ_ERROR;
  if (content === null || content === false) content = [];
  if (!Array.isArray(content)) return jqToString(content);
  return content
    .filter(block => block !== null && typeof block === 'object' && !Array.isArray(block) && block.type === 'text')
    .map(block => (block.text === undefined || block.text === null ? '' : typeof block.text === 'string' ? block.text : JSON.stringify(block.text)))
    .join('\n');
}

/**
 * The last assistant text of a transcript, as on-stop.sh, session-end.sh and
 * task-completed.sh read it with
 *
 *   jq -rRn '[ inputs | fromjson? | select(.type=="assistant")
 *     | (.message.content // [])
 *     | if type=="array" then map(select(type=="object" and .type=="text") | .text) | join("\n")
 *       else tostring end
 *     | select(length>0) ] | last // empty' | head -c 4000
 *
 * Line by line, a line that does not parse skipped (Claude Code may still be
 * flushing the last one), a record jq cannot index ending the run with
 * nothing, as the jq error does.
 *
 * Read from the end rather than whole: a transcript grows with its session,
 * and read whole past Node's string limit (about 512 MB) it throws and the
 * output is lost without a word. Chunks of 1 MB are read backwards, split on
 * the newline byte (never inside a character), and the scan stops at the
 * last record with text. It gives up at 8 MB from the end: a last answer
 * followed by that much tool traffic is not posted (the .sh would have found
 * it), and the Stop hook still posts idle and agent-stopped. The one other
 * difference: a record jq cannot index before the last text is not seen, so
 * it no longer voids the answer.
 */
export function lastAssistantMessage(file) {
  let fd;
  try {
    fd = fs.openSync(file, 'r');
  } catch {
    return '';
  }
  try {
    const size = fs.fstatSync(fd).size;
    let pos = size;
    // Bytes read but not yet scanned: the start of the window, whose first
    // line may continue in the chunk before it.
    let pending = Buffer.alloc(0);
    while (pos > 0 && size - pos < TRANSCRIPT_MAX_BYTES) {
      const length = Math.min(TRANSCRIPT_CHUNK_BYTES, pos, TRANSCRIPT_MAX_BYTES - (size - pos));
      pos -= length;
      const chunk = Buffer.alloc(length);
      fs.readSync(fd, chunk, 0, length, pos);
      pending = Buffer.concat([chunk, pending]);
      // Complete lines only, unless this is the start of the file.
      const cut = pos > 0 ? pending.indexOf(0x0a) : -1;
      if (pos > 0 && cut < 0) continue;
      const complete = pos > 0 ? pending.subarray(cut + 1) : pending;
      pending = pos > 0 ? pending.subarray(0, cut + 1) : Buffer.alloc(0);
      const lines = complete.toString('utf8').split('\n');
      for (let i = lines.length - 1; i >= 0; i--) {
        let record;
        try {
          record = JSON.parse(lines[i]);
        } catch {
          continue;
        }
        const text = assistantText(record);
        if (text === JQ_ERROR) return '';
        if (Array.from(text).length > 0) return subst(headBytes(`${text}\n`, 4000));
      }
    }
    return '';
  } catch {
    return '';
  } finally {
    try { fs.closeSync(fd); } catch { /* already closed */ }
  }
}

/** Print what the hook answers the CLI, and leave once it is written (a pipe on Windows is asynchronous). */
export function finish(stdout, code = 0) {
  if (stdout === '') process.exit(code);
  process.stdout.write(stdout, () => process.exit(code));
}
