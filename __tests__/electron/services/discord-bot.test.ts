import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

/**
 * The Discord bot: the third adapter over the flows every bot shares
 * (bot-core.ts), written against Settings > Discord's frame (#182).
 *
 * How it can fail, as the other two bots could:
 * 1. it answers someone Settings does not allow, or refuses a stranger under
 *    every message of a channel instead of where the bot was addressed (a direct
 *    message or a mention), or without telling it the ID to add;
 * 2. in a server channel it answers a message that does not mention it while
 *    Settings requires a mention, or misses a direct message;
 * 3. it saves the channel it answers from at every message, or never;
 * 4. its replies use Telegram's or Slack's markdown (`*bold*`, `:emoji:`, which
 *    Discord shows as text), or a message it cannot place never reaches the
 *    orchestrator, or reaches it without the channel to answer in;
 * 5. a cold start types nothing, or forgets the agent's last conversation;
 * 6. something it posts pings (`@everyone` in a task or an answer);
 * 7. send_discord posts to any channel the bot can see, or past Discord's
 *    2,000 characters;
 * 8. "test token" opens nothing but says nothing either, or gives no invite
 *    link; "send test" posts nowhere, or before a channel is known.
 *
 * Written after the adapter, not before it, against the repo's rule: each
 * test was then shown to bite by a mutant of the code it holds (see the PR).
 *
 * The bot, the core, initAgentPty and the writer are the real ones. Faked:
 * discord.js (a client that records what it is given and sends), node-pty, the
 * window, Discord's REST answer, and Claude's usage stats.
 */

const { tmpHome } = vi.hoisted(() => ({
  tmpHome: `${process.env.TMPDIR?.replace(/\/$/, '') || '/tmp'}/tars-discord-${process.pid}-${Date.now()}`,
}));

type FakePty = { pid: number; process: string; write: ReturnType<typeof vi.fn>; kill: ReturnType<typeof vi.fn>; resize: ReturnType<typeof vi.fn>; onData: ReturnType<typeof vi.fn>; onExit: ReturnType<typeof vi.fn>; say: (data: string) => void };
const spawned = vi.hoisted(() => [] as FakePty[]);
type Handler = (...args: unknown[]) => unknown;
const dc = vi.hoisted(() => ({
  handlers: new Map<string, Handler[]>(),
  sent: [] as Array<{ channel: string; content: string; allowedMentions?: unknown }>,
  logins: [] as string[],
  destroyed: 0,
  loginFails: false,
  /** The channels the fake client can fetch. */
  channels: new Set(['C-TEAM', 'C-OTHER', 'D-NOAH']),
  stats: null as unknown,
}));

vi.mock('os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('os')>();
  return { ...actual, homedir: () => tmpHome, default: { ...actual, homedir: () => tmpHome } };
});
vi.mock('node-pty', () => ({
  spawn: vi.fn((file: string): FakePty => {
    const listeners: Array<(data: string) => void> = [];
    const terminal: FakePty = {
      pid: 8000 + spawned.length, process: file, write: vi.fn(), kill: vi.fn(), resize: vi.fn(), onExit: vi.fn(),
      onData: vi.fn((listener: (data: string) => void) => { listeners.push(listener); return { dispose() {} }; }),
      say: (data: string) => { for (const listener of listeners) listener(data); },
    };
    spawned.push(terminal);
    setTimeout(() => terminal.say('bash-3.2$ '), 20);
    return terminal;
  }),
}));
vi.mock('electron', () => ({
  app: { getPath: () => tmpHome, getAppPath: () => process.cwd(), isPackaged: false, getVersion: () => '1.9.0' },
  BrowserWindow: Object.assign(vi.fn(), { getAllWindows: () => [] }),
  Notification: vi.fn(),
  ipcMain: { handle: (channel: string, fn: Handler) => { ipc.set(channel, fn); } },
}));
const ipc = vi.hoisted(() => new Map<string, Handler>());
vi.mock('../../../electron/core/window-manager', () => ({ getMainWindow: () => null }));
vi.mock('../../../electron/services/claude-service', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../electron/services/claude-service')>()),
  getClaudeStats: async () => dc.stats,
}));
vi.mock('discord.js', () => {
  const sendTo = (channel: string) => async (options: { content: string; allowedMentions?: unknown }) => {
    dc.sent.push({ channel, content: options.content, allowedMentions: options.allowedMentions });
  };
  class Client {
    user = { id: BOT_ID, tag: 'Tars#0001' };
    channels = { fetch: async (id: string) => (dc.channels.has(id) ? { id, send: sendTo(id) } : null) };
    on(event: string, handler: Handler) { dc.handlers.set(event, [...(dc.handlers.get(event) ?? []), handler]); return this; }
    once(event: string, handler: Handler) { return this.on(event, handler); }
    login(token: string) {
      dc.logins.push(token);
      return dc.loginFails ? Promise.reject(new Error('An invalid token was provided.')) : Promise.resolve(token);
    }
    destroy() { dc.destroyed++; return Promise.resolve(); }
  }
  return {
    Client,
    Events: { ClientReady: 'ready', Error: 'error', MessageCreate: 'messageCreate' },
    GatewayIntentBits: { Guilds: 1, GuildMessages: 512, MessageContent: 32768, DirectMessages: 4096 },
    Partials: { Channel: 1 },
  };
});

