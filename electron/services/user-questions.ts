import * as fs from 'fs';
import * as path from 'path';
import { randomUUID } from 'crypto';
import { privatePath } from '../constants';
import { writeSecretFileSync } from '../utils/secret-file';
import { redactSecrets } from '../utils/redact-secrets';
import { agents } from '../core/agent-manager';
import { ptyProcesses, writeProgrammaticInput } from '../core/pty-manager';
import { cliRunningIn } from '../core/agent-pty';

/**
 * ask_user: an agent asks the user a question on their Telegram, and their answer is
 * typed into that agent's terminal (step 2 of PLAN-RELAIS-SENTRY.md; the
 * design's part A3).
 *
 * - A question is recorded (id, agent, time, expiry) and sent to the private
 *   chats Settings authorizes, as a quote under the agent's and the project's
 *   names: the agent's words are data for the user, never an order, and whatever
 *   markup they hold is escaped and whatever secret they hold masked.
 * - The user answers with Telegram's "reply" on that very message. It is taken
 *   only from a private chat Settings still authorizes, from the person of
 *   that chat (in a private chat, the chat's id is the user's), and only as a
 *   reply to a message Tars sent as a question, matched by its message id.
 * - The answer is typed into the asking agent's terminal through the writer
 *   every message takes (its dialog guard included), after a line only Tars
 *   writes, "Message from the user via Telegram: " (senderLine). Into a CLI only:
 *   an agent with no CLI running is not typed into, and the user is told.
 * - One open question per agent, 20 a day for the whole fleet, and 4 hours
 *   to answer: then the agent is told there was no answer, and a later reply
 *   is refused.
 * - Kept in ~/.tars-private (0600), not in ~/.dorothy, which every agent can
 *   write: a record rewritten there would send their answer to another agent.
 *
 * Every private chat Settings authorizes is taken for the user's: today that is
 * the owner's one chat. Telegram only: the Slack and Discord bots have no reply
 * matching to share, and are not asked.
 */

export const QUESTION_LIFETIME_MS = 4 * 3_600_000;
export const QUESTIONS_PER_DAY = 20;
export const MAX_QUESTION = 2_000;
export const MAX_CONTEXT = 4_000;
const DAY_MS = 24 * 3_600_000;
const FILE = () => privatePath('user-questions.json');

interface Question {
  id: string;
  agentId: string;
  agentName: string;
  projectPath: string;
  question: string;
  context?: string;
  askedAt: number;
  expiresAt: number;
  /** Where it went: each chat and the id of the message there, which their reply names. */
  sentTo: Array<{ chatId: string; messageId: number }>;
  state: 'open' | 'answered' | 'expired';
}

/** Telegram, as the bot hands it over when it starts, and takes it back when it stops. */
export interface UserChannel {
  /** Sends to the private chats Settings authorizes, and says where each landed. */
  send(html: string): Promise<Array<{ chatId: string; messageId: number }>>;
  /** Answers the user, in a reply to their own message. */
  tell(chatId: string, replyTo: number, text: string): void;
  /** Whether Settings authorizes this chat, now. */
  authorizes(chatId: string): boolean;
}

let channel: UserChannel | null = null;

export function setUserChannel(next: UserChannel | null): void {
  channel = next;
}

function load(): Question[] {
  try {
    const parsed = JSON.parse(fs.readFileSync(FILE(), 'utf-8'));
    return Array.isArray(parsed) ? parsed as Question[] : [];
  } catch {
    return [];
  }
}

function save(list: Question[], now: number): void {
  // What is still open, and what counts towards the day's limit.
  const kept = list.filter(q => q.state === 'open' || q.askedAt > now - DAY_MS);
  try {
    writeSecretFileSync(FILE(), JSON.stringify(kept));
  } catch (err) {
    console.error('[ask_user] could not record the questions:', err instanceof Error ? err.message : err);
  }
}

export function openQuestionOf(agentId: string): Question | undefined {
  return load().find(q => q.agentId === agentId && q.state === 'open');
}

