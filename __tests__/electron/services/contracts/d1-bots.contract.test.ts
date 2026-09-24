import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

/**
 * The Telegram and Slack bots, as they answer before the D1 refactor.
 *
 * Recorded first, on main, before any line of the bots moves (refacto-rules: a
 * group's first commit snapshots its contracts, its last proves them
 * byte-identical). What is recorded is what crosses the bots' edges, so that it
 * holds whatever shape the code takes behind them:
 * - every reply each bot sends, to whom, with its options, per command and flow;
 * - every keystroke typed into an agent's terminal (a message, or a launch
 *   command line);
 * - the settings each bot writes (/auth, the Slack channel it answers from);
 * - who may command it (#137): Telegram's authorized chats and /auth, Slack's
 *   allowed users, answered and refused.
 *
 * The bots, the provider builders, initAgentPty, spawnAgentPty and the writer
 * are the real ones. Faked: node-pty, the two chat SDKs (dispatching an update
 * the way node-telegram-bot-api's processUpdate does: `message`, then the
 * message's type, then every onText that matches, none awaited), the window, and
 * Claude's usage stats. Paths are written relative to the sandbox HOME and the
 * repo, and numbers in en-US, so the snapshot is the same on every machine.
 */

const { tmpHome } = vi.hoisted(() => ({
  tmpHome: `${process.env.TMPDIR?.replace(/\/$/, '') || '/tmp'}/tars-d1-contract-${process.pid}-${Date.now()}`,
}));

type FakePty = {
  pid: number; process: string; write: ReturnType<typeof vi.fn>; kill: ReturnType<typeof vi.fn>; resize: ReturnType<typeof vi.fn>;
  onData: ReturnType<typeof vi.fn>; onExit: ReturnType<typeof vi.fn>; say: (data: string) => void;
};
const spawned = vi.hoisted(() => [] as FakePty[]);
type Handler = (...args: unknown[]) => unknown;
const tg = vi.hoisted(() => ({
  texts: [] as Array<{ pattern: RegExp; handler: Handler }>,
  on: new Map<string, Handler[]>(),
  sent: [] as Array<{ to: string; text: string; opts?: unknown }>,
}));
const sl = vi.hoisted(() => ({
  events: new Map<string, Handler>(),
  message: null as Handler | null,
  posted: [] as unknown[],
}));

vi.mock('os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('os')>();
  return { ...actual, homedir: () => tmpHome, default: { ...actual, homedir: () => tmpHome } };
});
vi.mock('node-pty', () => ({
  spawn: vi.fn((file: string): FakePty => {
    const listeners: Array<(data: string) => void> = [];
    const terminal: FakePty = {
      pid: 7000 + spawned.length, process: file, write: vi.fn(), kill: vi.fn(), resize: vi.fn(), onExit: vi.fn(),
      onData: vi.fn((listener: (data: string) => void) => { listeners.push(listener); return { dispose() {} }; }),
      say: (data: string) => { for (const listener of listeners) listener(data); },
    };
    spawned.push(terminal);
    setTimeout(() => terminal.say('bash-3.2$ '), 20);
    return terminal;
  }),
}));
vi.mock('electron', () => ({
  app: { getPath: () => tmpHome, getAppPath: () => process.cwd(), isPackaged: false, getVersion: () => '1.8.0' },
  BrowserWindow: Object.assign(vi.fn(), { getAllWindows: () => [] }),
  Notification: vi.fn(),
}));
vi.mock('../../../../electron/core/window-manager', () => ({ getMainWindow: () => null }));
vi.mock('@slack/bolt', () => ({
  LogLevel: { DEBUG: 'debug', INFO: 'info' },
  App: class {
    client = { chat: { postMessage: (m: unknown) => { sl.posted.push(m); return Promise.resolve({}); } } };
    event(name: string, handler: Handler) { sl.events.set(name, handler); }
    message(handler: Handler) { sl.message = handler; }
    use() {}
    start() { return Promise.resolve(); }
    stop() { return Promise.resolve(); }
  },
}));
vi.mock('node-telegram-bot-api', () => ({
  default: class {
    on(event: string, handler: Handler) { tg.on.set(event, [...(tg.on.get(event) ?? []), handler]); }
    onText(pattern: RegExp, handler: Handler) { tg.texts.push({ pattern, handler }); }
    getMe() { return Promise.resolve({ username: 'tars_test_bot' }); }
    getFile() { return Promise.reject(new Error('no file in the contract')); }
    sendMessage(chatId: unknown, text: string, opts?: unknown) {
      tg.sent.push({ to: String(chatId), text, ...(opts === undefined ? {} : { opts }) });
      return Promise.resolve({});
    }
    stopPolling() { return Promise.resolve(); }
  },
}));