const BOT_ID = vi.hoisted(() => '1100000000000000001');
const NOAH = '123456789012345678';
const STRANGER = '987654321098765432';

import { agents } from '../../../electron/core/agent-manager';
import { spawnAgentPty } from '../../../electron/core/agent-pty';
import { resetLaunches } from '../../../electron/core/agent-launch';
import { ptyProcesses } from '../../../electron/core/pty-manager';
import { resetResumeTracking, transcriptPath } from '../../../electron/utils/resume-session';
import {
  initDiscordBot, stopDiscordBot, getDiscordClient, sendDiscordMessage, discordInviteUrl,
} from '../../../electron/services/discord-bot';
import { registerDiscordHandlers } from '../../../electron/handlers/discord-handlers';
import { registerDiscordRoutes } from '../../../electron/services/api-routes/discord-routes';
import type { AgentStatus, AppSettings } from '../../../electron/types';

const PROJECT = path.join(tmpHome, 'projects', 'atlas');

function baseSettings(): AppSettings {
  return {
    discordEnabled: true, discordBotToken: 'dc-bot-token', discordChannelId: '', discordAllowedUserIds: [NOAH], discordRequireMention: true,
    cliPaths: { claude: '/opt/tars-test/bin/claude' },
  } as unknown as AppSettings;
}
let settings = baseSettings();
let saves = 0;

function seedFleet(): void {
  const base = { provider: 'claude', skills: [], output: [], lastActivity: new Date().toISOString(), permissionMode: 'bypass', model: 'claude-opus-5-5', effort: 'medium', projectPath: PROJECT };
  const fleet: Array<Partial<AgentStatus>> = [
    { id: 'agent-orch', name: 'Lead', role: 'orchestrator', status: 'idle', skills: ['planning'] },
    { id: 'agent-rest', name: 'Rest', role: 'worker', status: 'idle', character: 'frog' },
    { id: 'agent-dune', name: 'Dune', role: 'worker', status: 'running', character: 'robot', currentTask: 'Rebase onto main' },
  ];
  for (const f of fleet) agents.set(f.id!, { ...base, ...f } as AgentStatus);
}

/** A terminal where the CLI already runs: a message goes in as a message. */
function liveCli(agentId: string): FakePty {
  const agent = agents.get(agentId)!;
  const terminal = spawnAgentPty({
    binaryName: 'claude', shell: '/bin/bash', args: ['-l'], cwd: agent.projectPath, cols: 120, rows: 30, env: { CLAUDE_AGENT_ID: agentId },
  }) as unknown as FakePty;
  terminal.process = '2.1.280';
  ptyProcesses.set(`pty-${agentId}`, terminal as never);
  agent.ptyId = `pty-${agentId}`;
  (agent as { ptyCwd?: string }).ptyCwd = agent.projectPath;
  return terminal;
}

const settle = () => new Promise(resolve => setTimeout(resolve, 450));
const typed = () => spawned.map(t => t.write.mock.calls.map(c => String(c[0])).join('')).join('');
const said = (channel?: string) => dc.sent.filter(s => !channel || s.channel === channel).map(s => s.content);

