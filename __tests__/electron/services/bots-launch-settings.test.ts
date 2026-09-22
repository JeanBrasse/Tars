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
import { getSuperAgent, getSuperAgentInstructionsPath } from '../../../electron/utils';
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
    // As main.ts hands it over: the first orchestrator, by role.
    () => getSuperAgent(agents),
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
    agent({ id: 'agent-s', name: 'Super Agent (Orchestrator)', role: 'orchestrator', effort: 'medium', model: 'claude-opus-5-5' });

    const typed = await typedAfter(() => sendToSuperAgent('42', 'what is everyone doing'));

    expect(typed).toContain(" --model 'claude-opus-5-5'");
    expect(typed).toContain(' --effort medium ');
  });
});

describe('the role, on the launches the bots make', () => {
  // The toggle is the role (core/agent-role.ts). These two launches decided it
  // by the role alone already, and never attached the instructions: an
  // orchestrator started from a phone did the work itself.
  const INSTRUCTIONS = () => `--append-system-prompt-file '${getSuperAgentInstructionsPath()}'`;
  const TOOL_BLOCK = '--disallowed-tools "Edit" "Write" "MultiEdit" "NotebookEdit" "Task"';

  it('Telegram /start_agent launches an orchestrator with its instructions, and a worker called orchestrator as a worker', async () => {
    agent({ id: 'agent-o', name: 'Lead', role: 'orchestrator' });
    agent({ id: 'agent-w', name: 'Tars-Orchestrator', role: 'worker' });
    const startAgent = bot.texts.find(t => t.pattern.source.includes('start_agent'))!;
    const launch = (text: string) => typedAfter(async () => {
      await startAgent.handler({ chat: { id: 42, type: 'private' }, text }, startAgent.pattern.exec(text));
    });

    const lead = await launch('/start_agent lead Plan the release');
    const named = await launch('/start_agent tars-orchestrator Fix the build');

    expect(lead).toContain(INSTRUCTIONS());
    expect(lead).toContain(TOOL_BLOCK);
    expect(named).not.toContain('--append-system-prompt-file');
    expect(named).not.toContain('--disallowed-tools');
  });

  it('Slack `start` does the same', async () => {
    agent({ id: 'agent-o', name: 'Lead', role: 'orchestrator' });
    agent({ id: 'agent-w', name: 'Tars-Orchestrator', role: 'worker' });

    const lead = await typedAfter(() => handleSlackCommand('start lead Plan the release', 'C1', async () => undefined, settings));
    const named = await typedAfter(() => handleSlackCommand('start tars-orchestrator Fix the build', 'C1', async () => undefined, settings));

    expect(lead).toContain(INSTRUCTIONS());
    expect(lead).toContain(TOOL_BLOCK);
    expect(named).not.toContain('--append-system-prompt-file');
    expect(named).not.toContain('--disallowed-tools');
  });

  it('a message goes to the agent whose role is orchestrator, not to one named like it', async () => {
    agent({ id: 'agent-w', name: 'Super Agent', role: 'worker' });
    agent({ id: 'agent-o', name: 'Lead', role: 'orchestrator' });

    await typedAfter(() => sendToSuperAgent('42', 'what is everyone doing'));

    expect(agents.get('agent-o')!.status).toBe('running');
    expect(agents.get('agent-w')!.status).toBe('idle');
  });
});

describe("the super agent's cold start, from a message", () => {
  // Added at the QA gate of #123. The two launches of the orchestrator that a
  // message makes when it is not running: the role picks it, and nothing read
  // the flags it was started with. A Telegram message starts it in bypass,
  // since nobody is there to answer a permission question; a Slack message
  // starts it on its own mode (SPECS §4, The orchestrator role). Both with the
  // instructions and without the editing tools.
  const TOOL_BLOCK = '--disallowed-tools "Edit" "Write" "MultiEdit" "NotebookEdit" "Task"';
  const promptFile = (typed: string) => /--append-system-prompt-file '([^']+)'/.exec(typed)?.[1];

  it('from Telegram: the instructions, no editing tools, and bypass', async () => {
    agent({ id: 'agent-s', name: 'Lead', role: 'orchestrator', permissionMode: 'auto' });

    const typed = await typedAfter(() => sendToSuperAgent('42', 'what is everyone doing'));

    expect(typed).toContain(TOOL_BLOCK);
    expect(typed).toContain(' --dangerously-skip-permissions');
    expect(typed).not.toContain('--permission-mode');
    const file = promptFile(typed);
    expect(file, typed).toBeDefined();
    // Telegram's own instructions are appended to the orchestration ones, in a file of its data folder.
    expect(fs.readFileSync(file!, 'utf-8')).toContain(fs.readFileSync(getSuperAgentInstructionsPath(), 'utf-8'));
  });

  it('from Slack: the instructions, no editing tools, and its own permission mode', async () => {
    agent({ id: 'agent-s', name: 'Lead', role: 'orchestrator', permissionMode: 'auto' });

    const typed = await typedAfter(() => sendToSuperAgentFromSlack('C1', 'what is everyone doing', async () => undefined, settings));

    expect(typed).toContain(TOOL_BLOCK);
    expect(typed).toContain(' --permission-mode auto');
    expect(typed).not.toContain('--dangerously-skip-permissions');
    expect(promptFile(typed)).toBe(getSuperAgentInstructionsPath());
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
