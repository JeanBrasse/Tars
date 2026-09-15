import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { randomUUID } from 'crypto';
import type { AgentTranscript } from '../../../electron/services/agent-transcript';

const { handlers, agents } = vi.hoisted(() => ({
  handlers: new Map<string, (...args: unknown[]) => Promise<unknown>>(),
  agents: new Map<string, Record<string, unknown>>(),
}));

vi.mock('electron', () => ({
  ipcMain: {
    handle: vi.fn((channel: string, fn: (...args: unknown[]) => Promise<unknown>) => {
      handlers.set(channel, fn);
    }),
  },
}));

// The agent registry alone, without the PTYs and the persistence around it.
// The provider registry and the reader stay real: which CLI writes a journal,
// and what is on disk, are the behaviour under test.
vi.mock('../../../electron/core/agent-manager', () => ({ agents }));

import { registerTranscriptHandlers } from '../../../electron/handlers/transcript-handlers';

const PROJECT = '/Users/someone/work/demo.app';
const PROJECT_DIR = '-Users-someone-work-demo-app';

let home: string;
let realHome: string | undefined;

beforeEach(() => {
  realHome = process.env.HOME;
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'tars-transcript-ipc-'));
  // The handler finds ~ through os.homedir(), which follows HOME. Asserted
  // rather than assumed: if it ever stopped, these reads would head for a real
  // ~/.claude, and this line fails first.
  process.env.HOME = home;
  expect(os.homedir()).toBe(home);

  agents.clear();
  handlers.clear();
  registerTranscriptHandlers();
});

afterEach(() => {
  if (realHome === undefined) delete process.env.HOME;
  else process.env.HOME = realHome;
  fs.rmSync(home, { recursive: true, force: true });
});

function addAgent(fields: Record<string, unknown>): string {
  const id = randomUUID();
  agents.set(id, { id, status: 'idle', provider: 'claude', projectPath: PROJECT, ...fields });
  return id;
}

function transcriptFile(sessionId: string): string {
  return path.join(home, '.claude', 'projects', PROJECT_DIR, `${sessionId}.jsonl`);
}

function writeTranscript(sessionId: string, text: string): void {
  const file = transcriptFile(sessionId);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const said = { type: 'user', uuid: randomUUID(), timestamp: '2026-09-15T21:00:00.000Z', message: { role: 'user', content: text } };
  fs.writeFileSync(file, `${JSON.stringify(said)}\n`);
}

/** What `window.electronAPI.agent.transcript({ agentId })` resolves to. */
function transcript(agentId: string): Promise<AgentTranscript> {
  const handler = handlers.get('agent:transcript');
  if (!handler) throw new Error('agent:transcript is not registered');
  return handler({}, { agentId }) as Promise<AgentTranscript>;
}

/**
 * A named absence: the reason a panel branches on, and a sentence it can print
 * as it is. Not a path, not a code, and no dash a reader would see.
 */
function expectAbsence(result: AgentTranscript, reason: string): void {
  expect(result).toMatchObject({ available: false, reason });
  if (result.available) return;
  expect(result.detail).toMatch(/^[A-Z][^\n]*\.$/);
  expect(result.detail).not.toContain(home);
  expect(result.detail).not.toMatch(/\.claude|\.jsonl|[–—]/);
}

describe('the four named absences, as a panel receives them', () => {
  it('unsupported-provider: a CLI that keeps no such journal is named, even with a transcript on disk', async () => {
    const sessionId = randomUUID();
    writeTranscript(sessionId, 'Port the billing export.');

    const result = await transcript(addAgent({ provider: 'codex', currentSessionId: sessionId }));

    expectAbsence(result, 'unsupported-provider');
    expect(result).toMatchObject({ detail: expect.stringContaining('Codex CLI') });
  });

  it('no-session: an agent that never registered a session, and one that no longer exists', async () => {
    expectAbsence(await transcript(addAgent({})), 'no-session');
    expectAbsence(await transcript(randomUUID()), 'no-session');
  });

  it('not-found: a session id with no file behind it', async () => {
    expectAbsence(await transcript(addAgent({ currentSessionId: randomUUID() })), 'not-found');
  });

  it('unreadable: something is at the path and it cannot be read', async () => {
    // A directory where the file should be. A chmod 000 file is the likelier
    // cause in life, but root can read one, so it would not fail everywhere.
    const sessionId = randomUUID();
    fs.mkdirSync(transcriptFile(sessionId), { recursive: true });

    expectAbsence(await transcript(addAgent({ currentSessionId: sessionId })), 'unreadable');
  });
});

describe('which agents get read', () => {
  it('a provider that runs the claude binary is read like Claude Code itself', async () => {
    const sessionId = randomUUID();
    writeTranscript(sessionId, 'Rename the invoices table.');

    const result = await transcript(addAgent({ provider: 'deepseek', currentSessionId: sessionId }));

    expect(result).toMatchObject({
      available: true,
      sessionId,
      messages: [{ role: 'user', text: 'Rename the invoices table.' }],
    });
  });
});
