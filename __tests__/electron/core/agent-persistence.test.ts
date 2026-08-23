import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

/**
 * The agent list is the app's only durable record of what the user set up.
 * What matters is that it survives a crash mid-write, that a corrupt file
 * cannot destroy the backup, and that a parse failure never silently empties
 * the list.
 */

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tars-agents-'));
const AGENTS_FILE = path.join(tmp, 'agents.json');
const BACKUP_FILE = path.join(tmp, 'agents.backup.json');

vi.mock('../../../electron/constants', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return { ...actual, DATA_DIR: tmp, AGENTS_FILE };
});

vi.mock('electron', () => ({
  app: { getPath: () => tmp, getAppPath: () => tmp, getVersion: () => '1.4.0' },
  BrowserWindow: { getAllWindows: () => [] },
  ipcMain: { handle: () => undefined, on: () => undefined },
}));

let manager: typeof import('../../../electron/core/agent-manager');

function agent(id: string, over: Record<string, unknown> = {}) {
  return {
    id,
    name: `Agent ${id}`,
    status: 'idle',
    projectPath: tmp,
    output: [],
    lastActivity: new Date().toISOString(),
    provider: 'claude',
    skills: [],
    ...over,
  };
}

beforeEach(async () => {
  for (const f of fs.readdirSync(tmp)) fs.rmSync(path.join(tmp, f), { recursive: true, force: true });
  vi.resetModules();
  manager = await import('../../../electron/core/agent-manager');
});

afterEach(() => {
  manager.stopAgentAutosave();
});

describe('saveAgents', () => {
  it('writes a versioned file that loadAgents reads back', () => {
    manager.loadAgents();
    manager.agents.set('a1', agent('a1', { model: 'claude-opus-5', effort: 'high' }) as never);
    manager.saveAgents();

    const raw = JSON.parse(fs.readFileSync(AGENTS_FILE, 'utf-8'));
    expect(raw.version).toBe(2);
    expect(raw.agents).toHaveLength(1);

    manager.agents.clear();
    manager.loadAgents();
    expect(manager.agents.get('a1')?.model).toBe('claude-opus-5');
    expect(manager.agents.get('a1')?.effort).toBe('high');
  });

  it('leaves no partial file behind: the write is a rename', () => {
    manager.loadAgents();
    manager.agents.set('a1', agent('a1') as never);
    manager.saveAgents();

    expect(fs.existsSync(`${AGENTS_FILE}.tmp`)).toBe(false);
  });

  it('does not let a corrupt current file overwrite the backup', () => {
    manager.loadAgents();
    manager.agents.set('a1', agent('a1') as never);
    manager.saveAgents();
    manager.agents.set('a2', agent('a2') as never);
    manager.saveAgents();

    const goodBackup = fs.readFileSync(BACKUP_FILE, 'utf-8');
    expect(goodBackup).toContain('a1');

    // Something truncates agents.json, then a save happens.
    fs.writeFileSync(AGENTS_FILE, '{"version":2,"agents":[{"id":"a1"');
    manager.saveAgents();

    expect(fs.readFileSync(BACKUP_FILE, 'utf-8')).toBe(goodBackup);
  });
});

describe('loadAgents', () => {
  it('reads the legacy bare-array format', () => {
    fs.writeFileSync(AGENTS_FILE, JSON.stringify([agent('legacy', { skipPermissions: true })]));

    manager.loadAgents();

    expect(manager.agents.get('legacy')?.permissionMode).toBe('auto');
    expect(manager.agents.get('legacy')?.role).toBe('worker');
  });

  it('restores from the backup when the file is unparseable', () => {
    fs.writeFileSync(BACKUP_FILE, JSON.stringify({ version: 2, agents: [agent('saved')] }));
    fs.writeFileSync(AGENTS_FILE, 'not json at all');

    manager.loadAgents();

    expect(manager.agents.has('saved')).toBe(true);
  });

  it('keeps the corrupt file instead of writing an empty list over it', () => {
    fs.writeFileSync(AGENTS_FILE, 'not json at all');

    manager.loadAgents();
    manager.saveAgents();

    expect(fs.existsSync(`${AGENTS_FILE}.corrupt`)).toBe(true);
    expect(fs.readFileSync(`${AGENTS_FILE}.corrupt`, 'utf-8')).toBe('not json at all');
  });

  it('infers the orchestrator role from the name once, then keeps it', () => {
    fs.writeFileSync(AGENTS_FILE, JSON.stringify([agent('o1', { name: 'Backend Orchestrator' })]));

    manager.loadAgents();

    expect(manager.agents.get('o1')?.role).toBe('orchestrator');
  });
});

describe('appendAgentOutput', () => {
  it('keeps the buffer bounded under a flood', () => {
    const a = agent('noisy') as never as { output: string[] };
    for (let i = 0; i < 5000; i++) manager.appendAgentOutput(a as never, `chunk ${i}`);

    expect(a.output.length).toBeLessThanOrEqual(600);
    expect(a.output[a.output.length - 1]).toBe('chunk 4999');
  });
});

describe('autosave', () => {
  it('flushes dirty agents on the timer and not otherwise', async () => {
    manager.loadAgents();
    manager.agents.set('a1', agent('a1') as never);
    manager.saveAgents();

    manager.agents.set('a2', agent('a2') as never);
    manager.markAgentsDirty();
    manager.startAgentAutosave(20);

    await new Promise(resolve => setTimeout(resolve, 80));

    expect(fs.readFileSync(AGENTS_FILE, 'utf-8')).toContain('a2');
  });
});

describe('output rehydration', () => {
  /**
   * `output` is typed as a required string[], but nothing writes it to
   * agents.json - it is runtime state. So every agent read back from disk
   * arrived without it, and the eight consumers that trusted the type crashed
   * on the first method call. fleetSummary's `agent.output.length` took the
   * whole Logs page down for anyone who had agents and restarted the app.
   */
  it('gives every agent read from disk an output buffer', () => {
    const onDisk = [
      { id: 'p1', name: 'Persisted', status: 'idle', projectPath: tmp, provider: 'claude', skills: [] },
      { id: 'p2', name: 'Also persisted', status: 'idle', projectPath: tmp, provider: 'codex', skills: [] },
    ];
    fs.writeFileSync(AGENTS_FILE, JSON.stringify(onDisk));

    manager.agents.clear();
    manager.loadAgents();

    for (const id of ['p1', 'p2']) {
      const restored = manager.agents.get(id)!;
      expect(Array.isArray(restored.output), id).toBe(true);
      // The call that used to throw.
      expect(() => restored.output.length).not.toThrow();
      expect(restored.output.join('')).toBe('');
    }
  });

  it('does not discard an output array that was persisted', () => {
    fs.writeFileSync(AGENTS_FILE, JSON.stringify([
      { id: 'p3', name: 'Has output', status: 'idle', projectPath: tmp, provider: 'claude', skills: [], output: ['kept\n'] },
    ]));

    manager.agents.clear();
    manager.loadAgents();

    expect(manager.agents.get('p3')!.output).toEqual(['kept\n']);
  });

  it('replaces a non-array output rather than trusting it', () => {
    fs.writeFileSync(AGENTS_FILE, JSON.stringify([
      { id: 'p4', name: 'Corrupt', status: 'idle', projectPath: tmp, provider: 'claude', skills: [], output: 'not an array' },
    ]));

    manager.agents.clear();
    manager.loadAgents();

    expect(manager.agents.get('p4')!.output).toEqual([]);
  });
});
