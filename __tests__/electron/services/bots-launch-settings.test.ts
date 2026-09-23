import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

/**
 * The four launches the Telegram and Slack bots make, an agent by name and
 * the super agent from a message on each, run on the agent's model and
 * effort, medium included.
 *
 * These four always passed the agent's own model. Medium was the level they
 * dropped, like every launch on the claude binary, and without it Claude Code
 * starts at the effort it last saved for that model from any terminal: an
 * agent set to medium ran at whatever somebody had last chosen elsewhere.
 *
 * The bots, the provider builders, initAgentPty, spawnAgentPty and the writer
 * are the real ones; node-pty, the Telegram client and the window are fakes.
 */

const { tmpHome } = vi.hoisted(() => ({
  tmpHome: `${process.env.TMPDIR?.replace(/\/$/, '') || '/tmp'}/tars-bots-launch-${process.pid}-${Date.now()}`,
}));

type FakePty = { pid: number; process: string; write: ReturnType<typeof vi.fn>; kill: ReturnType<typeof vi.fn>; resize: ReturnType<typeof vi.fn>; onData: ReturnType<typeof vi.fn>; onExit: ReturnType<typeof vi.fn> };
const spawned = vi.hoisted(() => [] as FakePty[]);
const bot = vi.hoisted(() => ({
  texts: [] as Array<{ pattern: RegExp; handler: (msg: Record<string, unknown>, match: RegExpExecArray | null) => unknown }>,
  sent: [] as string[],
}));

vi.mock('os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('os')>();
  return { ...actual, homedir: () => tmpHome, default: { ...actual, homedir: () => tmpHome } };
});
vi.mock('node-pty', () => ({
  spawn: vi.fn((file: string): FakePty => {
    const terminal: FakePty = { pid: 7000 + spawned.length, process: file, write: vi.fn(), kill: vi.fn(), resize: vi.fn(), onData: vi.fn(), onExit: vi.fn() };
    spawned.push(terminal);
    return terminal;
  }),
}));
vi.mock('electron', () => ({
  app: { getPath: () => tmpHome, getAppPath: () => process.cwd(), isPackaged: false, getVersion: () => '1.7.9' },
  BrowserWindow: Object.assign(vi.fn(), { getAllWindows: () => [] }),
  Notification: vi.fn(),
}));
vi.mock('../../../electron/core/window-manager', () => ({ getMainWindow: () => null }));
vi.mock('@slack/bolt', () => ({ App: class {}, LogLevel: { INFO: 'info' } }));
vi.mock('node-telegram-bot-api', () => ({
  default: class {
    on() {}
    onText(pattern: RegExp, handler: (msg: Record<string, unknown>, match: RegExpExecArray | null) => unknown) {
      bot.texts.push({ pattern, handler });
    }
    getMe() { return Promise.resolve({ username: 'tars_test_bot' }); }
    sendMessage(_chatId: unknown, text: string) { bot.sent.push(text); return Promise.resolve({}); }
    stopPolling() { return Promise.resolve(); }
  },
}));

import { agents, initAgentPty } from '../../../electron/core/agent-manager';
import { ptyProcesses } from '../../../electron/core/pty-manager';
import { initTelegramBotService, initTelegramBot, stopTelegramBot, sendToSuperAgent } from '../../../electron/services/telegram-bot';
import { handleSlackCommand, sendToSuperAgentFromSlack } from '../../../electron/services/slack-bot';
import type { AgentStatus, AppSettings } from '../../../electron/types';

const project = path.join(tmpHome, 'project');
const settings = {
  telegramEnabled: true,
  telegramBotToken: 'test-bot-token',
  telegramAuthToken: 'test-auth-token',
  telegramAuthorizedChatIds: ['42'],
} as AppSettings;

function agent(fields: Partial<AgentStatus>): AgentStatus {
  const record = {
    id: 'agent-w', name: 'Worker', status: 'idle', provider: 'claude', projectPath: project,
    skills: [], output: [], lastActivity: new Date().toISOString(), permissionMode: 'bypass',
    model: 'claude-opus-5-5', effort: 'medium',
    ...fields,
  } as AgentStatus;
  agents.set(record.id, record);
  return record;
}

/** What was typed into the terminal the launch opened. */
async function typedAfter(launch: () => Promise<unknown>): Promise<string> {
  const before = spawned.length;
  await launch();
  // The command goes in as a paste and its Enter 300 ms later.
  await new Promise(resolve => setTimeout(resolve, 450));
  const terminal = spawned[before];
  expect(terminal, 'the launch opened no terminal').toBeDefined();
  return terminal.write.mock.calls.map(call => String(call[0])).join('');
}

beforeEach(() => {
  fs.rmSync(tmpHome, { recursive: true, force: true });
  fs.mkdirSync(project, { recursive: true });
  agents.clear();
  ptyProcesses.clear();
  spawned.length = 0;
  bot.texts.length = 0;
  bot.sent.length = 0;
  initTelegramBotService(
    agents, ptyProcesses, settings, null,
    () => Array.from(agents.values()).find(a => a.name?.toLowerCase().includes('super agent')),
    () => {}, async () => null,
    (a: AgentStatus) => initAgentPty(a, null, vi.fn(), vi.fn()),
    () => {},
  );
  initTelegramBot();
});

afterEach(() => {
  stopTelegramBot();
});

describe('Telegram', () => {
  it("/start_agent runs on the agent's model and effort", async () => {
    agent({});
    const startAgent = bot.texts.find(t => t.pattern.source.includes('start_agent'))!;
    const text = '/start_agent worker Rebase onto main';

    const typed = await typedAfter(async () => {
      await startAgent.handler({ chat: { id: 42, type: 'private' }, text }, startAgent.pattern.exec(text));
    });

    expect(typed).toContain(" --model 'claude-opus-5-5'");
    expect(typed).toContain(' --effort medium ');
  });

  it("a message to the super agent starts it on its model and effort", async () => {
    agent({ id: 'agent-s', name: 'Super Agent (Orchestrator)', effort: 'medium', model: 'claude-opus-5-5' });

    const typed = await typedAfter(() => sendToSuperAgent('42', 'what is everyone doing'));

    expect(typed).toContain(" --model 'claude-opus-5-5'");
    expect(typed).toContain(' --effort medium ');
  });
});

describe('Slack', () => {
  it("`start <agent> <task>` runs on the agent's model and effort", async () => {
    agent({});

    const typed = await typedAfter(() => handleSlackCommand('start worker Rebase onto main', 'C1', async () => undefined, settings));

    expect(typed).toContain(" --model 'claude-opus-5-5'");
    expect(typed).toContain(' --effort medium ');
  });

  it("a message to the super agent starts it on its model and effort", async () => {
    agent({ id: 'agent-s', name: 'Super Agent (Orchestrator)', role: 'orchestrator' });

    const typed = await typedAfter(() => sendToSuperAgentFromSlack('C1', 'what is everyone doing', async () => undefined, settings));

    expect(typed).toContain(" --model 'claude-opus-5-5'");
    expect(typed).toContain(' --effort medium ');
  });
});