/** A message as discord.js hands it to the bot. */
async function discord(m: { author?: string; bot?: boolean; content: string; channelId?: string; direct?: boolean }): Promise<void> {
  const channelId = m.channelId ?? (m.direct ? 'D-NOAH' : 'C-TEAM');
  const message = {
    author: { id: m.author ?? NOAH, bot: !!m.bot },
    content: m.content,
    channelId,
    guildId: m.direct ? null : 'G-1',
    channel: {
      send: async (options: { content: string; allowedMentions?: unknown }) => {
        dc.sent.push({ channel: channelId, content: options.content, allowedMentions: options.allowedMentions });
      },
    },
  };
  for (const handler of dc.handlers.get('messageCreate') ?? []) handler(message);
  await settle();
}
const mention = (text: string) => `<@${BOT_ID}> ${text}`;

beforeEach(() => {
  resetLaunches();
  resetResumeTracking();
  fs.rmSync(tmpHome, { recursive: true, force: true });
  fs.mkdirSync(PROJECT, { recursive: true });
  agents.clear();
  ptyProcesses.clear();
  spawned.length = 0;
  dc.handlers.clear(); dc.sent.length = 0; dc.logins.length = 0; dc.destroyed = 0; dc.loginFails = false; dc.stats = null;
  settings = baseSettings();
  saves = 0;
  seedFleet();
  initDiscordBot(() => settings, () => { saves++; }, null);
});

afterEach(() => {
  stopDiscordBot();
});

describe('who the Discord bot answers', () => {
  it('answers an allowed member who mentions it, and signs in with the saved token', async () => {
    expect(dc.logins).toEqual(['dc-bot-token']);
    await discord({ content: mention('help') });
    expect(said('C-TEAM')).toHaveLength(1);
    expect(said('C-TEAM')[0]).toContain('👑 **Tars Bot**');
  });

  it('tells a stranger its ID in a direct message and when it mentions the bot, and ignores it otherwise', async () => {
    await discord({ author: STRANGER, content: 'hello', direct: true });
    await discord({ author: STRANGER, content: 'just chatting' });
    await discord({ author: STRANGER, content: mention('status') });
    expect(said()).toEqual([
      `⛔ This bot only answers the Discord users allowed in Tars Settings > Discord. Your Discord user ID is ${STRANGER}.`,
      `⛔ This bot only answers the Discord users allowed in Tars Settings > Discord. Your Discord user ID is ${STRANGER}.`,
    ]);
    expect(typed()).toBe('');
  });

  it('answers nobody while the allowed list is empty', async () => {
    settings.discordAllowedUserIds = [];
    await discord({ content: mention('status') });
    expect(said()[0]).toContain(`Your Discord user ID is ${NOAH}`);
    expect(said()).toHaveLength(1);
  });

  it('leaves a member\'s channel message alone unless it mentions the bot, and answers every direct message', async () => {
    await discord({ content: 'status' });
    expect(said()).toEqual([]);
    await discord({ content: 'status', direct: true });
    expect(said('D-NOAH')[0]).toContain('📊 **Agents Status**');
  });

  it('answers every channel message of a member when Require @mention is off, and still ignores a stranger there', async () => {
    settings.discordRequireMention = false;
    await discord({ content: 'status' });
    await discord({ author: STRANGER, content: 'status' });
    expect(said()).toHaveLength(1);
    expect(said()[0]).toContain('📊 **Agents Status**');
  });

  it('never answers a bot, itself included', async () => {
    await discord({ bot: true, content: mention('status') });
    expect(said()).toEqual([]);
  });

  it('saves the channel it answers from, once', async () => {
    await discord({ content: mention('help') });
    await discord({ content: mention('help') });
    expect(settings.discordChannelId).toBe('C-TEAM');
    expect(saves).toBe(1);
  });
});

