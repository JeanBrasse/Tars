import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as readline from 'readline';
import { transcriptPath } from '../utils/resume-session';

/**
 * An agent's real conversation, read from the journal Claude Code already
 * keeps.
 *
 * The panels replay `agent.output`, which is the raw PTY stream of a full
 * screen TUI: measured on this machine, that buffer holds no newline at all
 * across 42 agents, mixes frames drawn for different terminal geometries, and
 * 21% of its history lines carry two islands of text written at different
 * moments. There is no conversation in it to recover, because a full screen
 * interface repaints rather than scrolls.
 *
 * The conversation is written down properly, one JSON object per line, in
 * ~/.claude/projects/<encoded project>/<sessionId>.jsonl, and the agent's
 * currentSessionId is literally that file's name. That is what this reads.
 *
 * Measured on the nine transcripts in this project, 0.4 MB to 10 MB:
 *  - 2454 to 3320 lines each. The weight is in a few enormous lines, not in
 *    their number: p50 743 bytes, p90 about 4 KB, p99 about 14 KB, max 1.1 MB
 *  - of the 3451 `user` records, only a few hundred are something a person
 *    typed; the rest are tool results wearing the user role
 *  - no record anywhere has isSidechain set, so subagent transcripts are not
 *    mixed into these files and nothing has to be filtered out
 */

/** Only two roles reach a reader. See collect() for what is dropped. */
export type TranscriptRole = 'user' | 'assistant';

export interface TranscriptToolCall {
  id: string;
  name: string;
  /** One line naming what it was called on. Already short. */
  summary: string;
}

export interface TranscriptMessage {
  /** The record's own uuid, and the pagination cursor. */
  id: string;
  role: TranscriptRole;
  /** ISO 8601, straight from the record. */
  timestamp: string;
  /** What to show. Empty when the message carried only tool activity. */
  text: string;
  /** True when `text` hit the per-message cap and was cut. */
  truncated?: boolean;
  /** The model that wrote an assistant message, when the record names one. */
  model?: string;
  /** Tools this assistant message called. */
  toolCalls?: TranscriptToolCall[];
  /**
   * Set when the record is a tool's answer rather than something a person
   * said. Nine user records in ten are this, and telling them apart is the
   * difference between a conversation and a wall of tool output.
   */
  toolResult?: { toolUseId: string; isError: boolean };
  /**
   * Assistant thinking, kept apart so a reader can fold it away.
   *
   * Expect it to be absent. Claude Code writes the thinking block with its
   * signature and an empty body: all 1756 of them across these nine files
   * carry no text at all. The field stays because the shape is right and
   * costs nothing if that ever changes, but a reader should not build a view
   * that depends on it.
   */
  thinking?: string;
}

export type TranscriptUnavailableReason =
  /** The agent runs a CLI that writes no such journal. */
  | 'unsupported-provider'
  /** The agent has never registered a session. */
  | 'no-session'
  /** A session id, but no file behind it: cleaned up, or never written. */
  | 'not-found'
  /** The file is there and could not be read. */
  | 'unreadable';

export type AgentTranscript =
  | {
      available: false;
      reason: TranscriptUnavailableReason;
      /** Plain sentence a reader can show as is. Never a path or a secret. */
      detail: string;
    }
  | {
      available: true;
      sessionId: string;
      /** Oldest first, which is reading order. */
      messages: TranscriptMessage[];
      /** Whether anything older than messages[0] exists. */
      hasMore: boolean;
      /** Pass back as `before` to get the page above this one. */
      nextCursor?: string;
    };

/**
 * How much of one message's text survives.
 *
 * p90 of a displayable block is 2.9 KB, so this keeps roughly nine in ten
 * whole, and the tail is where the bulk lives: p99 is 49 KB and the largest
 * seen is 568 KB. One un-capped tool result would be a bigger IPC payload than
 * a whole page of conversation.
 */
const TEXT_CAP = 4000;

/** Messages per page unless the caller asks otherwise. */
export const DEFAULT_PAGE = 50;
/** Ceiling, so a caller cannot ask for the whole file in one message. */
export const MAX_PAGE = 200;

function cut(text: string): { text: string; truncated: boolean } {
  if (text.length <= TEXT_CAP) return { text, truncated: false };
  return { text: text.slice(0, TEXT_CAP), truncated: true };
}