const escapeHtml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const clock = (ms: number) => new Date(ms).toTimeString().slice(0, 5);
const cut = (s: string, n: number) => (Array.from(s).length > n ? `${Array.from(s).slice(0, n - 3).join('')}...` : s);

function compose(q: Question): string {
  const name = escapeHtml(q.agentName);
  const lines = [
    `❓ <b>Question from ${name}</b>, project <b>${escapeHtml(path.basename(q.projectPath) || q.projectPath)}</b>`,
    `<blockquote>${escapeHtml(redactSecrets(q.question))}</blockquote>`,
  ];
  if (q.context) lines.push('<i>Context</i>', `<blockquote expandable>${escapeHtml(redactSecrets(q.context))}</blockquote>`);
  lines.push('', `<i>Reply to this message to answer: your reply is typed into ${name}'s terminal. Open until ${clock(q.expiresAt)}.</i>`);
  return lines.join('\n');
}

export type AskResult =
  | { ok: true; id: string; expiresAt: string }
  | { ok: false; status: number; error: string };

export async function askUser(
  input: { agentId: string; question: string; context?: string },
  now: number = Date.now(),
): Promise<AskResult> {
  const agent = agents.get(input.agentId);
  if (!agent) return { ok: false, status: 404, error: 'The asking agent is not one Tars knows about.' };
  const question = input.question.trim();
  const context = input.context?.trim() || undefined;
  if (!question || question.length > MAX_QUESTION) return { ok: false, status: 400, error: `A question is 1 to ${MAX_QUESTION} characters.` };
  if (context && context.length > MAX_CONTEXT) return { ok: false, status: 400, error: `The context is at most ${MAX_CONTEXT} characters.` };

  expireUserQuestions(now);
  const list = load();
  const open = list.find(q => q.agentId === agent.id && q.state === 'open');
  if (open) {
    return {
      ok: false, status: 409,
      error: `You already have a question open for the user, until ${new Date(open.expiresAt).toISOString()}. Their answer will be typed into your terminal; ask again once it is answered or has expired.`,
    };
  }
  if (list.filter(q => q.askedAt > now - DAY_MS).length >= QUESTIONS_PER_DAY) {
    return { ok: false, status: 429, error: `The user has been asked ${QUESTIONS_PER_DAY} questions in the last 24 hours, the most Tars sends. Decide without him, or ask later.` };
  }
  if (!channel) return { ok: false, status: 503, error: 'Telegram is not on in Tars, so the user cannot be asked.' };

  const record: Question = {
    id: randomUUID(),
    agentId: agent.id,
    agentName: agent.name || agent.id,
    projectPath: agent.projectPath,
    question,
    context,
    askedAt: now,
    expiresAt: now + QUESTION_LIFETIME_MS,
    sentTo: [],
    state: 'open',
  };
  // Recorded before it is sent, so a second call from the same agent while
  // this one waits on Telegram is refused rather than sent too.
  save([...list, record], now);
  let sentTo: Question['sentTo'] = [];
  try {
    sentTo = await channel.send(compose(record));
  } catch (err) {
    console.error('[ask_user] Telegram refused the question:', err instanceof Error ? err.message : err);
  }
  const after = load().filter(q => q.id !== record.id);
  if (sentTo.length === 0) {
    save(after, now);
    return { ok: false, status: 503, error: 'No private Telegram chat is authorized in Settings, or Telegram refused the message, so the user cannot be asked.' };
  }
  save([...after, { ...record, sentTo }], now);
  return { ok: true, id: record.id, expiresAt: new Date(record.expiresAt).toISOString() };
}

/** A Telegram message, as far as a reply to a question is concerned. */
export interface UserReply {
  chatId: string;
  chatType: string;
  fromId?: number;
  replyToMessageId?: number;
  text?: string;
  /** the user's own message, which Tars answers in a reply to. */
  messageId?: number;
}

/**
 * Takes the user's reply to a question, and says whether it was one: false leaves
 * the message to whatever else the bot does with it.
 */