describe('what the Discord bot says', () => {
  it('reports the fleet in Discord\'s bold, the orchestrator first, a project per line', async () => {
    agents.get('agent-orch')!.status = 'running';
    await discord({ content: mention('status') });
    await discord({ content: mention('projects') });
    const [status, projects] = said();
    expect(status).toContain('🟢 **Running (2):**');
    expect(status.indexOf('👑 **Lead**')).toBeLessThan(status.indexOf('🤖 **Dune**'));
    expect(status).toContain('⚪ **Idle (1):**\n🐸 **Rest** ⚪');
    expect(projects).toContain('📁 **atlas**');
    expect(projects).toContain('👥 Agents: 🐸Rest⚪, 🤖Dune🟢');
  });

  it('prices usage with the table Telegram uses', async () => {
    dc.stats = { modelUsage: { 'claude-opus-4-5-20251101': { inputTokens: 1_000_000, outputTokens: 100_000 } }, totalSessions: 3 };
    await discord({ content: mention('usage') });
    expect(said()[0]).toContain('💰 **Total Cost:** $7.50');
    expect(said()[0]).toContain('🟣 Opus 4.5: $7.50');
    expect(said()[0]).toContain('📝 3 sessions');
  });

  it('starts an agent cold, resuming its last conversation, and says so', async () => {
    const rest = agents.get('agent-rest')!;
    rest.resumableSessionId = '0b7f3c1e-5d2a-4e8b-9c6f-1a2b3c4d5e6f';
    const transcript = transcriptPath(rest.projectPath, rest.resumableSessionId);
    fs.mkdirSync(path.dirname(transcript), { recursive: true });
    fs.writeFileSync(transcript, '{"type":"user"}\n');
    await discord({ content: mention('start rest Measure the Usage page') });
    expect(said()).toEqual(['🚀 Started **Rest**\n\n🐸 Task: Measure the Usage page']);
    expect(typed()).toContain(`--resume '0b7f3c1e-5d2a-4e8b-9c6f-1a2b3c4d5e6f'`);
    expect(typed()).toContain(`-- 'Measure the Usage page'`);
    expect(rest.status).toBe('running');
  });

  it('stops an agent', async () => {
    liveCli('agent-dune');
    await discord({ content: mention('stop dune') });
    expect(said()).toEqual(['🛑 Stopped **Dune**']);
    expect(agents.get('agent-dune')!.status).toBe('idle');
  });

  it('types anything else into the orchestrator, as from Discord, with the channel to answer in', async () => {
    liveCli('agent-orch');
    await discord({ content: mention('what is everyone doing?') });
    expect(said()).toEqual(['👑 Super Agent is processing...']);
    expect(typed()).toContain('Message from Discord: ');
    expect(typed()).toContain('[FROM DISCORD channel_id=C-TEAM - Use send_discord MCP tool with channel_id="C-TEAM" to respond!] what is everyone doing?');
  });

  it('never pings, whatever the text holds', async () => {
    await discord({ content: mention('start rest @everyone look at this') });
    expect(dc.sent.length).toBeGreaterThan(0);
    for (const s of dc.sent) expect(s.allowedMentions).toEqual({ parse: [] });
  });
});

describe('what Tars posts to Discord on its own (send_discord)', () => {
  it('posts to the channel Settings keeps, and to one an allowed member wrote from', async () => {
    settings.discordChannelId = 'C-TEAM';
    expect(await sendDiscordMessage('to the team', settings, 'C-TEAM')).toEqual({ ok: true });
    await discord({ content: 'hi', direct: true });
    expect(await sendDiscordMessage('to Noah', settings, 'D-NOAH')).toEqual({ ok: true });
    expect(said('C-TEAM')).toContain('to the team');
    expect(said('D-NOAH')).toContain('to Noah');
  });

  it('refuses any other channel the bot can see', async () => {
    settings.discordChannelId = 'C-TEAM';
    const r = await sendDiscordMessage('elsewhere', settings, 'C-OTHER');
    expect(r).toMatchObject({ ok: false, status: 403 });
    expect(said('C-OTHER')).toEqual([]);
  });

  it('cuts a long message at Discord\'s limit', async () => {
    settings.discordChannelId = 'C-TEAM';
    await sendDiscordMessage('x'.repeat(2500), settings);
    expect(said('C-TEAM')[0]).toBe('x'.repeat(1900) + '\n\n*(truncated)*');
  });

  it('says why when the bot is off', async () => {
    stopDiscordBot();
    expect(await sendDiscordMessage('anyone?', settings, 'C-TEAM')).toMatchObject({ ok: false, status: 400 });
  });

  it('is what /api/discord/send does, the orchestrator\'s crown first', async () => {
    const routes = new Map<string, Handler>();
    registerDiscordRoutes({ post: (p: string, h: Handler) => routes.set(p, h) } as never, { getAppSettings: () => settings } as never);
    settings.discordChannelId = 'C-TEAM';
    const answers: Array<[unknown, number | undefined]> = [];
    const sendJson = (body: unknown, status?: number) => { answers.push([body, status]); };
    await routes.get('/api/discord/send')!({ body: { message: 'Done.' } }, sendJson);
    await routes.get('/api/discord/send')!({ body: {} }, sendJson);
    await routes.get('/api/discord/send')!({ body: { message: 'Done.', channel_id: 'C-OTHER' } }, sendJson);
    expect(said('C-TEAM')).toEqual(['👑 Done.']);
    expect(answers.map(([, status]) => status)).toEqual([undefined, 400, 403]);
  });
});