/** The input field that says what a tool was pointed at, kept short. */
function summariseToolInput(input: unknown): string {
  if (!input || typeof input !== 'object') return '';
  const o = input as Record<string, unknown>;
  for (const key of ['file_path', 'path', 'command', 'pattern', 'url', 'query', 'prompt', 'description']) {
    const v = o[key];
    if (typeof v === 'string' && v) return v.length > 200 ? v.slice(0, 200) : v;
  }
  const keys = Object.keys(o);
  return keys.length ? keys.join(', ') : '';
}

/** A tool result's content is a string on some records and blocks on others. */
function toolResultText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map(b => (b && typeof b === 'object' && (b as { type?: string }).type === 'text'
        ? String((b as { text?: unknown }).text ?? '')
        : ''))
      .filter(Boolean)
      .join('\n');
  }
  return '';
}

interface RawRecord {
  type?: string;
  uuid?: string;
  timestamp?: string;
  isMeta?: boolean;
  isSidechain?: boolean;
  message?: {
    role?: string;
    model?: string;
    content?: unknown;
  };
}

/**
 * One transcript record turned into a message, or null when it is not
 * conversation.
 *
 * Dropped on purpose: `attachment` (6631 of them across these files, the most
 * common record of all, and none of it is anything anyone said), `system`
 * (stop_hook_summary and turn_duration, which are timings), and the eight
 * bookkeeping types Claude Code writes for its own use. A record marked isMeta
 * goes too: it is Tars's own injected context, not the agent's work.
 */
function toMessage(rec: RawRecord): TranscriptMessage | null {
  if (rec.type !== 'user' && rec.type !== 'assistant') return null;
  if (rec.isMeta) return null;
  if (!rec.uuid) return null;

  const role: TranscriptRole = rec.type;
  const base = { id: rec.uuid, role, timestamp: rec.timestamp ?? '' };
  const content = rec.message?.content;

  if (typeof content === 'string') {
    const { text, truncated } = cut(content);
    if (!text.trim()) return null;
    return truncated ? { ...base, text, truncated } : { ...base, text };
  }
  if (!Array.isArray(content)) return null;

  const texts: string[] = [];
  const thinking: string[] = [];
  const toolCalls: TranscriptToolCall[] = [];
  let toolResult: TranscriptMessage['toolResult'];

  for (const raw of content) {
    if (!raw || typeof raw !== 'object') continue;
    const block = raw as Record<string, unknown>;
    switch (block.type) {
      case 'text':
        if (typeof block.text === 'string') texts.push(block.text);
        break;
      case 'thinking':
        if (typeof block.thinking === 'string') thinking.push(block.thinking);
        break;
      case 'tool_use':
        toolCalls.push({
          id: String(block.id ?? ''),
          name: String(block.name ?? 'tool'),
          summary: summariseToolInput(block.input),
        });
        break;
      case 'tool_result': {
        const body = toolResultText(block.content);
        if (body) texts.push(body);
        toolResult = {
          toolUseId: String(block.tool_use_id ?? ''),
          isError: block.is_error === true,
        };
        break;
      }
      default:
        break;
    }
  }

  const joined = cut(texts.join('\n').trim());
  const message: TranscriptMessage = { ...base, text: joined.text };
  if (joined.truncated) message.truncated = true;
  if (rec.message?.model) message.model = rec.message.model;
  if (toolCalls.length) message.toolCalls = toolCalls;
  if (toolResult) message.toolResult = toolResult;
  // Only when it actually says something: the blocks are written empty, and
  // emitting `thinking: ""` on every assistant message would put a useless
  // key in the payload 1756 times over.
  const thought = cut(thinking.join('\n').trim()).text;
  if (thought) message.thinking = thought;

  // Nothing to show and nothing that happened: not a message.
  if (!message.text && !message.toolCalls && !message.toolResult && !message.thinking) return null;
  return message;
}

