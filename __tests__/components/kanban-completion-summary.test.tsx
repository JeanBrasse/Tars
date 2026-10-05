import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mount, settle, type Mount } from './hook-runtime';
import { useKanbanAgentSync } from '../../src/hooks/useElectronKanban';
import type { KanbanTask, KanbanTaskUpdate } from '../../src/types/kanban';

vi.mock('react', async (importOriginal) => ({
  ...(await importOriginal<typeof import('react')>()),
  ...(await import('./hook-runtime')).hooks,
}));

/**
 * What a completed Kanban task keeps of its agent's terminal
 * (useKanbanAgentSync, on agent:complete). The Audit's Low at #319's gate.
 * Written before the code. How it can fail:
 * 1. the summary joins the last 50 chunks of agent:get's output, and agent:get
 *    hands one chunk, the whole serialized screen with its scrollback and its
 *    escape codes: the task kept about 170 KB of it, 900 KB with the mirror at
 *    5,000 lines, and the done summary showed the codes;
 * 2. a terminal that printed nothing a person can read leaves a blank summary
 *    where the task said it completed, or completed with errors.
 */

type Complete = (event: { agentId: string; exitCode: number }) => void;

const ESC = '\x1b';
const row = (i: number) => `${ESC}[38;5;${i % 255}m${'█'.repeat(40)}${ESC}[3Cline ${i}${ESC}[0m`;
const SCREEN = `${ESC}c${Array.from({ length: 3000 }, (_, i) => row(i)).join('\r\n')}\r\n\r\n${ESC}[?25h${ESC}[24;1H`;

const TASK: KanbanTask = {
  id: 't1', title: 'Build the page', description: '', column: 'ongoing', projectId: 'p', projectPath: '/p',
  assignedAgentId: 'a1', agentCreatedForTask: false, requiredSkills: [], priority: 'medium', progress: 50,
  createdAt: '2026-10-05T08:00:00.000Z', updatedAt: '2026-10-05T08:00:00.000Z', order: 0, labels: [], attachments: [],
};

const g = globalThis as unknown as { window?: unknown };

describe('a completed Kanban task keeps the last lines a person can read', () => {
  let complete: Complete | undefined;
  let output: string[];
  let updates: KanbanTaskUpdate[];
  let moves: Array<[string, string]>;
  let hook: Mount<void>;

  beforeEach(async () => {
    complete = undefined;
    updates = [];
    moves = [];
    g.window = {
      electronAPI: {
        agent: {
          onStatus: () => () => {},
          onComplete: (cb: Complete) => { complete = cb; return () => { complete = undefined; }; },
          get: vi.fn(async () => ({ id: 'a1', output })),
        },
      },
    };
    hook = mount(() => useKanbanAgentSync(
      [TASK],
      async params => { updates.push(params); },
      async (id, column) => { moves.push([id, column]); },
    ));
    await settle();
    expect(complete, 'the hook listens for agent:complete').toBeTypeOf('function');
  });

  afterEach(() => {
    hook.unmount();
    delete g.window;
  });

  it('the last 50 plain lines of the screen, a few kilobytes, never its escape codes (1)', async () => {
    output = [SCREEN];
    expect(SCREEN.length).toBeGreaterThan(150_000);
    complete!({ agentId: 'a1', exitCode: 0 });
    await settle();
    const summary = updates[0]?.completionSummary ?? '';
    expect(summary).not.toContain(ESC);
    expect(summary.length).toBeLessThan(5_000);
    expect(summary.split('\n')).toEqual(Array.from({ length: 50 }, (_, i) => `${'█'.repeat(40)}   line ${2950 + i}`));
    expect(moves).toEqual([['t1', 'done']]);
  });

  it('the task\'s own sentence when nothing on the screen can be read (2)', async () => {
    output = [`${ESC}c${ESC}[?25h\r\n\r\n${ESC}[1;1H`];
    complete!({ agentId: 'a1', exitCode: 1 });
    await settle();
    expect(updates[0]?.completionSummary).toBe('Task completed with errors.');
  });
});