import { agents, initAgentPty } from '../../../../electron/core/agent-manager';
import { spawnAgentPty } from '../../../../electron/core/agent-pty';
import { resetLaunches } from '../../../../electron/core/agent-launch';
import { ptyProcesses } from '../../../../electron/core/pty-manager';
import { initTelegramBotService, initTelegramBot, stopTelegramBot, sendTelegramMessage, sendSuperAgentResponseToTelegram } from '../../../../electron/services/telegram-bot';
import { initSlackBot, stopSlackBot, setGetClaudeStatsRef, sendSlackMessage } from '../../../../electron/services/slack-bot';
import { getSuperAgent } from '../../../../electron/utils';
import type { AgentStatus, AppSettings } from '../../../../electron/types';

// ── The fleet and the settings every scenario starts from ─────────────────

const P1 = path.join(tmpHome, 'projects', 'atlas');
const P2 = path.join(tmpHome, 'projects', 'orion');

function baseSettings(): AppSettings {
  return {
    telegramEnabled: true, telegramBotToken: 'tg-bot-token', telegramAuthToken: 'tg-auth-token',
    telegramAuthorizedChatIds: ['42'], telegramChatId: '42', telegramRequireMention: true,
    slackEnabled: true, slackBotToken: 'xoxb-test', slackAppToken: 'xapp-test', slackAllowedUserIds: ['U1'], slackChannelId: 'C0',
    cliPaths: { claude: '/opt/tars-contract/bin/claude' },
  } as unknown as AppSettings;
}
let settings = baseSettings();
const saved: unknown[] = [];

const STATS = {
  modelUsage: {
    'claude-opus-4-5-20251101': { inputTokens: 1_200_000, outputTokens: 310_000, cacheReadInputTokens: 5_400_000, cacheCreationInputTokens: 220_000 },
    'claude-sonnet-4-5': { inputTokens: 800_000, outputTokens: 150_000, cacheReadInputTokens: 2_000_000, cacheCreationInputTokens: 90_000 },
    'claude-haiku-4-5': { inputTokens: 300_000, outputTokens: 40_000, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 },
    'claude-opus-4-1': { inputTokens: 100_000, outputTokens: 20_000, cacheReadInputTokens: 10_000, cacheCreationInputTokens: 5_000 },
    'mystery-model-x': { inputTokens: 5_000, outputTokens: 1_000 },
  },
  totalSessions: 42,
  totalMessages: 1234,
};
let stats: typeof STATS | null = STATS;

function seedFleet(): void {
  const now = new Date().toISOString();
  const base = { provider: 'claude', skills: [], output: [], lastActivity: now, permissionMode: 'bypass', model: 'claude-opus-5-5', effort: 'medium' };
  const fleet: Array<Partial<AgentStatus>> = [
    { id: 'agent-orch', name: 'Lead', role: 'orchestrator', status: 'running', projectPath: P1, currentTask: 'Plan the release', skills: ['planning'] },
    { id: 'agent-dune', name: 'Dune', role: 'worker', status: 'running', projectPath: P1, character: 'robot',
      currentTask: 'Rebase onto main and fix the conflicts in the settings page', skills: ['react', 'typescript', 'testing'] },
    { id: 'agent-dove', name: 'Dove', role: 'worker', status: 'waiting', projectPath: P1, character: 'ninja' },
    { id: 'agent-rest', name: 'Rest', role: 'worker', status: 'idle', projectPath: P2, character: 'frog' },
    { id: 'agent-err', name: 'Err', role: 'worker', status: 'error', projectPath: P2, character: 'viking' },
    { id: 'agent-done', name: 'Done', role: 'worker', status: 'completed', projectPath: P2 },
  ];
  for (const f of fleet) agents.set(f.id!, { ...base, ...f } as AgentStatus);
}

/** A terminal where the CLI already runs: a message goes in as a message. */
function liveCli(agentId: string): FakePty {
  const agent = agents.get(agentId)!;
  const terminal = spawnAgentPty({
    binaryName: 'claude', shell: '/bin/bash', args: ['-l'], cwd: agent.projectPath, cols: 120, rows: 30,
    env: { CLAUDE_AGENT_ID: agentId },
  }) as unknown as FakePty;
  terminal.process = '2.1.280';
  ptyProcesses.set(`pty-${agentId}`, terminal as never);
  agent.ptyId = `pty-${agentId}`;
  (agent as { ptyCwd?: string }).ptyCwd = agent.projectPath;
  return terminal;
}

