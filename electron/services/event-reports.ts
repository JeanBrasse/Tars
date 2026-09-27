import * as fs from 'fs';
import { privatePath } from '../constants';
import { writeSecretFileSync } from '../utils/secret-file';
import { redactSecrets } from '../utils/redact-secrets';

/**
 * Reports to Noah's Telegram as things happen (step 4 of PLAN-RELAIS-SENTRY.md,
 * the design's part A2; Noah: "en fonction de ce qui se passe").
 *
 * An event (an agent gone to error, a PR merged, changes requested on a PR)
 * waits up to GROUP_MS for others, and they leave together in one message, to
 * the private chats Settings authorizes (the Telegram bot's channel). At most
 * REPORTS_PER_DAY messages a (local) day, counted across restarts in
 * ~/.tars-private; past that, events are counted, and the next day's first
 * message opens with one line saying how many were held. No quiet hours.
 * While the bot is off, an event is dropped, not kept: news sent late is
 * stale news.
 *
 * The same event is said once: an agent in error is reported when it enters
 * error, and again only once it has left it (agentRecovered); a merged PR
 * once per run (the GitHub watch also remembers what it has seen). Changes
 * requested may come back after an approval, so only a window's repeats are
 * dropped.
 *
 * Every name, title and error text is escaped for Telegram's HTML and has its
 * secrets masked: it is text for Noah, never markup.
 */

export const GROUP_MS = 2 * 60_000;
export const REPORTS_PER_DAY = 40;

export type ReportEvent =
  | { kind: 'agent-error'; agentId: string; agentName: string; project: string; reason?: string }
  | { kind: 'pr-merged'; repo: string; number: number; title: string; url: string }
  | { kind: 'changes-requested'; repo: string; number: number; title: string; url: string };

/** Telegram, as the bot hands it over when it starts, and takes it back when it stops. */
export interface ReportChannel {
  /** Sends to Noah's private chats; how many it reached. */
  send(html: string): Promise<number>;
}

let channel: ReportChannel | null = null;
let pending: ReportEvent[] = [];
let timer: NodeJS.Timeout | undefined;
const inError = new Set<string>();
const mergedSeen = new Set<string>();

export function setReportChannel(next: ReportChannel | null): void {
  channel = next;
  if (!next) {
    pending = [];
    if (timer) { clearTimeout(timer); timer = undefined; }
  }
}

/** The agent has left error: its next error is a new event. */
export function agentRecovered(agentId: string): void {
  inError.delete(agentId);
}

const keyOf = (e: ReportEvent) => (e.kind === 'agent-error' ? `error:${e.agentId}` : `${e.kind}:${e.repo}#${e.number}`);

export function reportEvent(event: ReportEvent): void {
  if (!channel) return;
  if (event.kind === 'agent-error') {
    if (inError.has(event.agentId)) return;
    inError.add(event.agentId);
  }
  if (event.kind === 'pr-merged') {
    if (mergedSeen.has(keyOf(event))) return;
    mergedSeen.add(keyOf(event));
  }
  if (pending.some(p => keyOf(p) === keyOf(event))) return;
  pending.push(event);
  if (!timer) {
    timer = setTimeout(() => { timer = undefined; void flush(); }, GROUP_MS);
    timer.unref?.();
  }
}

interface DayCount { day: string; sent: number; held: number; heldBefore: number }
const FILE = () => privatePath('event-reports.json');
const today = () => { const d = new Date(); return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`; };

function readCount(): DayCount {
  let stored: Partial<DayCount> = {};
  try { stored = JSON.parse(fs.readFileSync(FILE(), 'utf-8')); } catch { /* none yet */ }
  const day = today();
  if (stored.day === day) {
    return { day, sent: stored.sent ?? 0, held: stored.held ?? 0, heldBefore: stored.heldBefore ?? 0 };
  }
  // A new day: what was held on the last one is said in its first message.
  return { day, sent: 0, held: 0, heldBefore: (stored.held ?? 0) + (stored.heldBefore ?? 0) };
}

function writeCount(count: DayCount): void {
  try {
    writeSecretFileSync(FILE(), JSON.stringify(count));
  } catch (err) {
    console.error('[reports] could not record the day\'s count:', err instanceof Error ? err.message : err);
  }
}

const escapeHtml = (s: string) => redactSecrets(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

function line(e: ReportEvent): string {
  if (e.kind === 'agent-error') {
    return `❌ <b>${escapeHtml(e.agentName)}</b> (${escapeHtml(e.project)}) stopped on an error${e.reason ? `: ${escapeHtml(e.reason.slice(0, 300))}` : ''}`;
  }
  const link = `<a href="${escapeHtml(e.url)}">#${e.number}</a>`;
  if (e.kind === 'pr-merged') return `✅ ${link} merged in ${escapeHtml(e.repo)}: ${escapeHtml(e.title)}`;
  return `✋ Changes requested on ${link} in ${escapeHtml(e.repo)}: ${escapeHtml(e.title)}`;
}

async function flush(): Promise<void> {
  const events = pending;
  pending = [];
  if (!channel || events.length === 0) return;
  const count = readCount();
  if (count.sent >= REPORTS_PER_DAY) {
    count.held += events.length;
    writeCount(count);
    return;
  }
  const lines: string[] = [];
  if (count.heldBefore > 0) {
    lines.push(`ℹ️ ${count.heldBefore} ${count.heldBefore === 1 ? 'event' : 'events'} after yesterday's limit ${count.heldBefore === 1 ? 'was' : 'were'} not sent.`);
  }
  lines.push(...events.map(line));
  count.sent += 1;
  count.heldBefore = 0;
  if (count.sent === REPORTS_PER_DAY) {
    lines.push('', `<i>That is ${REPORTS_PER_DAY} reports today, the most Tars sends: later events are counted and said tomorrow.</i>`);
  }
  writeCount(count);
  try {
    await channel.send(lines.join('\n'));
  } catch (err) {
    console.error('[reports] Telegram refused the report:', err instanceof Error ? err.message : err);
  }
}