/**
 * Read one page, oldest first, ending just before `before`.
 *
 * Read forwards rather than backwards, and the numbers are why. These files
 * are only 2454 to 3320 lines, and streaming one whole 10 MB transcript costs
 * 49 ms with a single line resident at a time. Reading backwards would save
 * about 45 ms of that on the newest page and cost a chunked reverse scanner
 * that has to stitch partial lines back together around records of up to
 * 1.1 MB. That is a lot of machinery to buy one frame, on a path a reader
 * takes when a panel is opened rather than while it is being painted.
 *
 * What matters more is that it never blocks: readline over a read stream hands
 * the loop back between chunks, where the readFileSync plus split that
 * transcript-usage.ts uses for billing would sit on the thread that paints the
 * window and pumps every PTY, holding the whole file resident.
 *
 * Memory is a page and not a file: a ring of at most `limit` messages, so a
 * 10 MB transcript and a 0.4 MB one cost the same.
 */
async function collect(file: string, before: string | undefined, limit: number): Promise<{
  messages: TranscriptMessage[];
  hasMore: boolean;
}> {
  const ring: TranscriptMessage[] = [];
  /** The ring overflowed, so something older than messages[0] exists. */
  let dropped = false;

  const stream = fs.createReadStream(file, { encoding: 'utf-8' });
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });

  try {
    for await (const line of rl) {
      if (!line) continue;
      let rec: RawRecord;
      try { rec = JSON.parse(line) as RawRecord; } catch { continue; }

      // The cursor is a record uuid, so the check comes before the record is
      // turned into a message: the page ends above it whether or not the
      // record itself is one.
      if (before && rec.uuid === before) break;

      const message = toMessage(rec);
      if (!message) continue;
      ring.push(message);
      if (ring.length > limit) { ring.shift(); dropped = true; }
    }
  } finally {
    rl.close();
    stream.destroy();
  }

  // Nothing was dropped means the ring holds everything from the first record
  // up to the cursor, so there is no page above this one.
  return { messages: ring, hasMore: dropped };
}

/**
 * Locate and read an agent's transcript.
 *
 * The session id is checked against the UUID shape before it reaches a path,
 * the same guard resume-session.ts puts in front of the command line: this
 * value arrives from an agent record and a UUID cannot climb out of a
 * directory. The resolved path is then asserted to sit under
 * ~/.claude/projects, so a project path that somehow contained traversal
 * cannot point the read anywhere else.
 */
export async function readAgentTranscript(params: {
  sessionId?: string;
  projectPath?: string;
  worktreePath?: string;
  before?: string;
  limit?: number;
  homeDir?: string;
}): Promise<AgentTranscript> {
  const homeDir = params.homeDir ?? os.homedir();
  const sessionId = params.sessionId?.trim();
  if (!sessionId) {
    return { available: false, reason: 'no-session', detail: 'This agent has not started a session yet.' };
  }
  if (!/^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/.test(sessionId)) {
    return { available: false, reason: 'no-session', detail: 'This agent has no usable session id.' };
  }

  // NaN is no request at all: `??` lets it through, trunc, max and min all
  // return it unchanged, and `ring.length > NaN` is never true, so it used to
  // hand back the whole transcript as one page. Infinity is left alone on
  // purpose and still clamps to MAX_PAGE, which the page-cap test pins.
  const limit = Math.min(Math.max(1, Math.trunc(Number.isNaN(params.limit) ? DEFAULT_PAGE : (params.limit ?? DEFAULT_PAGE))), MAX_PAGE);
  const root = path.join(homeDir, '.claude', 'projects');

  // An agent with a worktree ran there, so that is where its transcript was
  // written; both are tried because an agent can be moved onto a worktree
  // after the session being read.
  const candidates = [params.worktreePath, params.projectPath].filter((p): p is string => !!p);
  for (const projectPath of candidates) {
    const file = transcriptPath(projectPath, sessionId, homeDir);
    const resolved = path.resolve(file);
    if (resolved !== file || !resolved.startsWith(root + path.sep)) continue;
    try {
      if (!fs.existsSync(resolved)) continue;
      const { messages, hasMore } = await collect(resolved, params.before, limit);
      return {
        available: true,
        sessionId,
        messages,
        hasMore,
        ...(hasMore && messages.length ? { nextCursor: messages[0].id } : {}),
      };
    } catch {
      return { available: false, reason: 'unreadable', detail: 'The transcript for this session could not be read.' };
    }
  }

  return {
    available: false,
    reason: 'not-found',
    detail: 'No transcript on disk for this session. It may have been cleaned up.',
  };
}