// ── Driving the bots the way their SDKs do ────────────────────────────────

const settle = () => new Promise(resolve => setTimeout(resolve, 450));

/** The order of node-telegram-bot-api's messageTypes, for the types these bots listen to. */
const MESSAGE_TYPES = ['text', 'audio', 'document', 'photo', 'video', 'voice'];

async function telegram(msg: Record<string, unknown>): Promise<void> {
  const pending: unknown[] = [];
  const type = MESSAGE_TYPES.find(t => msg[t] !== undefined);
  for (const h of tg.on.get('message') ?? []) pending.push(h(msg, { type }));
  if (type) for (const h of tg.on.get(type) ?? []) pending.push(h(msg, { type }));
  if (typeof msg.text === 'string') {
    for (const r of tg.texts) {
      const m = r.pattern.exec(msg.text);
      if (!m) continue;
      r.pattern.lastIndex = 0;
      pending.push(r.handler(msg, m));
    }
  }
  await Promise.all(pending);
  await settle();
}
const dm = (text: string, chat = 42) => ({ message_id: 7, chat: { id: chat, type: 'private' }, text });

const said: Array<{ in: string; text: string }> = [];
const say = (where: string) => async (text: string) => { said.push({ in: where, text }); };
async function slackMention(user: string, text: string, channel = 'C1'): Promise<void> {
  await sl.events.get('app_mention')!({ event: { user, text: `<@UBOT> ${text}`, channel, ts: '1700000000.000100' }, say: say(channel) });
  await settle();
}
async function slackMessage(user: string, text: string, channelType: 'im' | 'channel' = 'im', channel = 'D1'): Promise<void> {
  await sl.message!({ message: { user, text, channel, channel_type: channelType, ts: '1700000000.000200' }, say: say(channel) });
  await settle();
}

// ── What a scenario did, the same on every machine ────────────────────────

function normalize(value: unknown): unknown {
  const repo = process.cwd();
  return JSON.parse(JSON.stringify(value, (_k, v) => typeof v === 'string'
    ? v.split(tmpHome).join('<HOME>').split(repo).join('<REPO>')
    : v));
}

function outcome() {
  return normalize({
    telegram: tg.sent.splice(0),
    slack: said.splice(0),
    slackPosted: sl.posted.splice(0),
    typed: spawned.map((t, i) => ({ terminal: i, text: t.write.mock.calls.map(c => String(c[0])).join('') })).filter(t => t.text),
    saved: saved.splice(0),
    fleet: [...agents.values()].map(a => ({ id: a.id, status: a.status, currentTask: a.currentTask ?? null })),
  });
}

// ── Setup ─────────────────────────────────────────────────────────────────

let restoreLocale: () => void;
beforeAll(() => {
  const original = Number.prototype.toLocaleString;
  // Numbers in en-US whatever the machine's locale: the snapshot is the same everywhere.
  Number.prototype.toLocaleString = function (this: number, locales?: Intl.LocalesArgument, options?: Intl.NumberFormatOptions) {
    return original.call(this, locales ?? 'en-US', options);
  };
  restoreLocale = () => { Number.prototype.toLocaleString = original; };
  return () => restoreLocale();
});

beforeEach(() => {
  resetLaunches();
  fs.rmSync(tmpHome, { recursive: true, force: true });
  fs.mkdirSync(P1, { recursive: true });
  fs.mkdirSync(P2, { recursive: true });
  agents.clear();
  ptyProcesses.clear();
  spawned.length = 0;
  tg.texts.length = 0; tg.on.clear(); tg.sent.length = 0;
  sl.events.clear(); sl.message = null; sl.posted.length = 0;
  said.length = 0; saved.length = 0;
  settings = baseSettings();
  stats = STATS;
  seedFleet();
  initTelegramBotService(
    agents, ptyProcesses, () => settings, null,
    () => getSuperAgent(agents), () => {}, async () => stats,
    (a: AgentStatus) => initAgentPty(a, null, vi.fn(), vi.fn()),
    (s: AppSettings) => { saved.push({ telegramAuthorizedChatIds: s.telegramAuthorizedChatIds, telegramChatId: s.telegramChatId }); },
  );
  initTelegramBot();
  setGetClaudeStatsRef(async () => stats ?? undefined);
  initSlackBot(() => settings, s => { saved.push({ slackChannelId: s.slackChannelId }); }, null);
});

