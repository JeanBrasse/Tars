import { describe, it, expect, vi, beforeEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import * as os from 'node:os';
import * as fs from 'node:fs';
import * as path from 'node:path';

/**
 * The auto-updater is off in a PTY Tars started.
 *
 * Not because it loses a dispatch: it does not. Claude Code starts it from a
 * fire-and-forget effect in its footer component and re-runs it on a thirty
 * minute interval, and an agent on this machine was observed finishing a four
 * minute task while the updater cycled and failed underneath it. What it does
 * do is replace the binary under a live session, and redraw every thirty
 * minutes, which for an idle agent is the ONLY output it produces: the hundred
 * chunks Tars keeps per agent fill with update noise and the terminal's real
 * history is lost. Sixteen agents here had nothing else left in their buffer,
 * which is exactly what made the updater look like the cause.
 *
 * Two things have to hold, and the second is the one worth proving: the
 * variable has to be set for the right binaries, and it has to actually reach
 * the process. So this drives the real initAgentPty, takes the env object it
 * hands to the spawn, and runs a real child process with it.
 */

const spawnCalls: Array<{ env: Record<string, string> }> = [];

vi.mock('node-pty', () => ({
  spawn: vi.fn((_shell: string, _args: string[], opts: { env: Record<string, string> }) => {
    spawnCalls.push({ env: opts.env });
    return { onData: vi.fn(), onExit: vi.fn(), kill: vi.fn(), write: vi.fn(), pid: 1 };
  }),
}));

vi.mock('uuid', () => ({ v4: vi.fn(() => 'test-uuid') }));

vi.mock('electron', () => ({
  app: { getPath: () => os.tmpdir() },
  BrowserWindow: vi.fn(),
  Notification: vi.fn(),
}));

// Reached during spawn; none of it is what this test is about.
vi.mock('../../../electron/utils/broadcast', () => ({ broadcastToAllWindows: vi.fn() }));
vi.mock('../../../electron/utils/agents-tick', () => ({ scheduleTick: vi.fn() }));
vi.mock('../../../electron/services/agent-events', () => ({ emitAgentStatus: vi.fn() }));
vi.mock('../../../electron/services/tasmania-client', () => ({
  getTasmaniaStatus: vi.fn(async () => ({ status: 'stopped' })),
}));

import { managedCliEnv } from '../../../electron/providers/cli-provider';
import { getAllProviders, getProvider } from '../../../electron/providers';
import { initAgentPty } from '../../../electron/core/agent-manager';
import type { AgentStatus } from '../../../electron/types';

/** The five CLIs that are not the claude binary and have their own updaters. */
const FOREIGN_BINARIES = ['codex', 'gemini', 'grok', 'opencode', 'pi'];

describe('which CLIs the variable is for', () => {
  it('covers every provider that re-points the claude binary, and no others', () => {
    const claudeFamily: string[] = [];
    const foreign: string[] = [];

    for (const provider of getAllProviders()) {
      const vars = managedCliEnv(provider.binaryName);
      if (provider.binaryName === 'claude') {
        expect(vars, `${provider.id} runs claude and must have it`).toEqual({ DISABLE_AUTOUPDATER: '1' });
        claudeFamily.push(provider.id);
      } else {
        // Setting it on a binary that never reads it would only look like
        // coverage. codex/gemini/grok/opencode/pi update themselves.
        expect(vars, `${provider.id} does not run claude and must not have it`).toEqual({});
        foreign.push(provider.binaryName);
      }
    }

    // Pinned so the scope of this change cannot drift silently: the registry is
    // the source of truth, and a new claude-family provider is covered by
    // construction rather than by a second edit.
    expect(claudeFamily.length).toBe(14);
    expect([...new Set(foreign)].sort()).toEqual(FOREIGN_BINARIES);
  });

  it("follows the registry's own fallback, so 'local' is covered too", () => {
    // `local` is a claude sub-mode: getProvider falls back to claude for it and
    // for any unknown id, and this reads the same binaryName the spawn does.
    expect(managedCliEnv(getProvider('local').binaryName)).toEqual({ DISABLE_AUTOUPDATER: '1' });
  });
});

describe('the variable reaches the PTY environment', () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'tars-pty-env-'));

  beforeEach(() => {
    spawnCalls.length = 0;
  });

  function agent(overrides: Partial<AgentStatus>): AgentStatus {
    return {
      id: 'agent-under-test',
      name: 'Agent Under Test',
      status: 'idle',
      projectPath: cwd,
      ...overrides,
    } as AgentStatus;
  }

  it('is in the env handed to the spawn for a claude agent', async () => {
    await initAgentPty(agent({ provider: 'claude' }), null, vi.fn(), vi.fn());

    expect(spawnCalls.length).toBe(1);
    expect(spawnCalls[0].env.DISABLE_AUTOUPDATER).toBe('1');
  });

  it('is absent for a CLI that does not read it', async () => {
    await initAgentPty(agent({ id: 'codex-agent', provider: 'codex' }), null, vi.fn(), vi.fn());

    expect(spawnCalls.length).toBe(1);
    expect(spawnCalls[0].env.DISABLE_AUTOUPDATER).toBeUndefined();
  });

  it('survives into a real process started with that env', async () => {
    await initAgentPty(agent({ id: 'real-env-agent', provider: 'openrouter' }), null, vi.fn(), vi.fn());
    expect(spawnCalls.length).toBe(1);

    // The env object initAgentPty built, handed to a process that actually
    // starts. node-pty is rebuilt against Electron's ABI, so spawning one here
    // would be testing the build rather than the behaviour; a PTY and a pipe
    // inherit the environment identically, and what is asserted is that the
    // CLI would read it.
    const seen = execFileSync('/bin/sh', ['-c', 'printf %s "$DISABLE_AUTOUPDATER"'], {
      env: spawnCalls[0].env,
      encoding: 'utf-8',
    });

    expect(seen).toBe('1');
  });

  it('does not reach for the administrator lockdown', async () => {
    await initAgentPty(agent({ id: 'lockdown-agent', provider: 'claude' }), null, vi.fn(), vi.fn());

    // DISABLE_UPDATES is checked first by the binary and also makes an
    // explicitly typed `claude update` refuse. These are real terminals the
    // user can take over, so a command they type stays theirs.
    expect(spawnCalls[0].env.DISABLE_UPDATES).toBeUndefined();
  });
});