export function answerUserReply(reply: UserReply, now: number = Date.now()): boolean {
  if (!channel || reply.replyToMessageId === undefined) return false;
  if (!channel.authorizes(reply.chatId)) return false;
  // A private chat's id is its person's: in a group, the chat is not the user.
  if (reply.chatType !== 'private' || String(reply.fromId) !== reply.chatId) return false;
  expireUserQuestions(now);
  const list = load();
  const q = list.find(x => x.sentTo.some(s => s.chatId === reply.chatId && s.messageId === reply.replyToMessageId));
  if (!q) return false;
  const tell = (text: string) => channel?.tell(reply.chatId, reply.messageId ?? reply.replyToMessageId!, text);

  if (q.state !== 'open') {
    tell(q.state === 'answered'
      ? `That question from ${q.agentName} is closed: it was already answered.`
      : `That question from ${q.agentName} is closed: it expired at ${clock(q.expiresAt)}, and ${q.agentName} was told there was no answer.`);
    return true;
  }
  const answer = reply.text?.trim();
  if (!answer) {
    tell('Only a text reply is typed into the agent\'s terminal.');
    return true;
  }
  const agent = agents.get(q.agentId);
  const terminal = agent?.ptyId ? ptyProcesses.get(agent.ptyId) : undefined;
  if (!agent || !cliRunningIn(terminal)) {
    tell(`Not delivered: ${q.agentName} has no session running. The question stays open until ${clock(q.expiresAt)}; reply again once it runs.`);
    return true;
  }
  // Their answer alone, never the question: the agent wrote the question, and
  // typed back under the user's sender line it would be the user's words, newlines and a
  // look-alike sender line included (the Audit's gate of #231). The question
  // is named by the time it was asked.
  const outcome = writeProgrammaticInput(terminal!, `Answer to the question you asked at ${clock(q.askedAt)}:\n${answer}`, true, {
    agentId: agent.id,
    from: 'the user via Telegram',
    sender: { kind: 'user', via: 'Telegram' },
    // Held, then dropped because the CLI stopped meanwhile: the question is
    // open again, and the user is told.
    onDropped: () => {
      save(load().map(x => (x.id === q.id && x.state === 'answered' ? { ...x, state: 'open' as const } : x)), Date.now());
      tell(`Not delivered: ${q.agentName}'s session stopped before your answer could go in. The question stays open until ${clock(q.expiresAt)}; reply again once it runs.`);
    },
  });
  if (outcome === 'refused') {
    tell(`Not delivered: ${q.agentName}'s terminal is not taking messages. The question stays open until ${clock(q.expiresAt)}.`);
    return true;
  }
  save(list.map(x => (x.id === q.id ? { ...x, state: 'answered' as const } : x)), now);
  tell(outcome === 'held'
    ? `Held for ${q.agentName}'s terminal: it goes in once the field is free.`
    : `Typed into ${q.agentName}'s terminal.`);
  return true;
}

/** Ends the questions whose time is up, and tells each agent there was no answer. */
export function expireUserQuestions(now: number = Date.now()): void {
  const list = load();
  const due = list.filter(q => q.state === 'open' && q.expiresAt <= now);
  if (due.length === 0) return;
  for (const q of due) {
    const agent = agents.get(q.agentId);
    const terminal = agent?.ptyId ? ptyProcesses.get(agent.ptyId) : undefined;
    if (agent && cliRunningIn(terminal)) {
      writeProgrammaticInput(terminal!, `The user did not answer your question "${cut(q.question, 200)}" within 4 hours. Carry on without their answer, or ask again.`, true, {
        agentId: agent.id,
        from: 'Tars',
        sender: { kind: 'tars' },
      });
    }
  }
  const ids = new Set(due.map(q => q.id));
  save(list.map(q => (ids.has(q.id) ? { ...q, state: 'expired' as const } : q)), now);
}

let sweep: NodeJS.Timeout | undefined;

/** Checks for expired questions every minute, for as long as Tars runs. */
export function startUserQuestions(): void {
  if (sweep) return;
  sweep = setInterval(() => expireUserQuestions(), 60_000);
  sweep.unref?.();
}