afterEach(() => {
  stopTelegramBot();
  stopSlackBot();
});

// ── Telegram ──────────────────────────────────────────────────────────────

describe('Telegram, as recorded before D1', () => {
  it('/start and /help', async () => {
    await telegram(dm('/start'));
    await telegram(dm('/help'));
    expect(outcome()).toMatchSnapshot();
  });

  it('/status, /agents and /projects on a fleet of six', async () => {
    await telegram(dm('/status'));
    await telegram(dm('/agents'));
    await telegram(dm('/projects'));
    expect(outcome()).toMatchSnapshot();
  });

  it('/status, /agents and /projects on an empty fleet', async () => {
    agents.clear();
    await telegram(dm('/status'));
    await telegram(dm('/agents'));
    await telegram(dm('/projects'));
    expect(outcome()).toMatchSnapshot();
  });

  it('/usage, with stats and without', async () => {
    await telegram(dm('/usage'));
    stats = null;
    await telegram(dm('/usage'));
    expect(outcome()).toMatchSnapshot();
  });

  it('/start_agent: no task, unknown, already running', async () => {
    await telegram(dm('/start_agent rest'));
    await telegram(dm('/start_agent nobody Do something'));
    await telegram(dm('/start_agent dune Do something'));
    expect(outcome()).toMatchSnapshot();
  });

  it('/start_agent: an agent whose CLI is up gets the task as a message', async () => {
    liveCli('agent-rest');
    await telegram(dm('/start_agent rest Measure the Usage page'));
    expect(outcome()).toMatchSnapshot();
  });

  it('/start_agent: a cold start types the launch command', async () => {
    await telegram(dm('/start_agent rest Measure the Usage page'));
    expect(outcome()).toMatchSnapshot();
  });

  it('/stop_agent: running, not running, unknown', async () => {
    liveCli('agent-dune');
    await telegram(dm('/stop_agent dune'));
    await telegram(dm('/stop_agent rest'));
    await telegram(dm('/stop_agent nobody'));
    expect(outcome()).toMatchSnapshot();
  });

  it('a message and /ask go to the orchestrator whose CLI is up', async () => {
    liveCli('agent-orch');
    await telegram(dm('what is everyone doing?'));
    await telegram(dm('/ask plan tomorrow'));
    expect(outcome()).toMatchSnapshot();
  });

  it('a message cold-starts the orchestrator when its CLI is not up', async () => {
    await telegram(dm('what is everyone doing?'));
    expect(outcome()).toMatchSnapshot();
  });

  it('a message with no orchestrator in the fleet', async () => {
    agents.delete('agent-orch');
    await telegram(dm('anyone there?'));
    expect(outcome()).toMatchSnapshot();
  });

  it('in a group: without a mention nothing, with one the message without it', async () => {
    liveCli('agent-orch');
    await telegram({ message_id: 8, chat: { id: 42, type: 'group' }, text: 'just chatting' });
    await telegram({ message_id: 9, chat: { id: 42, type: 'group' }, text: '@tars_test_bot status of the release?' });
    expect(outcome()).toMatchSnapshot();
  });

  it('files: a photo, a document, a video, an audio and a voice message', async () => {
    await telegram({ message_id: 10, chat: { id: 42, type: 'private' }, photo: [{ file_id: 'p-small' }, { file_id: 'p-large' }], caption: 'what is this?' });
    await telegram({ message_id: 11, chat: { id: 42, type: 'private' }, document: { file_id: 'd1', file_name: 'report.pdf', mime_type: 'application/pdf' } });
    await telegram({ message_id: 12, chat: { id: 42, type: 'private' }, video: { file_id: 'v1' } });
    await telegram({ message_id: 13, chat: { id: 42, type: 'private' }, audio: { file_id: 'a1' } });
    await telegram({ message_id: 14, chat: { id: 42, type: 'private' }, voice: { file_id: 'o1' } });
    expect(outcome()).toMatchSnapshot();
  });

  it('who may command: an unknown chat, then /auth wrong and right', async () => {
    await telegram(dm('/status', 99));
    await telegram(dm('hello', 99));
    await telegram(dm('/auth wrong-token', 99));
    await telegram(dm('/auth tg-auth-token', 99));
    await telegram(dm('/status', 99));
    expect(outcome()).toMatchSnapshot();
  });

  it("the orchestrator's answer, sent back to the chat that asked, with every way it is read", async () => {
    liveCli('agent-orch');
    await telegram(dm('what is everyone doing?'));
    const orch = agents.get('agent-orch')!;
    // After a tool result: the lines that follow it, without the TUI's own.
    orch.output = ['\x1b[1m● \x1b[0mcalling list_agents\n', '  ⎿  (MCP) 6 agents\n', 'Dune is rebasing onto main.\n', 'ANTHROPIC_API_KEY=sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789\n', 'Dove waits on a question from you.\n'];
    sendSuperAgentResponseToTelegram(orch);
    // No tool result: the last long lines.
    orch.output = ['● thinking\n', 'Nothing is running right now, everyone is idle.\n'];
    sendSuperAgentResponseToTelegram(orch);
    // Nothing worth reading.
    orch.output = ['● \n', 'ok\n'];
    sendSuperAgentResponseToTelegram(orch);
    await settle();
    expect(outcome()).toMatchSnapshot();
  });

  it('what Tars sends on its own: to the authorized chats, cut at 4000 characters', async () => {
    sendTelegramMessage('A notice from Tars.');
    sendTelegramMessage('x'.repeat(4100));
    await settle();
    expect(outcome()).toMatchSnapshot();
  });
});