describe('Settings > Discord: test token and send test', () => {
  const realFetch = globalThis.fetch;
  afterEach(() => { globalThis.fetch = realFetch; });

  it('names the bot the token signs in as, and gives the link that invites it', async () => {
    registerDiscordHandlers({ getAppSettings: () => settings });
    const asked: Array<[string, unknown]> = [];
    globalThis.fetch = (async (url: string, init?: { headers?: Record<string, string> }) => {
      asked.push([url, init?.headers?.Authorization]);
      return new Response(JSON.stringify({ id: '1100000000000000001', username: 'Tars' }), { status: 200 });
    }) as typeof fetch;
    const r = await ipc.get('discord:test')!({});
    expect(r).toEqual({ success: true, botName: 'Tars', inviteUrl: discordInviteUrl('1100000000000000001') });
    expect(discordInviteUrl('1')).toBe('https://discord.com/oauth2/authorize?client_id=1&scope=bot&permissions=68608');
    expect(asked).toEqual([['https://discord.com/api/v10/users/@me', 'Bot dc-bot-token']]);
  });

  it('says so when Discord refuses the token, when there is none, and when Discord does not answer', async () => {
    registerDiscordHandlers({ getAppSettings: () => settings });
    globalThis.fetch = (async () => new Response('{"message":"401: Unauthorized"}', { status: 401 })) as typeof fetch;
    expect(await ipc.get('discord:test')!({})).toEqual({ success: false, error: 'Discord refused the token: reset it in the Developer Portal and paste the new one.' });
    globalThis.fetch = (async () => { throw new Error('getaddrinfo ENOTFOUND discord.com'); }) as typeof fetch;
    expect(await ipc.get('discord:test')!({})).toEqual({ success: false, error: 'Discord did not answer: getaddrinfo ENOTFOUND discord.com' });
    settings.discordBotToken = '';
    expect(await ipc.get('discord:test')!({})).toEqual({ success: false, error: 'Set the bot token first.' });
  });

  it('sends a test message to the detected channel, and waits for one', async () => {
    registerDiscordHandlers({ getAppSettings: () => settings });
    expect(await ipc.get('discord:sendTest')!({})).toEqual({ success: false, error: 'No channel yet: mention the bot or send it a direct message first.' });
    settings.discordChannelId = 'C-TEAM';
    expect(await ipc.get('discord:sendTest')!({})).toEqual({ success: true });
    expect(said('C-TEAM')).toEqual(['✅ Test message from Tars!']);
  });
});

describe('starting and stopping the bot', () => {
  it('starts nothing while it is off or has no token', () => {
    stopDiscordBot();
    dc.logins.length = 0;
    initDiscordBot(() => ({ ...settings, discordEnabled: false }), () => {}, null);
    initDiscordBot(() => ({ ...settings, discordBotToken: '' }), () => {}, null);
    expect(dc.logins).toEqual([]);
    expect(getDiscordClient()).toBeNull();
  });

  it('keeps no client when Discord refuses the token', async () => {
    stopDiscordBot();
    dc.loginFails = true;
    initDiscordBot(() => settings, () => {}, null);
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(getDiscordClient()).toBeNull();
  });

  it('closes the old client when it starts again', () => {
    initDiscordBot(() => settings, () => {}, null);
    expect(dc.destroyed).toBe(1);
  });
});
