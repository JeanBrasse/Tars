import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

/**
 * Every agent process is started holding a token of its own.
 *
 * The token has to reach the CLI, and from there the MCP servers the CLI
 * starts, through the environment. spawnAgentPty is the one line every agent
 * process starts on (managed-cli-env.test.ts asserts no spawn site goes around
 * it), so that is where it is minted, and these assert what it hands the
 * process rather than that a function was called.
 */

const spawnCalls: Array<{ env: Record<string, string> }> = [];

vi.mock('node-pty', () => ({
  spawn: vi.fn((_shell: string, _args: string[], opts: { env: Record<string, string> }) => {
    spawnCalls.push({ env: opts.env });
    return { onData: vi.fn(), onExit: vi.fn(), kill: vi.fn(), write: vi.fn(), pid: 1, resize: vi.fn() };
  }),
}));
vi.mock('uuid', () => ({ v4: vi.fn(() => 'test-uuid') }));
vi.mock('electron', () => ({
  app: { getPath: () => os.tmpdir() },
  BrowserWindow: vi.fn(),
  Notification: vi.fn(),
}));
// Reached during a spawn; none of it is what these tests are about.
vi.mock('../../../electron/utils/broadcast', () => ({ broadcastToAllWindows: vi.fn() }));
vi.mock('../../../electron/utils/agents-tick', () => ({ scheduleTick: vi.fn() }));
vi.mock('../../../electron/services/agent-events', () => ({ emitAgentStatus: vi.fn() }));
vi.mock('../../../electron/services/tasmania-client', () => ({
  getTasmaniaStatus: vi.fn(async () => ({ status: 'stopped' })),
}));
vi.mock('../../../electron/utils/path-builder', () => ({ buildFullPath: vi.fn(() => '/usr/bin') }));

import { initAgentPty, agents } from '../../../electron/core/agent-manager';
import { spawnAgentPty } from '../../../electron/core/agent-pty';
import { agentForToken, tarsInstanceId } from '../../../electron/core/agent-tokens';
import type { AgentStatus } from '../../../electron/types';

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'tars-token-spawn-home-'));
const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'tars-token-spawn-cwd-'));
let realHome: string | undefined;

beforeEach(() => {
  spawnCalls.length = 0;
  agents.clear();
  // initAgentPty pre-accepts the workspace trust dialog by writing
  // ~/.claude.json, which is the real file of whoever runs the suite unless
  // HOME points elsewhere. Checked, not assumed.
  realHome = process.env.HOME;
  process.env.HOME = home;
  expect(os.homedir(), 'HOME is not redirected, and a spawn would write the real ~/.claude.json').toBe(home);
});

afterEach(() => {
  process.env.HOME = realHome;
});

function spawnWith(env: Record<string, string | undefined>) {
  spawnAgentPty({ binaryName: 'claude', shell: '/bin/bash', args: ['-l'], cwd, cols: 80, rows: 24, env });
  return spawnCalls[spawnCalls.length - 1].env;
}

describe('the instance id a hook checks before it sends the token (#11)', () => {
  // The hook sends its token only to a port that proves it knows this id
  // (hook-checks-the-instance.test.ts), so every agent process needs it, and
  // it is the same for every one this Tars starts.
  it('reaches every agent process, the same for all of them in this run', () => {
    const first = spawnWith({});
    const second = spawnWith({ TARS_INSTANCE_ID: 'forged-by-a-parent-agent' });
    expect(first.TARS_INSTANCE_ID).toMatch(/^[0-9a-f]{32}$/);
    expect(first.TARS_INSTANCE_ID).toBe(tarsInstanceId());
    expect(second.TARS_INSTANCE_ID, 'a value from the caller won over Tars\'s own').toBe(tarsInstanceId());
  });
});

describe('the token an agent process starts with', () => {
  it('reaches an agent started from the interface or restored, and names that agent', async () => {
    const agent = {
      id: 'agent-from-the-interface',
      name: 'From The Interface',
      status: 'idle',
      provider: 'claude',
      projectPath: cwd,
      skills: [],
      output: [],
      lastActivity: new Date().toISOString(),
    } as AgentStatus;

    await initAgentPty(agent, null, vi.fn(), vi.fn());

    expect(spawnCalls).toHaveLength(1);
    const env = spawnCalls[0].env;
    expect(env.CLAUDE_MGR_API_TOKEN, 'the process was started without a token of its own').toBeTruthy();
    // The pair the server checks against each other: the id the process will
    // claim, and the agent its token actually names.
    expect(env.CLAUDE_AGENT_ID).toBe('agent-from-the-interface');
    expect(agentForToken(env.CLAUDE_MGR_API_TOKEN)).toBe('agent-from-the-interface');
  });

  it('is replaced when the agent is spawned again, and the one it replaced stops working', () => {
    const first = spawnWith({ CLAUDE_AGENT_ID: 'agent-respawned' }).CLAUDE_MGR_API_TOKEN;
    const second = spawnWith({ CLAUDE_AGENT_ID: 'agent-respawned' }).CLAUDE_MGR_API_TOKEN;

    expect(second).not.toBe(first);
    expect(agentForToken(first)).toBeUndefined();
    expect(agentForToken(second)).toBe('agent-respawned');
  });

  it('is its own even when the environment it inherits already holds one', () => {
    // An agent that starts another agent passes its environment down, token
    // included, and so does a Tars launched from inside an agent's terminal.
    // Inherited, the parent's token would make the child the parent.
    const env = spawnWith({ CLAUDE_AGENT_ID: 'agent-child', CLAUDE_MGR_API_TOKEN: 'the-parent-token' });

    expect(env.CLAUDE_MGR_API_TOKEN).not.toBe('the-parent-token');
    expect(agentForToken(env.CLAUDE_MGR_API_TOKEN)).toBe('agent-child');
  });

  it('is given to no process that runs no agent', () => {
    const env = spawnWith({ PATH: '/usr/bin' });

    expect(env.CLAUDE_MGR_API_TOKEN).toBeUndefined();
  });
});