// ── Slack ─────────────────────────────────────────────────────────────────

describe('Slack, as recorded before D1', () => {
  it('help, and the channel it answers from saved', async () => {
    await slackMention('U1', 'help');
    await slackMention('U1', '');
    expect(outcome()).toMatchSnapshot();
  });

  it('status, agents and projects on a fleet of six', async () => {
    await slackMention('U1', 'status');
    await slackMention('U1', 'agents');
    await slackMention('U1', 'projects');
    expect(outcome()).toMatchSnapshot();
  });

  it('status, agents and projects on an empty fleet', async () => {
    agents.clear();
    await slackMention('U1', 'status');
    await slackMention('U1', 'agents');
    await slackMention('U1', 'projects');
    expect(outcome()).toMatchSnapshot();
  });

  it('usage, with stats and without', async () => {
    await slackMention('U1', 'usage');
    stats = null;
    await slackMention('U1', 'usage');
    expect(outcome()).toMatchSnapshot();
  });

  it('start: no task, unknown, already running', async () => {
    await slackMention('U1', 'start rest');
    await slackMention('U1', 'start nobody Do something');
    await slackMention('U1', 'start dune Do something');
    expect(outcome()).toMatchSnapshot();
  });

  it('start: an agent whose CLI is up gets the task as a message', async () => {
    liveCli('agent-rest');
    await slackMention('U1', 'start rest Measure the Usage page');
    expect(outcome()).toMatchSnapshot();
  });

  it('start: a cold start types the launch command', async () => {
    await slackMention('U1', 'start rest Measure the Usage page');
    expect(outcome()).toMatchSnapshot();
  });

  it('stop: running, not running, unknown', async () => {
    liveCli('agent-dune');
    await slackMention('U1', 'stop dune');
    await slackMention('U1', 'stop rest');
    await slackMention('U1', 'stop nobody');
    expect(outcome()).toMatchSnapshot();
  });

  it('a mention and a direct message go to the orchestrator whose CLI is up', async () => {
    liveCli('agent-orch');
    await slackMention('U1', 'what is everyone doing?');
    await slackMessage('U1', 'plan tomorrow\nplease');
    expect(outcome()).toMatchSnapshot();
  });

  it('a message cold-starts the orchestrator when its CLI is not up', async () => {
    await slackMessage('U1', 'what is everyone doing?');
    expect(outcome()).toMatchSnapshot();
  });

  it('a message with no orchestrator in the fleet', async () => {
    agents.delete('agent-orch');
    await slackMessage('U1', 'anyone there?');
    expect(outcome()).toMatchSnapshot();
  });

  it('who may command: a mention and a direct message from users not allowed, and a channel message', async () => {
    await slackMention('U9', 'status');
    await slackMessage('U9', 'hello', 'im');
    await slackMessage('U9', 'hello', 'channel', 'C2');
    await slackMention('U9', 'status', 'C3');
    expect(outcome()).toMatchSnapshot();
  });

  it('what Tars sends on its own, cut at 3900 characters', async () => {
    await sendSlackMessage('A notice from Tars.', settings);
    await sendSlackMessage('y'.repeat(4000), settings, 'C7');
    expect(outcome()).toMatchSnapshot();
  });
});
